import { emptyRule } from '@nftm/core';
import { describe, expect, it } from 'vitest';
import { ruleColumns } from './rule-summary.ts';

describe('ruleColumns', () => {
  it('fills the grid columns from a form', () => {
    const columns = ruleColumns({
      ...emptyRule(),
      protocol: 'tcp',
      srcAddress: { value: '10.0.0.0/24', negate: true },
      dstPort: { value: '{ 80, 443 }', negate: false },
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
      destinationPort: '{ 80, 443 }',
      input: 'eth0',
      state: 'new',
      extra: 'counter, log "web: "',
    });
  });
});
