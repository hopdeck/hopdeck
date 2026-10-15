// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { emptyRule } from '@hopdeck/core';
import { describe, expect, it } from 'vitest';
import { ruleColumns } from './rule-summary.ts';

describe('ruleColumns', () => {
  it('fills the grid columns from a form', () => {
    const columns = ruleColumns({
      ...emptyRule(),
      protocol: 'tcp',
      srcAddress: { value: '10.0.0.0/24', negate: true },
      dstPort: { value: '80, 443', negate: false },
      inInterface: { value: 'eth0', negate: false, byIndex: false },
      ctState: ['new'],
      counter: true,
      log: { prefix: 'web: ' },
      action: { kind: 'drop' },
    });
    expect(columns).toMatchObject({
      action: 'drop',
      actionTone: 'drop',
      protocol: 'tcp',
      source: '!10.0.0.0/24',
      destinationPort: '80, 443',
      input: 'eth0',
      state: 'new',
      extra: 'counter, log "web: "',
    });
  });

  it('sums up packet matches and limits in their own columns', () => {
    const columns = ruleColumns({
      ...emptyRule(),
      tcpFlags: { set: ['syn'], unset: ['ack'] },
      length: { op: '>', value: '1000' },
      limit: { rate: 10, per: 'second', burst: 5, over: true },
      keyedLimit: { verb: 'meter', set: 'ssh', key: 'ip saddr', limit: { rate: 3, per: 'minute' } },
      quota: { amount: 1, unit: 'mbytes', over: false },
      notrack: true,
      action: { kind: 'vmap', key: 'tcp dport', map: '@ports' },
    });
    expect(columns).toMatchObject({
      action: 'vmap @ports',
      actionTone: 'jump',
      packet: 'flags syn !ack, length > 1000',
      limits: 'over 10/second, ip saddr: 3/minute, quota 1 mbytes',
      extra: 'notrack',
    });
  });
});
