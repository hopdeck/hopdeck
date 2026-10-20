// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import { mergeHosts, parseLeaseFile, parseLuciLeases, staticHosts } from './leases.ts';
import { parseUciGet } from './uci.ts';

describe('DHCP hosts', () => {
  it('reads luci-rpc’s leases, as OpenWrt 25.12 prints them', () => {
    const json = '{"dhcp_leases":[{"expires":43167,"macaddr":"BC:24:11:8A:43:55","duid":"0002","ipaddr":"192.168.1.189"},{"hostname":"nas","macaddr":"aa:bb:cc:dd:ee:ff","ipaddr":"192.168.1.20"}],"dhcp6_leases":[]}';
    expect(parseLuciLeases(json)).toEqual([
      { ip: '192.168.1.189', mac: 'bc:24:11:8a:43:55', static: false },
      { ip: '192.168.1.20', mac: 'aa:bb:cc:dd:ee:ff', name: 'nas', static: false },
    ]);
    expect(parseLuciLeases('Command failed: Not found')).toEqual([]);
  });

  it('reads dnsmasq’s lease file', () => {
    expect(parseLeaseFile('1792532283 bc:24:11:8a:43:55 192.168.1.189 * ff:ca\n1792532290 aa:bb:cc:dd:ee:ff 192.168.1.20 nas 01:aa\n\n')).toEqual([
      { ip: '192.168.1.189', mac: 'bc:24:11:8a:43:55', static: false },
      { ip: '192.168.1.20', mac: 'aa:bb:cc:dd:ee:ff', name: 'nas', static: false },
    ]);
  });

  it('takes the host sections with an address, and puts their names over the leases’', () => {
    const dhcp = parseUciGet(
      'dhcp',
      JSON.stringify({
        values: {
          h1: { '.anonymous': true, '.type': 'host', '.name': 'cfg01', '.index': 0, name: 'printer', mac: ['AA:BB:CC:DD:EE:FF'], ip: '192.168.1.20' },
          h2: { '.anonymous': true, '.type': 'host', '.name': 'cfg02', '.index': 1, name: 'no-address', mac: 'aa:aa:aa:aa:aa:aa' },
          lan: { '.anonymous': false, '.type': 'dhcp', '.name': 'lan', '.index': 2, interface: 'lan' },
        },
      }),
    );
    expect(staticHosts(dhcp)).toEqual([{ ip: '192.168.1.20', mac: 'aa:bb:cc:dd:ee:ff', name: 'printer', static: true }]);
    expect(mergeHosts([{ ip: '192.168.1.189', static: false }, { ip: '192.168.1.20', name: 'nas', static: false }], staticHosts(dhcp))).toEqual([
      { ip: '192.168.1.20', name: 'printer', mac: 'aa:bb:cc:dd:ee:ff', static: true },
      { ip: '192.168.1.189', static: false },
    ]);
  });
});
