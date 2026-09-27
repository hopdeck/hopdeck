// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { DeploymentTable, HostErrorCode, TableChange } from '../hosts.ts';
import { isManaged, tableText } from './changes.ts';
import { tableKey } from './keys.ts';
import { tableFingerprints } from './live.ts';
import type { Family } from './nft-json.ts';
import { parseRuleset } from './ruleset.ts';

/*
 * The history of the managed tables, kept on each host: every change made with
 * hopdeck, and whatever else changed them in between. See docs/ARCHITECTURE.md,
 * "History".
 */

/** Versions kept whatever the size limit, so the history cannot be pruned away. */
export const HISTORY_MIN_VERSIONS = 10;

/** Settings kept on the host, so every admin who connects shares them. */
export interface HostSettings {
  history: {
    /** Disk space the history may take; beyond it the oldest versions go, but never the last HISTORY_MIN_VERSIONS. */
    maxBytes: number;
  };
}

export const DEFAULT_HOST_SETTINGS: HostSettings = { history: { maxBytes: 10 * 1024 * 1024 } };

/** What the history limit may be set to. */
export const HISTORY_MAX_BYTES = { min: 1024 * 1024, max: 10 * 1024 * 1024 * 1024 };

/** Settings as the host's settings file has them; what is missing or out of range takes the default. */
export function parseHostSettings(text: string | undefined): HostSettings {
  let data: unknown;
  try {
    data = text === undefined || text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    data = {};
  }
  const history = typeof data === 'object' && data !== null ? (data as { history?: { maxBytes?: unknown } }).history : undefined;
  const maxBytes = history?.maxBytes;
  return {
    history: { maxBytes: validMaxBytes(maxBytes) ? maxBytes : DEFAULT_HOST_SETTINGS.history.maxBytes },
  };
}

export function validMaxBytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= HISTORY_MAX_BYTES.min && value <= HISTORY_MAX_BYTES.max;
}

/** Who made a version, or whose hopdeck noticed it. */
export interface HistoryAuthor {
  /** Who ran hopdeck, on which computer. hopdeck says so itself, so it is only as true as that computer. */
  user: string;
  computer: string;
  /** The account on the host that ran the commands. */
  login: string;
  /** The SSH connection as the host saw it; absent for the local machine and the sandbox. */
  connection?: {
    address: string;
    port: number;
    /** How sshd let the connection in, e.g. "publickey", from its log line; absent when the log had none. */
    method?: string;
    /** The key's type and fingerprint as sshd logged them, e.g. "ED25519 SHA256:…". */
    key?: string;
  };
}

/**
 * baseline: the managed tables as hopdeck first found them; change: a change
 * made with hopdeck and kept; outside: the managed tables differ from the
 * version before, changed by something else.
 */
export type HistoryKind = 'baseline' | 'change' | 'outside';

export interface HistoryTable {
  family: Family;
  name: string;
  /** Its file in the version's directory. */
  file: string;
  /** See historyFingerprints(). */
  fingerprint: string;
}

export interface HistoryVersion {
  id: number;
  /** ISO 8601. */
  time: string;
  kind: HistoryKind;
  /** For a change, who made it; otherwise whose hopdeck noticed. */
  author: HistoryAuthor;
  deployment?: string;
  manualOverride?: boolean;
  /** The version a change put back. */
  restoredFrom?: number;
  /** What a change touched, including tables hopdeck does not manage (Manual override). */
  changes: { family: Family; name: string; action: DeploymentTable['action']; set?: string }[];
  /** The managed tables after it. */
  tables: HistoryTable[];
}

/** A version with its tables as nft input. */
export interface HistoryVersionDetail {
  version: HistoryVersion;
  tables: { family: Family; name: string; text: string }[];
}

export interface HistoryState {
  /** Where the versions are on the host. */
  directory: string;
  /** Disk space they take, in bytes. */
  size: number;
  settings: HostSettings;
  /** Where the settings are on the host. */
  settingsFile: string;
  /** Newest first. */
  versions: HistoryVersion[];
  /** Versions whose meta.json cannot be read, newest first. */
  unreadable?: number[];
  /** Why this host keeps no history. */
  problem?: { code: HostErrorCode; detail: string };
  /** The last try to record a version failed, so a change may be missing. */
  failure?: { time: string; code: HostErrorCode | 'unknown'; detail: string };
}

/**
 * Per managed table, a hash of its content alone: no handles, counter values,
 * quota use, expiry or set elements. A table loaded again at boot keeps it, and
 * sets that fill themselves do not count as changes.
 *
 * Which tables are managed comes from `managed` when given (tableKey()s):
 * nft 1.0.6 and older print no table comments in JSON, so the marker has to be
 * read from its text.
 */
export function historyFingerprints(json: unknown, managed?: ReadonlySet<string>): Record<string, string> {
  managed ??= new Set(
    parseRuleset(json)
      .tables.filter((node) => isManaged(node.table))
      .map((node) => tableKey(node.table.family, node.table.name)),
  );
  return Object.fromEntries(Object.entries(tableFingerprints(json, { handles: false })).filter(([key]) => managed.has(key)));
}

export function sameTables(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** A table as a version keeps it: counters at zero, without quota use and expiry. */
export function normalizedTable(text: string): string {
  return text
    .replace(/packets \d+ bytes \d+/g, 'packets 0 bytes 0')
    .replace(/ used \d+ \w*bytes/g, '')
    .replace(/ expires [\w.]+/g, '');
}

/**
 * The file of a table: characters outside [A-Za-z0-9_.-] are %-escaped, in the
 * family too, since it comes from what the host printed.
 */
export function tableFileName(family: Family, name: string): string {
  const safe = (text: string) => text.replace(/[^A-Za-z0-9_.-]/g, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return `${safe(family)}-${safe(name)}.nft`;
}

/**
 * The changes that put the managed tables back as a version has them: tables
 * that differ are replaced, managed tables the version lacks are deleted.
 * `listing` is `nft list ruleset` now, without handles. With `only`, just that
 * table.
 */
export function restoreChanges(
  detail: HistoryVersionDetail,
  listing: string,
  managedNow: readonly { family: Family; name: string }[],
  only?: { family: Family; name: string },
): TableChange[] {
  const wanted = (family: Family, name: string) => only === undefined || (only.family === family && only.name === name);
  const changes: TableChange[] = [];
  for (const table of detail.tables) {
    if (!wanted(table.family, table.name)) continue;
    const current = tableText(listing, table.family, table.name);
    if (current !== undefined && normalizedTable(current) === table.text) continue;
    changes.push({ kind: 'replace', family: table.family, table: table.name, definition: table.text });
  }
  for (const { family, name } of managedNow) {
    if (!wanted(family, name)) continue;
    if (!detail.tables.some((table) => table.family === family && table.name === name)) changes.push({ kind: 'delete', family, table: name });
  }
  return changes;
}
