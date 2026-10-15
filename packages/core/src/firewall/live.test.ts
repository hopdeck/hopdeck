// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import basicJson from '../../test/fixtures/basic.json' with { type: 'json' };
import rulesJson from '../../test/fixtures/rules.json' with { type: 'json' };
import { blockKey, ruleKey, tableKey } from './keys.ts';
import { liveState, tableFingerprints } from './live.ts';

type Item = Record<string, Record<string, unknown>>;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const items = (json: { nftables: unknown[] }) => json.nftables as Item[];

describe('liveState', () => {
  it('reads anonymous and named counters', () => {
    const state = liveState(rulesJson, '2026-09-26T10:00:00Z');
    const counted = Object.keys(state.rules).map((key) => JSON.parse(key) as [string, string, number]);
    expect(counted.length).toBeGreaterThanOrEqual(2);
    expect(counted.every(([family, table]) => family === 'inet' && table === 't')).toBe(true);
    expect(liveState(basicJson, '').counters[blockKey('inet', 'filter', 'counter', 'web')]).toEqual({ packets: 0, bytes: 0 });

    const counting = copy(basicJson);
    const web = items(counting).find((item) => item['counter']?.['name'] === 'web')!;
    web['counter']!['packets'] = 12;
    web['counter']!['bytes'] = 3400;
    expect(liveState(counting, '').counters[blockKey('inet', 'filter', 'counter', 'web')]).toEqual({ packets: 12, bytes: 3400 });
    expect(liveState(rulesJson, '').rules[ruleKey('inet', 't', 999)]).toBeUndefined();
  });
});

describe('tableFingerprints', () => {
  const filter = tableKey('inet', 'filter');
  const nat = tableKey('ip', 'nat');
  const before = tableFingerprints(basicJson);

  it('ignores what changes on its own', () => {
    const json = copy(basicJson);
    for (const item of items(json)) {
      if (item['counter']) item['counter']['packets'] = 99;
      if (item['quota']) item['quota']['used'] = 1234;
      if (item['set']) item['set']['elem'] = ['10.9.9.9'];
      const expr = item['rule']?.['expr'] as Record<string, unknown>[] | undefined;
      for (const statement of expr ?? []) if (typeof statement['counter'] === 'object') statement['counter'] = { packets: 7, bytes: 700 };
    }
    // A trace table appears while hopdeck traces.
    json.nftables.push({ table: { family: 'inet', name: 'hopdeck_trace_ab12', handle: 99 } });
    expect(tableFingerprints(json)).toEqual(before);
  });

  it('changes for the table whose rules changed, and only for it', () => {
    const json = copy(basicJson);
    const rule = items(json).find((item) => item['rule']?.['table'] === 'filter')!;
    (rule['rule']!['expr'] as unknown[]).push({ drop: null });
    const after = tableFingerprints(json);
    expect(after[filter]).not.toBe(before[filter]);
    expect(after[nat]).toBe(before[nat]);
  });

  it('keeps the quota limit in, since it is not a use', () => {
    const json = copy(basicJson);
    items(json).find((item) => item['quota'])!['quota']!['bytes'] = 1;
    expect(tableFingerprints(json)[filter]).not.toBe(before[filter]);
  });

  it('can leave handles out, so a table loaded again keeps its hash', () => {
    const json = copy(basicJson);
    for (const item of items(json)) {
      const body = Object.values(item)[0] as Record<string, unknown>;
      if (typeof body['handle'] === 'number') body['handle'] += 100;
    }
    expect(tableFingerprints(json)[filter]).not.toBe(before[filter]);
    expect(tableFingerprints(json, { handles: false })).toEqual(tableFingerprints(basicJson, { handles: false }));
  });
});
