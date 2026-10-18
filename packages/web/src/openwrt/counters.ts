// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { ruleKey, type Counter, type UciSection } from '@hopdeck/core';
import { ruleCounter, type RulesetModel } from '../firewall/ruleset/model.ts';
import type { LiveInfo } from '../firewall/ruleset/useLive.ts';

/** What fw4 counted for a UCI rule or port forward, and how fast it grew, from all the rules it made of it. */
export interface UciCounter {
  packets: number;
  bytes: number;
  /** Packets a second, from live polling; undefined until two looks are in. */
  rate: number | undefined;
}

/**
 * Counters of fw4's rules by the UCI section they came from: fw4 names each
 * rule after its section's name, or `@rule[3]` for one without (counting the
 * sections of the type), in a comment "!fw4: NAME". One section may make
 * several rules, IPv4 and IPv6 for one; their counts add up. Port forwards
 * are in the dstnat chains, rules in the others.
 */
export function fw4Counters(model: RulesetModel, live: LiveInfo | undefined, kind: 'rule' | 'redirect'): Map<string, UciCounter> {
  const counters = new Map<string, UciCounter>();
  const table = model.ruleset.tables.find((node) => node.table.family === 'inet' && node.table.name === 'fw4');
  if (table === undefined) return counters;
  for (const { chain, rules } of table.chains) {
    if (chain.name.startsWith('dstnat') !== (kind === 'redirect')) continue;
    for (const rule of rules) {
      const name = /^!fw4: (.+)$/.exec(rule.comment ?? '')?.[1];
      if (name === undefined) continue;
      const key = ruleKey('inet', 'fw4', rule.handle);
      const counted: Counter | undefined = live?.state.rules[key] ?? ruleCounter(rule, table);
      if (counted === undefined) continue;
      const rate = live?.rates.rules[key]?.packets;
      const sum = counters.get(name) ?? { packets: 0, bytes: 0, rate: undefined };
      counters.set(name, {
        packets: sum.packets + counted.packets,
        bytes: sum.bytes + counted.bytes,
        rate: rate === undefined ? sum.rate : (sum.rate ?? 0) + rate,
      });
    }
  }
  return counters;
}

/** The name fw4 gives a section's rules: its name option, else its place among the sections of its type. */
export function fw4Name(section: UciSection, sections: readonly UciSection[]): string {
  const name = section.options['name'];
  if (typeof name === 'string' && name !== '') return name;
  const nth = sections.filter((other) => other.type === section.type && other.index < section.index).length;
  return `@${section.type}[${nth}]`;
}
