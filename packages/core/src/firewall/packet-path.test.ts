// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import foreignJson from '../../test/fixtures/foreign.json' with { type: 'json' };
import { hasPath, packetPath, type HookStage } from './packet-path.ts';
import { parseRuleset } from './ruleset.ts';

const ruleset = parseRuleset(foreignJson);

/** "table/chain priority" per hook, with a ! for ties. */
const describeStages = (stages: HookStage[] | undefined) =>
  stages?.map((stage) => [
    stage.hook,
    stage.chains.map((c) => `${c.node.table.family} ${c.node.table.name}/${c.chain.chain.name} ${c.priority}${c.tie ? '!' : ''}`),
  ]);

describe('packetPath', () => {
  it('orders the chains of all tables in a hook by priority and flags ties', () => {
    expect(describeStages(packetPath(ruleset, 'ipv4', 'incoming'))).toEqual([
      ['ingress', []],
      ['prerouting', []],
      ['input', ['inet f2b-table/f2b-chain -1', 'ip filter/INPUT 0!', 'inet mine/input 0!', 'inet firewalld/filter_INPUT 10']],
    ]);
  });

  it('lets inet chains see IPv6 but keeps ip chains out of it', () => {
    const input = packetPath(ruleset, 'ipv6', 'incoming')!.at(-1)!;
    expect(input.chains.map((c) => `${c.node.table.name} ${c.tie}`)).toEqual(['f2b-table false', 'mine false', 'firewalld false']);
  });

  it('follows forwarded traffic through forward and postrouting', () => {
    const stages = packetPath(ruleset, 'ipv4', 'forwarded')!;
    expect(stages.map((stage) => stage.hook)).toEqual(['ingress', 'prerouting', 'forward', 'postrouting', 'egress']);
    expect(stages[2]!.chains.map((c) => `${c.node.table.name}/${c.chain.chain.name}`)).toEqual([
      'libvirt_network/forward',
      'filter/FORWARD',
    ]);
  });

  it('puts netdev chains at ingress for every kind of traffic', () => {
    const withNetdev = parseRuleset({
      nftables: [
        { table: { family: 'netdev', name: 'edge', handle: 1 } },
        { chain: { family: 'netdev', table: 'edge', name: 'in', handle: 1, type: 'filter', hook: 'ingress', prio: -500, dev: 'eth0' } },
      ],
    });
    for (const traffic of ['ipv4', 'ipv6', 'arp', 'bridge'] as const) {
      expect(packetPath(withNetdev, traffic, 'incoming')![0]!.chains.map((c) => c.chain.chain.name)).toEqual(['in']);
    }
  });

  it('knows that ARP is not forwarded', () => {
    expect(hasPath('arp', 'forwarded')).toBe(false);
    expect(packetPath(ruleset, 'arp', 'forwarded')).toBeUndefined();
  });
});
