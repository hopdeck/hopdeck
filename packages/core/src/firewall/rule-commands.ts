// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { diffLines } from '../diff.ts';
import { nftName } from './changes.ts';
import { normalizedTable } from './history.ts';
import type { Family } from './nft-json.ts';
import { chains, definitionTable, editableTable, renderTable, type EditableTable } from './table-edit.ts';

/** A table change made rule by rule: nft commands, and how many rules each kind touches. */
export interface RuleCommands {
  /** nft input; empty when no rule differs. */
  script: string;
  added: number;
  removed: number;
  /** Rules changed where they stand, keeping their handle. */
  replaced: number;
}

/**
 * The commands that turn a table into `definition` by changing only the rules
 * that differ: `replace rule` where a rule changed in its place, `delete rule`,
 * and `insert rule` before the next unchanged rule (`add rule` at the end).
 * Rules left alone keep their handles, counters and the state of their limits.
 *
 * `annotated` is the table as `nft -a list` prints it, with handles. Undefined
 * when anything but rules differs (chains, their type or policy, sets, maps,
 * objects, the table's comment): then the table has to be replaced whole.
 * Counter values and expiry do not count as differences.
 */
export function ruleCommands(family: Family, name: string, annotated: string, definition: string): RuleCommands | undefined {
  const before = editableTable(annotated, family, name);
  const after = definitionTable(definition, family, name);
  if (before === undefined || after === undefined || skeleton(before) !== skeleton(after)) return undefined;

  const table = `${family} ${nftName(name)}`;
  const result: RuleCommands = { script: '', added: 0, removed: 0, replaced: 0 };
  const lines: string[] = [];
  const afterChains = chains(after);
  for (const [index, chain] of chains(before).entries()) {
    const old = chain.rules;
    if (old.some((rule) => rule.handle === undefined)) return undefined;
    const next = afterChains[index]!.rules.map((rule) => rule.text);
    const target = `${table} ${nftName(chain.name)}`;

    // Walk a line diff of the rules; a hunk is a run of changes between unchanged rules.
    const diff = diffLines(joined(old.map((rule) => rule.text)), joined(next));
    let oldIndex = 0;
    let newIndex = 0;
    let removed: number[] = [];
    let added: string[] = [];
    const flush = (anchor: number | undefined) => {
      const paired = Math.min(removed.length, added.length);
      for (let pair = 0; pair < paired; pair += 1) lines.push(`replace rule ${target} handle ${removed[pair]} ${added[pair]}`);
      for (const handle of removed.slice(paired)) lines.push(`delete rule ${target} handle ${handle}`);
      for (const rule of added.slice(paired)) lines.push(anchor === undefined ? `add rule ${target} ${rule}` : `insert rule ${target} position ${anchor} ${rule}`);
      result.replaced += paired;
      result.removed += removed.length - paired;
      result.added += added.length - paired;
      removed = [];
      added = [];
    };
    for (const line of diff) {
      if (line.kind === 'remove') {
        removed.push(old[oldIndex]!.handle!);
        oldIndex += 1;
      } else if (line.kind === 'add') {
        added.push(next[newIndex]!);
        newIndex += 1;
      } else {
        flush(old[oldIndex]!.handle);
        oldIndex += 1;
        newIndex += 1;
      }
    }
    flush(undefined);
  }
  result.script = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  return result;
}

/** The table without its rules, and without what changes on its own. */
function skeleton(table: EditableTable): string {
  const bare: EditableTable = {
    ...table,
    parts: table.parts.map((part) => (part.kind === 'chain' ? { kind: 'chain', chain: { ...part.chain, rules: [] } } : part)),
  };
  return normalizedTable(renderTable(bare));
}

/** Rules as lines to diff, compared without counter values; an empty chain is no lines at all. */
function joined(rules: readonly string[]): string {
  return rules.length === 0 ? '' : `${rules.map((rule) => normalizedTable(rule)).join('\n')}\n`;
}
