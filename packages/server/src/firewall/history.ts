// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import {
  historyFingerprints,
  isManaged,
  normalizedTable,
  parseHostSettings,
  parseListing,
  parseRuleset,
  sameTables,
  tableFileName,
  tableKey,
  tableText,
  validMaxBytes,
  withTableComments,
  HISTORY_MIN_VERSIONS,
  type DeploymentView,
  type Executor,
  type HistoryAuthor,
  type HistoryState,
  type HistoryTable,
  type HistoryVersion,
  type HistoryVersionDetail,
  type HostErrorCode,
  type HostKind,
  type HostSettings,
  type Platform,
} from '@hopdeck/core';
import { HostError } from '../hosts/errors.ts';
import { journal } from '../hosts/journal.ts';
import { runAsRoot, runNft, type NftAccess } from '../hosts/privilege.ts';
import { removeTemporaries, sha256, userTemporaries, VERIFIED_COPY } from '../hosts/staging.ts';

/** Everything the history of one host needs; HostManager builds it. */
export interface HistoryTarget {
  hostId: string;
  kind: HostKind;
  executor: Executor;
  access: NftAccess;
  platform: Platform;
  /** The account hopdeck logs in as. */
  login: string;
}

export interface HistoryOptions {
  /** Who runs hopdeck, and where: the panel's part of every author. */
  operator: { user: string; computer: string };
  /** Whether hopdeck itself is changing the host just now, so a difference is no outside change. */
  busy?: (hostId: string) => boolean;
}

export function historyDirectory(host: Platform): string {
  return `${host.stateDir}/firewall/history`;
}

export function settingsFile(host: Platform): string {
  return `${host.configDir}/settings.json`;
}

type Problem = { code: HostErrorCode; detail: string };

interface HostRecord {
  /** Fingerprints of the newest version; null before the first one; undefined until read. */
  latest?: Record<string, string> | null;
  /** The managed tables as last read from nft's text, by tableKey(); see historyFingerprints(). */
  managed?: ReadonlySet<string>;
  settings?: HostSettings;
  /** One read or write at a time per host. */
  queue: Promise<unknown>;
  failure?: HistoryState['failure'];
  /** Why no history can be kept here; asked again after reconnecting. */
  unavailable?: Problem;
  /** What sshd logged about each SSH connection, by SSH_CONNECTION. */
  logins: Map<string, { method?: string; key?: string }>;
}

/** What a version is written with, but its id: the directory name, given when it is written. */
type NewVersion = Omit<HistoryVersion, 'id' | 'tables'>;

interface Snapshot {
  fingerprints: Record<string, string>;
  tables: (HistoryTable & { text: string })[];
  managed: ReadonlySet<string>;
}

/**
 * The history of the managed tables on each host, kept on the host itself so
 * every admin sees the same one. A version is a directory of .nft files and a
 * meta.json, all root's; see docs/ARCHITECTURE.md, "History".
 */
export class History {
  readonly #operator: HistoryOptions['operator'];
  readonly #busy: HistoryOptions['busy'];
  readonly #hosts = new Map<string, HostRecord>();

  constructor(options: HistoryOptions) {
    this.#operator = options.operator;
    this.#busy = options.busy;
  }

  /** Forgets what is known about a host, e.g. after reconnecting with other privileges. */
  reset(hostId: string): void {
    this.#hosts.delete(hostId);
  }

  /**
   * Records the managed tables when they differ from the newest version: the
   * first time as a baseline, later as a change made outside hopdeck. `json` is
   * `nft -j list ruleset` from a look hopdeck took anyway. Never throws; a
   * failure shows in state().
   */
  async observe(target: HistoryTarget, json: unknown): Promise<void> {
    const host = this.#host(target.hostId);
    if (this.#busy?.(target.hostId) || this.#unavailable(target, host) !== undefined) return;
    await this.#serial(host, async () => {
      await this.#load(target, host);
      // Which tables are managed is known from text only, so the first look reads it.
      host.managed ??= (await readSnapshot(target.access)).managed;
      if (this.#unchanged(host, historyFingerprints(json, host.managed))) return;
      // Read again, both forms at once, and make sure hopdeck did not start a change meanwhile.
      const snapshot = await readSnapshot(target.access);
      host.managed = snapshot.managed;
      if (this.#unchanged(host, snapshot.fingerprints) || this.#busy?.(target.hostId)) return;
      // Another admin's hopdeck may have recorded this state already.
      await this.#load(target, host, true);
      if (this.#unchanged(host, snapshot.fingerprints)) return;
      const kind = host.latest === null ? 'baseline' : 'outside';
      const author = await this.#author(target, host);
      const id = await this.#write(target, host, { time: new Date().toISOString(), kind, author, changes: [] }, snapshot);
      const tables = snapshot.tables.map((table) => `${table.family} ${table.name}`).join(', ') || 'none';
      await this.#journal(
        target,
        kind === 'baseline'
          ? `history version ${id}: history started; managed tables: ${tables}; noticed by ${describe(author)}`
          : `history version ${id}: managed tables changed outside hopdeck; now: ${tables}; noticed by ${describe(author)}`,
      );
    }).catch((error: unknown) => {
      // A host where root is out of reach keeps no history; state() says why.
      if (host.unavailable === undefined) this.#failed(host, error);
    });
  }

  /** Records a kept change. Returns the new version, or why there is none; never throws. */
  async record(target: HistoryTarget, view: DeploymentView): Promise<NonNullable<DeploymentView['recorded']>> {
    const host = this.#host(target.hostId);
    const unavailable = this.#unavailable(target, host);
    if (unavailable !== undefined) return { problem: unavailable };
    return this.#serial(host, async () => {
      await this.#load(target, host);
      const snapshot = await readSnapshot(target.access);
      host.managed = snapshot.managed;
      const author = await this.#author(target, host);
      const version: NewVersion = {
        time: new Date().toISOString(),
        kind: 'change',
        author,
        deployment: view.id,
        manualOverride: view.manualOverride,
        ...(view.restoredFrom !== undefined && { restoredFrom: view.restoredFrom }),
        changes: view.tables.map((table) => ({
          family: table.family,
          name: table.name,
          action: table.action,
          ...(table.set !== undefined && { set: table.set.name }),
        })),
      };
      const id = await this.#write(target, host, version, snapshot);
      const what = version.changes.map((change) => `${change.action} ${change.family} ${change.name}${change.set ? ` ${change.set}` : ''}`).join(', ');
      const restored = view.restoredFrom === undefined ? '' : ` (restores version ${view.restoredFrom})`;
      await this.#journal(target, `history version ${id}: ${what}${restored} by ${describe(author)}; deployment ${view.id}`);
      return { version: id };
    }).catch((error: unknown) => ({ problem: host.unavailable ?? this.#failed(host, error) }));
  }

  /** Every version, newest first, with the settings and the space they take. */
  async state(target: HistoryTarget): Promise<HistoryState> {
    const host = this.#host(target.hostId);
    const directory = historyDirectory(target.platform);
    const base = {
      directory,
      size: 0,
      settings: parseHostSettings(undefined),
      settingsFile: settingsFile(target.platform),
      versions: [],
      ...(host.failure && { failure: host.failure }),
    };
    const unavailable = this.#unavailable(target, host);
    if (unavailable !== undefined) return { ...base, problem: unavailable };
    try {
      return await this.#serial(host, async () => {
        const script = [
          'h=$1',
          `printf 'settings\\0'; cat "$2" 2>/dev/null; printf '\\0'`,
          `printf 'size\\0'; if [ -d "$h" ]; then du -sk "$h" | cut -f1; else echo 0; fi; printf '\\0'`,
          '[ -d "$h" ] || exit 0',
          `for d in "$h"/*; do n=\${d##*/}; case "$n" in ''|*[!0-9]*) continue ;; esac; [ -f "$d/meta.json" ] || continue; printf '%s\\0' "$n"; cat "$d/meta.json"; printf '\\0'; done`,
        ].join('\n');
        const read = await this.#root(target, host, ['sh', '-c', script, 'sh', directory, settingsFile(target.platform)]);
        const parts = pairs(read.stdout);
        const settings = parseHostSettings(parts.get('settings'));
        host.settings = settings;
        const versions: HistoryVersion[] = [];
        const unreadable: number[] = [];
        for (const [name, text] of parts) {
          if (!/^\d+$/.test(name)) continue;
          const version = parseMeta(Number(name), text);
          if (version === undefined) unreadable.push(Number(name));
          else versions.push(version);
        }
        versions.sort((a, b) => b.id - a.id);
        host.latest = versions[0] === undefined ? null : fingerprintsOf(versions[0]);
        return {
          ...base,
          size: Number(parts.get('size')?.trim() ?? 0) * 1024,
          settings,
          versions,
          ...(unreadable.length > 0 && { unreadable: unreadable.sort((a, b) => b - a) }),
        };
      });
    } catch (error) {
      if (error instanceof HostError && host.unavailable !== undefined) return { ...base, problem: host.unavailable };
      throw error;
    }
  }

  /** A version with its tables; undefined when there is no such version. */
  async version(target: HistoryTarget, id: number): Promise<HistoryVersionDetail | undefined> {
    const host = this.#host(target.hostId);
    const unavailable = this.#unavailable(target, host);
    if (unavailable !== undefined) throw new HostError(unavailable.code, unavailable.detail);
    return this.#serial(host, async () => {
      const script = [
        `d="$1/$(printf '%06d' "$2")"`,
        '[ -f "$d/meta.json" ] || exit 3',
        `for f in "$d"/*; do printf '%s\\0' "\${f##*/}"; cat "$f"; printf '\\0'; done`,
      ].join('\n');
      const read = await this.#root(target, host, ['sh', '-c', script, 'sh', historyDirectory(target.platform), String(id)]);
      if (read.exitCode === 3) return undefined;
      if (read.exitCode !== 0) throw new HostError('command-failed', read.stderr.trim() || `reading version ${id} failed with code ${read.exitCode}`);
      const files = pairs(read.stdout);
      const version = parseMeta(id, files.get('meta.json') ?? '');
      if (version === undefined) throw new HostError('command-failed', `the description of version ${id} (meta.json) cannot be read`);
      return {
        version,
        tables: version.tables.map((table) => ({ family: table.family, name: table.name, text: files.get(table.file) ?? '' })),
      };
    });
  }

  /** Saves the settings on the host and applies the history limit at once. */
  async saveSettings(target: HistoryTarget, settings: HostSettings): Promise<HistoryState> {
    if (!validMaxBytes(settings.history.maxBytes)) throw new HostError('invalid-definition', `the history limit is out of range: ${settings.history.maxBytes}`);
    const host = this.#host(target.hostId);
    const unavailable = this.#unavailable(target, host);
    if (unavailable !== undefined) throw new HostError(unavailable.code, unavailable.detail);
    await this.#serial(host, async () => {
      const content = `${JSON.stringify({ version: 1, history: { maxBytes: settings.history.maxBytes } }, null, 2)}\n`;
      const [source] = await userTemporaries(target, [content]);
      const script = [
        VERIFIED_COPY,
        PRUNE,
        'set -e',
        'umask 077',
        'mkdir -p "$(dirname "$2")"',
        'copy "$1" "$3" "$2"',
        '[ ! -d "$4" ] || prune "$4" "$5" "$6"',
      ].join('\n');
      const saved = await this.#root(target, host, [
        'sh',
        '-c',
        script,
        'sh',
        source!,
        settingsFile(target.platform),
        sha256(content),
        historyDirectory(target.platform),
        String(settings.history.maxBytes),
        String(HISTORY_MIN_VERSIONS),
      ]);
      await removeTemporaries(target, [source!]);
      if (saved.exitCode !== 0) throw new HostError('command-failed', saved.stderr.trim() || `saving the settings failed with code ${saved.exitCode}`);
      host.settings = settings;
    });
    return this.state(target);
  }

  #host(hostId: string): HostRecord {
    let host = this.#hosts.get(hostId);
    if (host === undefined) {
      host = { queue: Promise.resolve(), logins: new Map() };
      this.#hosts.set(hostId, host);
    }
    return host;
  }

  #unavailable(target: HistoryTarget, host: HostRecord): Problem | undefined {
    if (target.platform.firewall === 'read-only') {
      return { code: 'platform-read-only', detail: 'hopdeck changes nothing in the firewall of this host, so it keeps no history of it' };
    }
    return host.unavailable;
  }

  #serial<T>(host: HostRecord, task: () => Promise<T>): Promise<T> {
    const run = host.queue.then(task, task);
    host.queue = run.catch(() => undefined);
    return run;
  }

  /** Runs a command as root; privileges that cannot do so mark the host as keeping no history. */
  async #root(target: HistoryTarget, host: HostRecord, argv: string[]) {
    try {
      return await runAsRoot(target.access, argv);
    } catch (error) {
      if (error instanceof HostError && (error.code === 'sudo-not-allowed' || error.code === 'no-privileges')) {
        host.unavailable = { code: error.code, detail: `the history is kept as root, which is not possible here: ${error.detail}` };
      }
      throw error;
    }
  }

  /** Reads the settings and the newest version's fingerprints, once per host unless `again`. */
  async #load(target: HistoryTarget, host: HostRecord, again = false): Promise<void> {
    if (!again && host.latest !== undefined && host.settings !== undefined) return;
    const script = [
      'h=$1',
      `printf 'settings\\0'; cat "$2" 2>/dev/null; printf '\\0'`,
      '[ -d "$h" ] || exit 0',
      `for n in $(ls "$h" | grep -E '^[0-9]+$' | sort -rn); do [ -f "$h/$n/meta.json" ] || continue; printf '%s\\0' "$n"; cat "$h/$n/meta.json"; printf '\\0'; break; done`,
    ].join('\n');
    const read = await this.#root(target, host, ['sh', '-c', script, 'sh', historyDirectory(target.platform), settingsFile(target.platform)]);
    if (read.exitCode !== 0) throw new HostError('command-failed', read.stderr.trim() || `reading the history failed with code ${read.exitCode}`);
    const parts = pairs(read.stdout);
    host.settings = parseHostSettings(parts.get('settings'));
    const newest = [...parts].find(([name]) => /^\d+$/.test(name));
    const version = newest && parseMeta(Number(newest[0]), newest[1]);
    host.latest = version === undefined ? null : fingerprintsOf(version);
    if (version !== undefined) host.managed ??= new Set(Object.keys(host.latest!));
  }

  #unchanged(host: HostRecord, fingerprints: Record<string, string>): boolean {
    // Hosts without managed tables start no history by being looked at.
    return host.latest === null ? Object.keys(fingerprints).length === 0 : sameTables(host.latest!, fingerprints);
  }

  /** Writes a version, then drops the oldest ones beyond the limit. Returns its id. */
  async #write(target: HistoryTarget, host: HostRecord, version: NewVersion, snapshot: Snapshot): Promise<number> {
    const tables: HistoryTable[] = snapshot.tables.map(({ text: _text, ...table }) => table);
    const meta = `${JSON.stringify({ format: 1, ...version, tables }, null, 2)}\n`;
    const files = [...snapshot.tables.map((table) => ({ name: table.file, content: table.text })), { name: 'meta.json', content: meta }];
    const sources = await userTemporaries(target, files.map((file) => file.content));
    const script = [
      VERIFIED_COPY,
      PRUNE,
      'set -e',
      'umask 077',
      'h=$1 max=$2 min=$3',
      'shift 3',
      'mkdir -p "$h"',
      'chmod 700 "$h"',
      `last=$(ls "$h" | grep -E '^[0-9]+$' | sort -n | tail -n 1)`,
      `n=$(( $(echo "\${last:-0}" | sed 's/^0*//; s/^$/0/') + 1 ))`,
      `while ! mkdir "$h/$(printf '%06d' "$n")" 2>/dev/null; do n=$((n + 1)); done`,
      `d="$h/$(printf '%06d' "$n")"`,
      // meta.json comes last: a version without it is incomplete and not shown.
      'while [ $# -gt 0 ]; do copy "$1" "$2" "$d/$3" || { rm -rf "$d"; exit 1; }; shift 3; done',
      'prune "$h" "$max" "$min"',
      'echo "$n"',
    ].join('\n');
    const maxBytes = host.settings?.history.maxBytes ?? parseHostSettings(undefined).history.maxBytes;
    const args = files.flatMap((file, index) => [sources[index]!, sha256(file.content), file.name]);
    try {
      const written = await this.#root(target, host, [
        'sh',
        '-c',
        script,
        'sh',
        historyDirectory(target.platform),
        String(maxBytes),
        String(HISTORY_MIN_VERSIONS),
        ...args,
      ]);
      if (written.exitCode !== 0) throw new HostError('command-failed', written.stderr.trim() || `writing the version failed with code ${written.exitCode}`);
      host.latest = snapshot.fingerprints;
      delete host.failure;
      return Number(written.stdout.trim());
    } finally {
      await removeTemporaries(target, sources).catch(() => undefined);
    }
  }

  /** The panel's user and computer, and for SSH what the host saw of the connection. */
  async #author(target: HistoryTarget, host: HostRecord): Promise<HistoryAuthor> {
    const author: HistoryAuthor = { ...this.#operator, login: target.login };
    if (target.kind !== 'ssh') return author;
    // "client-address client-port server-address server-port", as sshd set it for the session.
    const session = (await target.executor.exec(['sh', '-c', 'printf "%s" "$SSH_CONNECTION"'])).stdout.trim();
    const [address, port] = session.split(/\s+/);
    if (address === undefined || port === undefined || !/^\d+$/.test(port)) return author;
    let login = host.logins.get(session);
    if (login === undefined) {
      login = await sshdVerdict(address, port, (argv) => this.#root(target, host, argv));
      host.logins.set(session, login);
    }
    return { ...author, connection: { address, port: Number(port), ...login } };
  }

  async #journal(target: HistoryTarget, message: string): Promise<void> {
    // The sandbox shares the machine's system log, which is not its own.
    if (target.kind !== 'sandbox') await journal(target.executor, message);
  }

  #failed(host: HostRecord, error: unknown): Problem | { code: 'unknown'; detail: string } {
    const problem = error instanceof HostError ? { code: error.code, detail: error.detail || error.code } : { code: 'unknown' as const, detail: error instanceof Error ? error.message : String(error) };
    host.failure = { time: new Date().toISOString(), ...problem };
    return problem;
  }
}

/**
 * Shell function for root: `prune DIRECTORY MAX-BYTES MIN-VERSIONS` removes the
 * oldest versions while the history takes more than the limit, keeping at
 * least the minimum.
 */
export const PRUNE = `prune() {
	while :; do
		count=$(ls "$1" | grep -cE '^[0-9]+$' || true)
		[ "$count" -gt "$3" ] || return 0
		size=$(du -sk "$1" | cut -f1)
		[ "$((size * 1024))" -gt "$2" ] || return 0
		oldest=$(ls "$1" | grep -E '^[0-9]+$' | sort -n | head -n 1)
		[ -n "$oldest" ] || return 0
		rm -rf "$1/$oldest"
	done
}`;

/** The managed tables now, read once as JSON and once as text. */
async function readSnapshot(access: NftAccess): Promise<Snapshot> {
  const json = await runNft(access, ['-j', 'list', 'ruleset']);
  if (json.exitCode !== 0) throw new HostError('command-failed', json.stderr.trim() || `nft exited with code ${json.exitCode}`);
  const listing = await runNft(access, ['list', 'ruleset']);
  if (listing.exitCode !== 0) throw new HostError('command-failed', listing.stderr.trim() || `nft exited with code ${listing.exitCode}`);
  const parsed: unknown = JSON.parse(json.stdout);
  // The managed marker is the table's comment, which older nft prints only as text.
  const ruleset = withTableComments(parseRuleset(parsed), parseListing(listing.stdout));
  const managed = new Set(ruleset.tables.filter((node) => isManaged(node.table)).map((node) => tableKey(node.table.family, node.table.name)));
  const fingerprints = historyFingerprints(parsed, managed);
  const tables: Snapshot['tables'] = [];
  for (const { table } of ruleset.tables.filter((node) => isManaged(node.table))) {
    const text = tableText(listing.stdout, table.family, table.name);
    const fingerprint = fingerprints[tableKey(table.family, table.name)];
    // Gone between the two reads; the next look records it.
    if (text === undefined || fingerprint === undefined) continue;
    tables.push({ family: table.family, name: table.name, file: tableFileName(table.family, table.name), fingerprint, text: normalizedTable(text) });
  }
  return { fingerprints: Object.fromEntries(tables.map((table) => [tableKey(table.family, table.name), table.fingerprint])), tables, managed };
}

/**
 * How sshd let a connection in, from its log line for that address and port:
 * "Accepted publickey for root from 10.0.0.5 port 51234 ssh2: ED25519 SHA256:…".
 * Newest first, so a port used again later matches its latest connection.
 */
async function sshdVerdict(
  address: string,
  port: string,
  root: (argv: string[]) => Promise<{ exitCode: number; stdout: string }>,
): Promise<{ method?: string; key?: string }> {
  const script = [
    'p=" from $1 port $2 "',
    `line=$(journalctl -q --no-pager -o cat -r -t sshd -t sshd-session 2>/dev/null | grep -F -- "$p" | grep -m 1 'Accepted ' || true)`,
    // Without journald: Debian's and RHEL's syslog files, and BusyBox syslogd's (Alpine).
    `[ -n "$line" ] || for f in /var/log/auth.log /var/log/secure /var/log/messages; do [ -r "$f" ] && line=$(grep -F -- "$p" "$f" | grep 'Accepted ' | tail -n 1); [ -z "$line" ] || break; done`,
    'printf "%s" "$line"',
  ].join('\n');
  const found = await root(['sh', '-c', script, 'sh', address, port]).catch(() => undefined);
  if (found === undefined) return {};
  const match = /Accepted (\S+) for \S+ from \S+ port \d+ [^\s:]+(?::\s+(\S+) (\S+))?/.exec(found.stdout);
  if (match === null) return {};
  return { method: match[1]!, ...(match[2] !== undefined && match[3] !== undefined && { key: `${match[2]} ${match[3]}` }) };
}

/** NUL-separated name and content pairs, as the scripts above print them. */
function pairs(output: string): Map<string, string> {
  const parts = output.split('\0');
  const map = new Map<string, string>();
  for (let index = 0; index + 1 < parts.length; index += 2) map.set(parts[index]!, parts[index + 1]!);
  return map;
}

function parseMeta(id: number, text: string): HistoryVersion | undefined {
  try {
    const meta = JSON.parse(text) as Omit<HistoryVersion, 'id'> & { format?: number };
    if (typeof meta.time !== 'string' || !Array.isArray(meta.tables) || !Array.isArray(meta.changes) || typeof meta.author !== 'object') return undefined;
    const { format: _format, ...version } = meta;
    return { id, ...version };
  } catch {
    return undefined;
  }
}

function fingerprintsOf(version: HistoryVersion): Record<string, string> {
  return Object.fromEntries(version.tables.map((table) => [tableKey(table.family, table.name), table.fingerprint]));
}

/** For the system log, e.g. "tenir@laptop (as root from 10.0.0.5 port 51234, publickey ED25519 SHA256:…)". */
function describe(author: HistoryAuthor): string {
  const { connection } = author;
  const from = connection === undefined ? '' : ` from ${connection.address} port ${connection.port}`;
  const how = connection?.method === undefined ? '' : `, ${connection.method}${connection.key === undefined ? '' : ` ${connection.key}`}`;
  return `${author.user}@${author.computer} (as ${author.login}${from}${how})`;
}
