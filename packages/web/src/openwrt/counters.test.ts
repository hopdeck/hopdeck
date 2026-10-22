// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { UciSection } from '@hopdeck/core';
import { describe, expect, it } from 'vitest';
import { buildModel } from '../firewall/ruleset/model.ts';
import { fw4Counters, fw4Name } from './counters.ts';

const rule = (chain: string, handle: number, comment: string, packets: number) => ({
  rule: { family: 'inet', table: 'fw4', chain, handle, comment, expr: [{ counter: { packets, bytes: packets * 100 } }, { accept: null }] },
});

/** fw4's table as nft lists it in JSON: a rule with an IPv4 and an IPv6 part, a port forward and a NAT rule. */
const model = buildModel({
  json: {
    nftables: [
      { table: { family: 'inet', name: 'fw4', handle: 1 } },
      { chain: { family: 'inet', table: 'fw4', name: 'input_wan', handle: 2 } },
      { chain: { family: 'inet', table: 'fw4', name: 'dstnat_wan', handle: 3 } },
      { chain: { family: 'inet', table: 'fw4', name: 'srcnat_wan', handle: 4 } },
      rule('input_wan', 10, '!fw4: Allow-Ping', 5),
      rule('input_wan', 11, '!fw4: Allow-Ping', 2),
      rule('input_wan', 12, '!fw4: @rule[9]', 1),
      rule('dstnat_wan', 13, '!fw4: Web', 7),
      rule('input_wan', 14, 'not fw4', 9),
      rule('srcnat_wan', 15, '!fw4: @nat[0]', 4),
    ],
  },
  listing: '',
  readAt: '2026-10-18T10:00:00.000Z',
});

describe('fw4Counters', () => {
  it('adds up the rules fw4 made of one section, rules apart from port forwards and NAT rules', () => {
    const rules = fw4Counters(model, undefined, 'rule');
    expect(rules.get('Allow-Ping')).toEqual({ packets: 7, bytes: 700, rate: undefined });
    expect(rules.get('@rule[9]')?.packets).toBe(1);
    expect(rules.has('Web')).toBe(false);
    expect(rules.has('@nat[0]')).toBe(false);
    expect(fw4Counters(model, undefined, 'redirect').get('Web')?.packets).toBe(7);
    expect([...fw4Counters(model, undefined, 'nat').keys()]).toEqual(['@nat[0]']);
  });

  it('takes live counts and rates over the model’s', () => {
    const live = {
      state: { readAt: '', rules: { [JSON.stringify(['inet', 'fw4', 10])]: { packets: 50, bytes: 5000 } }, counters: {}, fingerprints: {} },
      rates: { rules: { [JSON.stringify(['inet', 'fw4', 10])]: { packets: 3, bytes: 300 } }, counters: {} },
    };
    expect(fw4Counters(model, live, 'rule').get('Allow-Ping')).toEqual({ packets: 52, bytes: 5200, rate: 3 });
  });
});

describe('fw4Name', () => {
  it('is the section’s name, or its place among its type', () => {
    const sections: UciSection[] = [
      { name: 'cfg01', type: 'zone', anonymous: true, index: 0, options: { name: 'lan' } },
      { name: 'cfg02', type: 'rule', anonymous: true, index: 1, options: { name: 'SSH' } },
      { name: 'cfg03', type: 'rule', anonymous: true, index: 2, options: {} },
    ];
    expect(fw4Name(sections[1]!, sections)).toBe('SSH');
    expect(fw4Name(sections[2]!, sections)).toBe('@rule[1]');
  });
});
