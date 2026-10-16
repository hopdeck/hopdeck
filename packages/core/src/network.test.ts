// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import { inNetwork, networkOf, parseNetwork, parseRoute } from './network.ts';

// As iproute2 prints them; a container's veth shows as eth0@if5.
const OUTPUT = `1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\\    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
2: eth0@if5: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default qlen 1000\\    link/ether 52:54:00:12:34:56 brd ff:ff:ff:ff:ff:ff
3: lan0: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN mode DEFAULT group default qlen 1000\\    link/ether 52:54:00:65:43:21 brd ff:ff:ff:ff:ff:ff
--- addr
1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever
1: lo    inet6 ::1/128 scope host noprefixroute \\       valid_lft forever preferred_lft forever
2: eth0    inet 203.0.113.5/24 brd 203.0.113.255 scope global eth0\\       valid_lft forever preferred_lft forever
2: eth0    inet6 2001:db8::5/64 scope global \\       valid_lft forever preferred_lft forever
3: lan0    inet 192.168.1.1/24 brd 192.168.1.255 scope global lan0\\       valid_lft forever preferred_lft forever
--- forwarding
1
0
`;

describe('parseNetwork', () => {
  it('reads interfaces with their addresses, and whether the host forwards', () => {
    expect(parseNetwork(OUTPUT)).toEqual({
      interfaces: [
        { name: 'lo', up: true, addresses: [{ family: 'ip', address: '127.0.0.1', prefix: 8 }, { family: 'ip6', address: '::1', prefix: 128 }] },
        { name: 'eth0', up: true, addresses: [{ family: 'ip', address: '203.0.113.5', prefix: 24 }, { family: 'ip6', address: '2001:db8::5', prefix: 64 }] },
        { name: 'lan0', up: false, addresses: [{ family: 'ip', address: '192.168.1.1', prefix: 24 }] },
      ],
      forwarding: { ip: true, ip6: false },
    });
  });

  it('says the host does not forward where /proc has no answer', () => {
    expect(parseNetwork('--- addr\n--- forwarding\n').forwarding).toEqual({ ip: false, ip6: false });
  });
});

describe('parseRoute', () => {
  it('reads the interface, the gateway and the source address', () => {
    expect(parseRoute('192.168.1.10 dev lan0 src 192.168.1.1 uid 1000 \n    cache \n')).toEqual({ device: 'lan0', source: '192.168.1.1' });
    expect(parseRoute('198.51.100.7 via 203.0.113.1 dev eth0 src 203.0.113.5 uid 0 \n    cache \n')).toEqual({ device: 'eth0', via: '203.0.113.1', source: '203.0.113.5' });
  });
});

describe('networkOf and inNetwork', () => {
  it('gives the network of an address, IPv4 and IPv6', () => {
    expect(networkOf('192.168.1.1', 24)).toBe('192.168.1.0/24');
    expect(networkOf('10.20.30.40', 12)).toBe('10.16.0.0/12');
    expect(networkOf('2001:db8:0:1::5', 64)).toBe('2001:db8:0:1::/64');
    expect(networkOf('2001:db8::5', 48)).toBe('2001:db8::/48');
  });

  it('tells whether an address is on a network', () => {
    expect(inNetwork('192.168.1.10', '192.168.1.0/24')).toBe(true);
    expect(inNetwork('192.168.2.10', '192.168.1.0/24')).toBe(false);
    expect(inNetwork('2001:db8::10', '2001:db8::/64')).toBe(true);
    expect(inNetwork('192.168.1.10', '2001:db8::/64')).toBe(false);
  });
});
