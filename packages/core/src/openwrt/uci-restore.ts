// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { HistoryAuthor } from '../firewall/history.ts';
import { previewUci } from './uci-edit.ts';
import type { StagedChange, UciChange, UciConfig, UciSection } from './uci.ts';

/**
 * The changes that make `current` what `target` is, in UCI's terms, for a
 * review to read as edits rather than everything removed and added again.
 * Sections pair up by their own name, then by type and name option, then by
 * type in their order; options that differ are set or removed, sections left
 * over are removed or added, and the order follows the target's.
 */
export function uciRestoreChanges(current: UciConfig, target: UciConfig): UciChange[] {
  const pairs = new Map<UciSection, UciSection>();
  const free = new Set(current.sections);
  const take = (wanted: UciSection, test: (candidate: UciSection) => boolean) => {
    const found = current.sections.find((candidate) => free.has(candidate) && candidate.type === wanted.type && test(candidate));
    if (found === undefined) return;
    pairs.set(wanted, found);
    free.delete(found);
  };
  for (const wanted of target.sections) if (!wanted.anonymous) take(wanted, (candidate) => !candidate.anonymous && candidate.name === wanted.name);
  for (const wanted of target.sections) {
    const name = wanted.options['name'];
    if (wanted.anonymous && !pairs.has(wanted) && typeof name === 'string') take(wanted, (candidate) => candidate.anonymous && candidate.options['name'] === name);
  }
  for (const wanted of target.sections) if (wanted.anonymous && !pairs.has(wanted)) take(wanted, (candidate) => candidate.anonymous && typeof candidate.options['name'] !== 'string');

  const changes: UciChange[] = [];
  for (const section of current.sections) if (free.has(section)) changes.push({ kind: 'delete', section: section.name });
  const names = new Map<UciSection, string>();
  let fresh = 0;
  for (const wanted of target.sections) {
    const paired = pairs.get(wanted);
    if (paired === undefined) {
      fresh += 1;
      const ref = `new-r${fresh}`;
      names.set(wanted, wanted.anonymous ? ref : wanted.name);
      changes.push({ kind: 'add', type: wanted.type, ...(wanted.anonymous ? { ref } : { name: wanted.name }), values: { ...wanted.options } });
      continue;
    }
    names.set(wanted, paired.name);
    const values = Object.fromEntries(Object.entries(wanted.options).filter(([option, value]) => JSON.stringify(paired.options[option]) !== JSON.stringify(value)));
    const removed = Object.keys(paired.options).filter((option) => !(option in wanted.options));
    if (Object.keys(values).length > 0) changes.push({ kind: 'set', section: paired.name, values });
    if (removed.length > 0) changes.push({ kind: 'unset', section: paired.name, options: removed });
  }
  const order = target.sections.map((wanted) => names.get(wanted)!);
  const after = previewUci(current, changes).sections.map((section) => section.name);
  if (after.join('\n') !== order.join('\n')) changes.push({ kind: 'order', sections: order });
  return changes;
}

/**
 * baseline: the configuration as hopdeck first found it; change: made with
 * hopdeck and kept; outside: changed by something else, in LuCI or with uci.
 */
export type UciHistoryKind = 'baseline' | 'change' | 'outside';

/** A version of a UCI configuration on the router, as its history keeps it. */
export interface UciHistoryVersion {
  id: number;
  /** ISO 8601. */
  time: string;
  kind: UciHistoryKind;
  /** For a change, who made it; otherwise whose hopdeck noticed. */
  author: HistoryAuthor;
  /** The SHA-256 of /etc/config/<config> as it was. */
  hash: string;
  plan?: string;
  /** The version a change put back. */
  restoredFrom?: number;
  /** What a change wrote, as rpcd listed it. */
  changes: (StagedChange & { label: string })[];
  /** hopdeck's include files the configuration pointed to, kept with it. */
  includes: string[];
}

/** A version with its configuration, as the file has it and as ubus reads it, and its include files. */
export interface UciHistoryDetail {
  version: UciHistoryVersion;
  /** /etc/config/<config> as it was. */
  text: string;
  config: UciConfig;
  includes: { path: string; content: string }[];
}

export interface UciHistoryState {
  /** Where the versions are on the router. */
  directory: string;
  /** Disk space they take, in bytes. */
  size: number;
  /** Newest first. */
  versions: UciHistoryVersion[];
  /** Why there is no history here, or why the last version could not be written. */
  problem?: { code: string; detail: string };
}
