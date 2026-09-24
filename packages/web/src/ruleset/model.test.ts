import { findTable } from '@nftm/core';
import { describe, expect, it } from 'vitest';
import basicJson from '../../../core/test/fixtures/basic.json' with { type: 'json' };
import basicListing from '../../../core/test/fixtures/basic.listing?raw';
import { buildModel, formatBytes, priorityText, ruleCounter, tableCounts } from './model.ts';

const model = buildModel({ json: basicJson, listing: basicListing, readAt: '2026-09-24T12:00:00Z' });
const filter = findTable(model.ruleset, 'inet', 'filter')!;

describe('buildModel', () => {
  it('counts tables, chains and rules', () => {
    expect(model.counts).toEqual({ tables: 2, chains: 4, rules: 6 });
    expect(tableCounts(filter)).toEqual({ chains: 3, rules: 5, sets: 1, maps: 1 });
  });

  it('recognises no owner for plain tables', () => {
    expect(model.owners.get(filter)).toEqual({ kind: 'unknown' });
  });
});

describe('ruleCounter', () => {
  it('reads named counters through the table', () => {
    const input = filter.chains[0]!;
    expect(ruleCounter(input.rules[3]!, filter)).toEqual({ packets: 0, bytes: 0 });
    expect(ruleCounter(input.rules[0]!, filter)).toBeUndefined();
  });

  it('reads anonymous counters from the rule', () => {
    const rule = { family: 'inet' as const, table: 'filter', chain: 'input', handle: 1, expr: [{ counter: { packets: 12, bytes: 3400 } }] };
    expect(ruleCounter(rule, filter)).toEqual({ packets: 12, bytes: 3400 });
  });
});

describe('priorityText', () => {
  it("prefers nft's symbolic text", () => {
    const chain = filter.chains[0]!.chain;
    expect(priorityText('type filter hook input priority filter + 10; policy accept;', chain)).toBe('filter + 10');
    expect(priorityText(undefined, chain)).toBe('0');
  });
});

describe('formatBytes', () => {
  it('uses binary units and the locale', () => {
    expect(formatBytes(0, 'en')).toBe('0 B');
    expect(formatBytes(1536, 'en')).toBe('1.5 KiB');
    expect(formatBytes(1536, 'pl')).toBe('1,5 KiB');
    expect(formatBytes(5 * 1024 ** 3, 'en')).toBe('5 GiB');
  });
});
