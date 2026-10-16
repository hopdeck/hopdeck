// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import {
  isManaged,
  normalizedTable,
  parseListing,
  parseRuleset,
  platform,
  replaceTableScript,
  tableFileName,
  tableText,
  withTableComments,
  type Executor,
  type Family,
  type HostFacts,
  type HostKind,
  type PersistedTable,
  type PersistenceStatus,
  type PersistResult,
  type Platform,
} from '@hopdeck/core';
import { comparable, firewallReadOnly, readTable } from './deploy.ts';
import { copyAsRoot, removeTemporaries, sha256, userTemporaries, VERIFIED_COPY } from '../hosts/staging.ts';
import { HostError } from '../hosts/errors.ts';
import { runAsRoot, runNft, type NftAccess } from '../hosts/privilege.ts';

/** Where the tables that load at boot go, one file each. */
export function bootDirectory(host: Platform): string {
  return `${host.configDir}/firewall`;
}

export function includeLine(directory: string): string {
  return `include "${directory}/*.nft"`;
}

const HEADER = `# Written by hopdeck: this table is managed there, and hopdeck rewrites this file.
# To change the table by hand for good, remove its "managed by hopdeck" comment in hopdeck first.
`;

/**
 * The note above a table the main configuration defines, while hopdeck's
 * file replaces it at boot: edits there would have no effect.
 */
export function mainConfigNote(file: string): [string, string] {
  return [`# Managed by hopdeck: ${file} replaces this table at boot,`, '# so changes to it here have no effect. Change it in hopdeck.'];
}

const NOTE_FIRST = /^\s*# Managed by hopdeck: \S+ replaces this table at boot,$/;
const NOTE_SECOND = mainConfigNote('')[1];

/**
 * The main configuration with mainConfigNote() above the definition of each
 * of `tables`, and above no other: hopdeck's notes that are no longer true
 * go. Only definitions before the include line count, as hopdeck's files,
 * loaded there, replace only those.
 */
export function withTableNotes(main: string, include: string, tables: readonly { family: Family; name: string; file: string }[]): string {
  const lines = main.split('\n');
  const end = lines.findIndex((line) => line.trim() === include);
  const out: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (NOTE_FIRST.test(line) && lines[index + 1]?.trim() === NOTE_SECOND) continue;
    if (line.trim() === NOTE_SECOND && NOTE_FIRST.test(lines[index - 1] ?? '')) continue;
    const table = end !== -1 && index < end ? tables.find(({ family, name }) => tableLine(family, name).test(line)) : undefined;
    if (table !== undefined) {
      const indent = /^\s*/.exec(line)![0];
      out.push(...mainConfigNote(table.file).map((note) => `${indent}${note}`));
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Where the main configuration lives when the service does not say. */
const KNOWN_CONFIGS = ['/etc/nftables.conf', '/etc/sysconfig/nftables.conf', '/etc/nftables.nft'];

export interface PersistTarget {
  kind: HostKind;
  executor: Executor;
  access: NftAccess;
  facts: HostFacts;
}

/** File of a table in the boot directory. */
export function tableFile(directory: string, family: Family, name: string): string {
  return `${directory}/${tableFileName(family, name)}`;
}

/**
 * The table as it should load at boot: replacing any earlier definition, with
 * counters at zero and expiring elements given their full timeout again.
 */
export function bootDefinition(family: Family, name: string, listing: string): string {
  return `${HEADER}${replaceTableScript(family, name, normalizedTable(listing))}`;
}

/** Whether saving is possible at all, and how things stand on the host. */
export async function persistenceStatus(target: PersistTarget): Promise<PersistenceStatus> {
  const unavailable = await unavailableReason(target);
  const directory = bootDirectory(platform(target.facts.platform));
  const line = includeLine(directory);
  const base = { directory, includeLine: line, tables: [] as PersistedTable[] };
  if (unavailable !== undefined) {
    return { ...base, mainConfig: undefined, source: 'none', serviceEnabled: undefined, includePresent: false, problem: unavailable };
  }

  const { mainConfig, source, serviceEnabled } = await findMainConfig(target);
  const main = mainConfig === undefined ? '' : await readAsRoot(target.access, mainConfig);
  const includePresent = main.split('\n').some((entry) => entry.trim() === line);
  const files = await readBootFiles(target.access, directory);
  const live = await managedTables(target.access);

  const tables: PersistedTable[] = [];
  for (const { family, name, text } of live) {
    const file = tableFile(directory, family, name);
    const saved = files.get(file);
    const state = saved === undefined ? 'missing' : comparable(saved) === comparable(bootDefinition(family, name, text)) ? 'saved' : 'differs';
    tables.push({ family, name, file, state, alsoInMainConfig: definesTable(main, family, name) });
    files.delete(file);
  }
  for (const file of files.keys()) {
    const identity = /^table (\S+) (.+?) \{\}$/m.exec(files.get(file)!);
    const family = (identity?.[1] ?? 'inet') as Family;
    const name = identity?.[2]?.replace(/^"(.*)"$/, '$1') ?? file;
    tables.push({ family, name, file, state: 'orphaned', alsoInMainConfig: definesTable(main, family, name) });
  }
  return { ...base, mainConfig, source, serviceEnabled, includePresent, tables };
}

/**
 * Brings the boot directory in line with the live tables after a kept change: writes
 * managed tables, removes deleted ones. Tables hopdeck does not manage (changed
 * with Manual override) are not saved; their owner decides what loads at boot.
 */
export async function persistTables(target: PersistTarget, tables: readonly { family: Family; name: string }[]): Promise<PersistResult> {
  const result: PersistResult = { written: [], removed: [], notManaged: [] };
  const unavailable = await unavailableReason(target);
  if (unavailable !== undefined) return { ...result, problem: unavailable };
  const directory = bootDirectory(platform(target.facts.platform));

  try {
    for (const { family, name } of tables) {
      const file = tableFile(directory, family, name);
      const current = await readTable(target.access, family, name);
      if (current === undefined) {
        if (await removeAsRoot(target.access, file)) result.removed.push(file);
      } else if (isManaged(current.node.table)) {
        await writeAsRoot(target, file, bootDefinition(family, name, current.text));
        result.written.push(file);
      } else {
        result.notManaged.push(`${family} ${name}`);
      }
    }
    await noteMainConfig(target);
  } catch (error) {
    const code = error instanceof HostError ? error.code : 'command-failed';
    return { ...result, problem: { code, detail: error instanceof HostError ? error.detail : String(error) } };
  }
  return result;
}

/** Saves every managed table and drops files of tables no longer managed. */
export async function saveAll(target: PersistTarget): Promise<PersistResult> {
  const status = await persistenceStatus(target);
  if (status.problem !== undefined) return { written: [], removed: [], notManaged: [], problem: status.problem };
  const result = await persistTables(target, status.tables.filter((table) => table.state !== 'orphaned'));
  for (const table of status.tables.filter((entry) => entry.state === 'orphaned')) {
    if (await removeAsRoot(target.access, table.file)) result.removed.push(table.file);
  }
  if (result.problem === undefined && status.tables.some((entry) => entry.state === 'orphaned')) {
    try {
      await noteMainConfig(target);
    } catch (error) {
      return { ...result, problem: { code: error instanceof HostError ? error.code : 'command-failed', detail: error instanceof HostError ? error.detail : String(error) } };
    }
  }
  return result;
}

/**
 * Adds the include line to the main configuration, keeping a dated copy of the
 * file. If nft then rejects the configuration, the copy is put back.
 */
export async function addInclude(target: PersistTarget): Promise<void> {
  const status = await persistenceStatus(target);
  if (status.problem !== undefined) throw new HostError(status.problem.code, status.problem.detail);
  if (status.mainConfig === undefined) {
    throw new HostError('persistence-unavailable', 'no configuration that loads nftables at boot was found on this host');
  }
  if (status.includePresent) return;

  const script = [
    'set -e',
    'main="$1"',
    'backup="$main.hopdeck-backup-$(date +%Y%m%d%H%M%S)"',
    'cp -p "$main" "$backup"',
    `printf '\\n# Added by hopdeck: the tables it manages are in %s; loaded here, they replace definitions of the same tables above.\\n%s\\n' "$2" "$3" >> "$main"`,
    'umask 077',
    'mkdir -p "$2"',
    'chmod 700 "$(dirname "$2")" "$2"',
    'echo "$backup"',
  ].join('\n');
  const added = await runAsRoot(target.access, ['sh', '-c', script, 'sh', status.mainConfig, status.directory, status.includeLine]);
  if (added.exitCode !== 0) throw new HostError('command-failed', added.stderr.trim());
  const backup = added.stdout.trim();

  const check = await runNft(target.access, ['-c', '-f', status.mainConfig]);
  if (check.exitCode !== 0) {
    await runAsRoot(target.access, ['cp', '-p', backup, status.mainConfig]);
    throw new HostError('include-rejected', `nft rejected ${status.mainConfig} with the include, so the previous file is back. nft said: ${check.stderr.trim()}`);
  }
  // Tables saved before the include came now replace their definitions above it.
  await noteMainConfig(target);
}

export async function enableService(target: PersistTarget): Promise<void> {
  const enabled = await runAsRoot(target.access, ['systemctl', 'enable', 'nftables.service']);
  if (enabled.exitCode !== 0) throw new HostError('command-failed', enabled.stderr.trim());
}

async function unavailableReason(target: PersistTarget): Promise<{ code: 'persistence-unavailable'; detail: string } | undefined> {
  if (target.kind === 'sandbox') {
    return { code: 'persistence-unavailable', detail: 'the sandbox is gone when hopdeck stops, so there is nothing to boot from' };
  }
  const readOnly = firewallReadOnly(platform(target.facts.platform));
  if (readOnly !== undefined) return { code: 'persistence-unavailable', detail: readOnly };
  try {
    const probe = await runAsRoot(target.access, ['true']);
    if (probe.exitCode !== 0) {
      return { code: 'persistence-unavailable', detail: `running a command as root failed: ${probe.stderr.trim() || `exit code ${probe.exitCode}`}` };
    }
    return undefined;
  } catch (error) {
    if (error instanceof HostError && error.code === 'sudo-not-allowed') {
      const directory = bootDirectory(platform(target.facts.platform));
      return { code: 'persistence-unavailable', detail: `sudo allows only nft here, and saving files in ${directory} needs root. ${error.detail}` };
    }
    throw error;
  }
}

/** The file the nftables service loads, from its command line; else a known path that exists. */
async function findMainConfig(target: PersistTarget): Promise<Pick<PersistenceStatus, 'mainConfig' | 'source' | 'serviceEnabled'>> {
  if (target.facts.systemd) {
    const shown = await target.executor.exec(['systemctl', 'show', '-p', 'ExecStart', '--value', 'nftables.service']);
    const path = /argv\[\]=\S*nft\s(?:.*\s)?-f\s+(\S+)/.exec(shown.stdout)?.[1];
    if (path !== undefined) {
      const state = await target.executor.exec(['systemctl', 'is-enabled', 'nftables.service']);
      return { mainConfig: path, source: 'service', serviceEnabled: state.stdout.trim() === 'enabled' };
    }
  }
  const found = await target.executor.exec(['sh', '-c', 'for f in "$@"; do [ -e "$f" ] && { echo "$f"; exit 0; }; done; exit 1', 'sh', ...KNOWN_CONFIGS]);
  const path = found.stdout.trim();
  return found.exitCode === 0 && path !== '' ? { mainConfig: path, source: 'guess', serviceEnabled: undefined } : { mainConfig: undefined, source: 'none', serviceEnabled: undefined };
}

/** Live tables that carry the hopdeck marker, with their listing. */
async function managedTables(access: NftAccess): Promise<{ family: Family; name: string; text: string }[]> {
  const json = await runNft(access, ['-j', 'list', 'ruleset']);
  if (json.exitCode !== 0) throw new HostError('command-failed', json.stderr.trim());
  const listing = await runNft(access, ['list', 'ruleset']);
  if (listing.exitCode !== 0) throw new HostError('command-failed', listing.stderr.trim());
  // The managed marker is the table's comment, which older nft prints only as text.
  const ruleset = withTableComments(parseRuleset(JSON.parse(json.stdout)), parseListing(listing.stdout));
  return ruleset.tables
    .filter((node) => isManaged(node.table))
    .flatMap(({ table }) => {
      const text = tableText(listing.stdout, table.family, table.name);
      return text === undefined ? [] : [{ family: table.family, name: table.name, text }];
    });
}

function definesTable(main: string, family: Family, name: string): boolean {
  return main.split('\n').some((line) => tableLine(family, name).test(line));
}

/** The line that opens a table's definition: "table inet filter {". */
function tableLine(family: Family, name: string): RegExp {
  const names = [name, JSON.stringify(name)].map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^\\s*table\\s+${family}\\s+(?:${names.join('|')})\\s*\\{`);
}

/**
 * Brings hopdeck's notes in the main configuration in line with what loads
 * at boot: one above each table defined there whose definition hopdeck's
 * file replaces. Without the include, hopdeck's files do not load, so it
 * notes nothing. Writes only when the notes change.
 */
async function noteMainConfig(target: PersistTarget): Promise<void> {
  const status = await persistenceStatus(target);
  if (status.problem !== undefined || status.mainConfig === undefined || !status.includePresent) return;
  const main = await readAsRoot(target.access, status.mainConfig);
  // A file there (saved, or not up to date) replaces the definition at boot; without one, the definition loads.
  const replaced = status.tables.filter((table) => table.alsoInMainConfig && (table.state === 'saved' || table.state === 'differs'));
  const noted = withTableNotes(main, status.includeLine, replaced);
  if (noted !== main) await rewriteMainConfig(target, status.mainConfig, noted);
}

/**
 * Writes the main configuration over itself, so it keeps its mode, owner
 * and SELinux label, after a dated copy; puts the copy back if nft then
 * rejects it. The content gets in as copyAsRoot() puts it.
 */
async function rewriteMainConfig(target: PersistTarget, main: string, content: string): Promise<void> {
  const [source] = await userTemporaries(target, [content]);
  const script = [
    VERIFIED_COPY,
    'set -e',
    'backup="$1.hopdeck-backup-$(date +%Y%m%d%H%M%S)"',
    'cp -p "$1" "$backup"',
    'copy "$2" "$3" "$1.hopdeck-new"',
    'cat "$1.hopdeck-new" > "$1"',
    'rm -f "$1.hopdeck-new"',
    'echo "$backup"',
  ].join('\n');
  const written = await runAsRoot(target.access, ['sh', '-c', script, 'sh', main, source!, sha256(content)]);
  await removeTemporaries(target, [source!]);
  if (written.exitCode !== 0) throw new HostError('command-failed', written.stderr.trim() || `rewriting ${main} failed with code ${written.exitCode}`);
  const backup = written.stdout.trim();
  const check = await runNft(target.access, ['-c', '-f', main]);
  if (check.exitCode !== 0) {
    await runAsRoot(target.access, ['sh', '-c', 'cat "$1" > "$2"', 'sh', backup, main]);
    throw new HostError('command-failed', `nft rejected ${main} with hopdeck's notes, so the previous file is back. nft said: ${check.stderr.trim()}`);
  }
}

async function readAsRoot(access: NftAccess, path: string): Promise<string> {
  const read = await runAsRoot(access, ['cat', path]);
  if (read.exitCode !== 0) throw new HostError('command-failed', read.stderr.trim());
  return read.stdout;
}

/** Every .nft file in the boot directory with its content. */
async function readBootFiles(access: NftAccess, directory: string): Promise<Map<string, string>> {
  const script = `for f in "$1"/*.nft; do [ -f "$f" ] || continue; printf '%s\\0' "$f"; cat "$f"; printf '\\0'; done`;
  const read = await runAsRoot(access, ['sh', '-c', script, 'sh', directory]);
  if (read.exitCode !== 0) throw new HostError('command-failed', read.stderr.trim());
  const parts = read.stdout.split('\0');
  const files = new Map<string, string>();
  for (let index = 0; index + 1 < parts.length; index += 2) files.set(parts[index]!, parts[index + 1]!);
  return files;
}

/** Writes a boot file through a copy root checks against the content's SHA-256, see copyAsRoot(). */
async function writeAsRoot(target: PersistTarget, path: string, content: string): Promise<void> {
  await copyAsRoot(target, content, path);
}

async function removeAsRoot(access: NftAccess, path: string): Promise<boolean> {
  const removed = await runAsRoot(access, ['sh', '-c', 'test -e "$1" || exit 3; rm -f "$1"', 'sh', path]);
  if (removed.exitCode === 3) return false;
  if (removed.exitCode !== 0) throw new HostError('command-failed', removed.stderr.trim());
  return true;
}

