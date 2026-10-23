// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import { fw4Name, openwrtFirewall } from './firewall.ts';
import { fw4LogOrigin } from './log-origin.ts';
import { parseUciGet } from './uci.ts';

const config = parseUciGet(
  'firewall',
  JSON.stringify({
    values: {
      lan: { '.anonymous': true, '.type': 'zone', '.name': 'cfg01', '.index': 0, name: 'lan' },
      wan: { '.anonymous': true, '.type': 'zone', '.name': 'cfg02', '.index': 1, name: 'wan', log: '1' },
      ping: { '.anonymous': true, '.type': 'rule', '.name': 'cfg03', '.index': 2, name: 'Allow-Ping', log: '1' },
      ssh: { '.anonymous': true, '.type': 'rule', '.name': 'cfg04', '.index': 3, log: 'yes' },
      own: { '.anonymous': true, '.type': 'rule', '.name': 'cfg05', '.index': 4, name: 'Mine', log: 'ssh in: ' },
      quiet: { '.anonymous': true, '.type': 'rule', '.name': 'cfg06', '.index': 5, name: 'Quiet', log: '0' },
      web: { '.anonymous': false, '.type': 'redirect', '.name': 'web', '.index': 6, log: '1' },
      vpn: { '.anonymous': true, '.type': 'nat', '.name': 'cfg07', '.index': 7, name: 'VPN', log: 'on' },
    },
  }),
);
const firewall = openwrtFirewall(config);

describe('fw4Name', () => {
  it('is the name option, a named section’s own name, or its place among its type', () => {
    expect(fw4Name(config.sections[2]!, config.sections)).toBe('Allow-Ping');
    expect(fw4Name(config.sections[3]!, config.sections)).toBe('@rule[1]');
    expect(fw4Name(config.sections[6]!, config.sections)).toBe('web');
  });
});

describe('fw4LogOrigin', () => {
  it('knows a zone’s policy by its prefix', () => {
    expect(fw4LogOrigin(firewall, config.sections, 'reject wan in: ')).toEqual({ kind: 'zone', zone: 'wan', direction: 'in', verdict: 'reject' });
    expect(fw4LogOrigin(firewall, config.sections, 'drop lan forward: ')).toEqual({ kind: 'zone', zone: 'lan', direction: 'forward', verdict: 'drop' });
    expect(fw4LogOrigin(firewall, config.sections, 'reject dmz in: ')).toBeUndefined();
  });

  it('knows sections that log by fw4’s names for them, or by their own prefix', () => {
    expect(fw4LogOrigin(firewall, config.sections, 'Allow-Ping: ')).toEqual({ kind: 'rule', name: 'Allow-Ping', section: 'cfg03' });
    expect(fw4LogOrigin(firewall, config.sections, '@rule[1]: ')).toEqual({ kind: 'rule', name: '@rule[1]', section: 'cfg04' });
    expect(fw4LogOrigin(firewall, config.sections, 'ssh in: ')).toEqual({ kind: 'rule', name: 'Mine', section: 'cfg05' });
    expect(fw4LogOrigin(firewall, config.sections, 'web: ')).toEqual({ kind: 'redirect', name: 'web', section: 'web' });
    expect(fw4LogOrigin(firewall, config.sections, 'VPN: ')).toEqual({ kind: 'nat', name: 'VPN', section: 'cfg07' });
    expect(fw4LogOrigin(firewall, config.sections, 'Quiet: ')).toBeUndefined();
    expect(fw4LogOrigin(firewall, config.sections, 'hopdeck drop: ')).toBeUndefined();
  });
});
