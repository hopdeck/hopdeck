// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import basic from '../../test/fixtures/basic.json' with { type: 'json' };
import { findTable, parseRuleset, RulesetParseError } from './ruleset.ts';

describe('parseRuleset', () => {
  const ruleset = parseRuleset(basic);

  it('reads metainfo and groups objects by table', () => {
    expect(ruleset.metainfo?.json_schema_version).toBe(1);
    expect(ruleset.tables.map((t) => `${t.table.family} ${t.table.name}`)).toEqual(['inet filter', 'ip nat']);
    expect(ruleset.unknown).toEqual([]);

    const filter = findTable(ruleset, 'inet', 'filter')!;
    expect(filter.chains.map((c) => c.chain.name)).toEqual(['input', 'ssh_in', 'forward']);
    expect(filter.sets.map((s) => s.name)).toEqual(['admins']);
    expect(filter.maps.map((m) => m.name)).toEqual(['port_policy']);
    expect(filter.flowtables.map((f) => f.name)).toEqual(['fast']);
    expect(filter.objects.map((o) => `${o.kind} ${o.object.name}`)).toEqual([
      'counter web',
      'quota monthly',
      'limit slow',
      'ct helper ftp',
      'synproxy syn',
    ]);
  });

  it('keeps rules in chain order', () => {
    const input = findTable(ruleset, 'inet', 'filter')!.chains[0]!;
    expect(input.chain).toMatchObject({ hook: 'input', policy: 'drop' });
    expect(input.rules.map((r) => r.handle)).toEqual([12, 13, 14, 16]);
  });

  it('returns the original objects, not copies', () => {
    const rule = findTable(ruleset, 'inet', 'filter')!.chains[1]!.rules[0]!;
    expect(rule.comment).toBe('ssh from admins');
    expect(basic.nftables.some((item) => Object.values(item)[0] === rule)).toBe(true);
  });

  it('keeps items it does not understand', () => {
    const future = { tunnel: { family: 'inet', table: 'filter', name: 't1', handle: 99 } };
    const orphan = { rule: { family: 'inet', table: 'filter', chain: 'missing', handle: 100, expr: [] } };
    const odd = { a: {}, b: {} };
    const duplicate = { table: { family: 'ip', name: 'nat', handle: 50 } };
    const parsed = parseRuleset({ nftables: [future, ...basic.nftables, orphan, odd, duplicate] });
    expect(parsed.unknown).toEqual([future, orphan, odd, duplicate]);
    expect(parsed.tables).toHaveLength(2);
  });

  it('rejects input that is not an nft JSON document', () => {
    expect(() => parseRuleset([])).toThrow(RulesetParseError);
    expect(() => parseRuleset({ nftables: {} })).toThrow(RulesetParseError);
  });
});
