// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import {
  HISTORY_MIN_VERSIONS,
  openwrtFirewall,
  parseHostSettings,
  parseUciGet,
  type HistoryAuthor,
  type Platform,
  type UciConfig,
  type UciHistoryDetail,
  type UciHistoryState,
  type UciHistoryVersion,
  type UciPlanView,
} from '@hopdeck/core';
import type { DeployTarget } from '../firewall/deploy.ts';
import { PRUNE, settingsFile, sshdVerdict } from '../firewall/history.ts';
import { HostError } from '../hosts/errors.ts';
import { runAsRoot } from '../hosts/privilege.ts';
import { removeTemporaries, sha256, userTemporaries, VERIFIED_COPY } from '../hosts/staging.ts';
import { readConfig } from './uci-plans.ts';

/** Everything the history of a router needs: the deployment target and the account hopdeck logs in as. */
export type UciHistoryTarget = DeployTarget & { login: string };

interface HostRecord {
  /** The newest version's hash; null before the first; undefined until read. */
  latest?: string | null;
  queue: Promise<unknown>;
  /** What sshd or dropbear logged about each SSH connection, by SSH_CONNECTION. */
  logins: Map<string, { method?: string; key?: string }>;
}

/** The firewall as it is now: its file, as ubus reads it, its hash, and hopdeck's include files it points to. */
interface Snapshot {
  text: string;
  config: UciConfig;
  hash: string;
  includes: { path: string; content: string }[];
}

export function uciHistoryDirectory(platform: Platform): string {
  return `${platform.stateDir}/firewall/uci-history`;
}

/**
 * The history of a router's firewall configuration, kept on the router as
 * the nftables history is on other hosts: a directory per version with the
 * file, its JSON as ubus reads it, hopdeck's include files it pointed to,
 * and a meta.json, written last. Versions are taken before hopdeck's first
 * change (baseline), after each kept change, and whenever hopdeck notices
 * the file changed by something else, LuCI or the uci command (outside).
 */
export class UciHistory {
  readonly #operator: { user: string; computer: string };
  readonly #busy: (hostId: string) => boolean;
  readonly #hosts = new Map<string, HostRecord>();

  constructor(options: { operator: { user: string; computer: string }; busy?: (hostId: string) => boolean }) {
    this.#operator = options.operator;
    this.#busy = options.busy ?? (() => false);
  }

  /** Forgets what was read of a host, e.g. after reconnecting. */
  reset(hostId: string): void {
    this.#hosts.delete(hostId);
  }

  /**
   * Before a change: the configuration as hopdeck first finds it, if there
   * is no history yet, or as something else left it, if it differs from the
   * newest version.
   */
  async beforeChange(target: UciHistoryTarget): Promise<void> {
    const host = this.#host(target.hostId);
    await this.#serial(host, async () => {
      await this.#load(target, host);
      const snapshot = await readSnapshot(target);
      if (host.latest === null) await this.#write(target, host, { kind: 'baseline', changes: [] }, snapshot);
      else if (host.latest !== snapshot.hash) await this.#write(target, host, { kind: 'outside', changes: [] }, snapshot);
    });
  }

  /** When the panel reads the configuration: a change made elsewhere, if there is a history and hopdeck is not changing the router itself. */
  async observe(target: UciHistoryTarget, hash: string): Promise<void> {
    if (this.#busy(target.hostId)) return;
    const host = this.#host(target.hostId);
    await this.#serial(host, async () => {
      await this.#load(target, host);
      if (host.latest === null || host.latest === hash) return;
      await this.#write(target, host, { kind: 'outside', changes: [] }, await readSnapshot(target));
    });
  }

  /** After a kept change: the configuration with it. */
  async record(target: UciHistoryTarget, view: UciPlanView): Promise<NonNullable<UciPlanView['recorded']>> {
    const host = this.#host(target.hostId);
    try {
      const id = await this.#serial(host, async () => {
        await this.#load(target, host);
        return this.#write(target, host, { kind: 'change', changes: view.staged, plan: view.id, ...(view.restoredFrom !== undefined && { restoredFrom: view.restoredFrom }) }, await readSnapshot(target));
      });
      return { version: id };
    } catch (error) {
      return { problem: error instanceof HostError ? { code: error.code, detail: error.detail } : { code: 'unknown', detail: error instanceof Error ? error.message : String(error) } };
    }
  }

  async state(target: UciHistoryTarget): Promise<UciHistoryState> {
    const directory = uciHistoryDirectory(target.platform);
    const script = [
      'h=$1',
      '[ -d "$h" ] || exit 0',
      `printf 'size\\0'; du -sk "$h" | cut -f1; printf '\\0'`,
      `for n in $(ls "$h" | grep -E '^[0-9]+$' | sort -rn); do [ -f "$h/$n/meta.json" ] || continue; printf '%s\\0' "$n"; cat "$h/$n/meta.json"; printf '\\0'; done`,
    ].join('\n');
    const read = await runAsRoot(target.access, ['sh', '-c', script, 'sh', directory]);
    if (read.exitCode !== 0) throw new HostError('command-failed', read.stderr.trim() || `reading the history failed with code ${read.exitCode}`);
    const parts = pairs(read.stdout);
    const versions = [...parts].flatMap(([name, text]) => (/^\d+$/.test(name) ? (parseMeta(Number(name), text) ?? []) : []));
    return { directory, size: Number(parts.get('size') ?? 0) * 1024, versions };
  }

  async version(target: UciHistoryTarget, id: number): Promise<UciHistoryDetail | undefined> {
    const directory = `${uciHistoryDirectory(target.platform)}/${String(id).padStart(6, '0')}`;
    const script = `d=$1; [ -f "$d/meta.json" ] || exit 3; for f in "$d"/*; do [ -f "$f" ] || continue; printf '%s\\0' "\${f##*/}"; cat "$f"; printf '\\0'; done`;
    const read = await runAsRoot(target.access, ['sh', '-c', script, 'sh', directory]);
    if (read.exitCode === 3) return undefined;
    if (read.exitCode !== 0) throw new HostError('command-failed', read.stderr.trim() || `reading the version failed with code ${read.exitCode}`);
    const files = pairs(read.stdout);
    const version = parseMeta(id, files.get('meta.json') ?? '');
    if (version === undefined) return undefined;
    const config = parseUciGet('firewall', files.get('firewall.json') ?? '');
    const includes = version.includes.map((path) => ({ path, content: files.get(includeFile(path)) ?? '' }));
    return { version, text: files.get('firewall') ?? '', config, includes };
  }

  #host(hostId: string): HostRecord {
    let host = this.#hosts.get(hostId);
    if (host === undefined) {
      host = { queue: Promise.resolve(), logins: new Map() };
      this.#hosts.set(hostId, host);
    }
    return host;
  }

  #serial<T>(host: HostRecord, task: () => Promise<T>): Promise<T> {
    const run = host.queue.then(task, task);
    host.queue = run.catch(() => undefined);
    return run;
  }

  /** Reads the newest version's hash, once per host. */
  async #load(target: UciHistoryTarget, host: HostRecord): Promise<void> {
    if (host.latest !== undefined) return;
    const script = `h=$1; [ -d "$h" ] || exit 0; for n in $(ls "$h" | grep -E '^[0-9]+$' | sort -rn); do [ -f "$h/$n/meta.json" ] && { cat "$h/$n/meta.json"; exit 0; }; done`;
    const read = await runAsRoot(target.access, ['sh', '-c', script, 'sh', uciHistoryDirectory(target.platform)]);
    if (read.exitCode !== 0) throw new HostError('command-failed', read.stderr.trim() || `reading the history failed with code ${read.exitCode}`);
    host.latest = read.stdout.trim() === '' ? null : (parseMeta(0, read.stdout)?.hash ?? null);
  }

  async #write(target: UciHistoryTarget, host: HostRecord, version: Pick<UciHistoryVersion, 'kind' | 'changes' | 'plan' | 'restoredFrom'>, snapshot: Snapshot): Promise<number> {
    const meta: Omit<UciHistoryVersion, 'id'> & { format: number } = {
      format: 1,
      time: new Date().toISOString(),
      author: await this.#author(target, host),
      hash: snapshot.hash,
      includes: snapshot.includes.map((include) => include.path),
      ...version,
    };
    const files = [
      { name: 'firewall', content: snapshot.text },
      { name: 'firewall.json', content: `${JSON.stringify({ values: Object.fromEntries(snapshot.config.sections.map(sectionJson)) }, null, 2)}\n` },
      ...snapshot.includes.map((include) => ({ name: includeFile(include.path), content: include.content })),
      // meta.json last: a version without it is incomplete and not shown.
      { name: 'meta.json', content: `${JSON.stringify(meta, null, 2)}\n` },
    ];
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
      'while [ $# -gt 0 ]; do copy "$1" "$2" "$d/$3" || { rm -rf "$d"; exit 1; }; shift 3; done',
      'prune "$h" "$max" "$min"',
      'echo "$n"',
    ].join('\n');
    try {
      const settings = await runAsRoot(target.access, ['cat', settingsFile(target.platform)]);
      const maxBytes = parseHostSettings(settings.exitCode === 0 ? settings.stdout : undefined).history.maxBytes;
      const args = files.flatMap((file, index) => [sources[index]!, sha256(file.content), file.name]);
      const written = await runAsRoot(target.access, ['sh', '-c', script, 'sh', uciHistoryDirectory(target.platform), String(maxBytes), String(HISTORY_MIN_VERSIONS), ...args]);
      if (written.exitCode !== 0) throw new HostError('command-failed', written.stderr.trim() || `writing the version failed with code ${written.exitCode}`);
      host.latest = snapshot.hash;
      return Number(written.stdout.trim());
    } finally {
      await removeTemporaries(target, sources).catch(() => undefined);
    }
  }

  /** The panel's user and computer, and what the router saw of the SSH connection. */
  async #author(target: UciHistoryTarget, host: HostRecord): Promise<HistoryAuthor> {
    const author: HistoryAuthor = { ...this.#operator, login: target.login };
    if (target.kind !== 'ssh') return author;
    const session = (await target.executor.exec(['sh', '-c', 'printf "%s" "$SSH_CONNECTION"'])).stdout.trim();
    const [address, port] = session.split(/\s+/);
    if (address === undefined || port === undefined || !/^\d+$/.test(port)) return author;
    let login = host.logins.get(session);
    if (login === undefined) {
      login = await sshdVerdict(address, port, (argv) => runAsRoot(target.access, argv));
      host.logins.set(session, login);
    }
    return { ...author, connection: { address, port: Number(port), ...login } };
  }
}

/** The firewall now: the file, the configuration as ubus reads it, and hopdeck's include files it points to. */
async function readSnapshot(target: UciHistoryTarget): Promise<Snapshot> {
  const file = await runAsRoot(target.access, ['cat', '/etc/config/firewall']);
  if (file.exitCode !== 0) throw new HostError('command-failed', `reading /etc/config/firewall: ${file.stderr.trim()}`);
  const config = await readConfig(target, 'firewall', undefined);
  const includes: Snapshot['includes'] = [];
  for (const include of openwrtFirewall(config).includes) {
    if (!include.managed || include.path === undefined) continue;
    const read = await runAsRoot(target.access, ['cat', include.path]);
    if (read.exitCode === 0) includes.push({ path: include.path, content: read.stdout });
  }
  return { text: file.stdout, config, hash: sha256(file.stdout), includes };
}

/** An include file's name in a version's directory. */
function includeFile(path: string): string {
  return `include-${path.slice(path.lastIndexOf('/') + 1)}`;
}

/** A section as `ubus call uci get` prints it, for parseUciGet() to read back. */
function sectionJson(section: UciConfig['sections'][number]): [string, Record<string, unknown>] {
  return [section.name, { '.anonymous': section.anonymous, '.type': section.type, '.name': section.name, '.index': section.index, ...section.options }];
}

function pairs(output: string): Map<string, string> {
  const parts = output.split('\0');
  const map = new Map<string, string>();
  for (let index = 0; index + 1 < parts.length; index += 2) map.set(parts[index]!, parts[index + 1]!);
  return map;
}

function parseMeta(id: number, text: string): UciHistoryVersion | undefined {
  try {
    const meta = JSON.parse(text) as Omit<UciHistoryVersion, 'id'> & { format?: number };
    if (typeof meta.time !== 'string' || typeof meta.hash !== 'string' || !Array.isArray(meta.changes) || typeof meta.author !== 'object') return undefined;
    const { format: _format, ...version } = meta;
    return { id, ...version, includes: Array.isArray(version.includes) ? version.includes : [] };
  } catch {
    return undefined;
  }
}
