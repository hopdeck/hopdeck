// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import firewallJson from '../../test/fixtures/openwrt/firewall-25.12.json' with { type: 'json' };
import { openwrtFirewall } from './firewall.ts';
import { parseUciChanges, parseUciGet, sectionLabel, uciBoolean, uciCall, uciList } from './uci.ts';

/** /etc/config/firewall of a fresh OpenWrt 25.12, as `ubus call uci get` prints it. */
const FIREWALL = JSON.stringify(firewallJson);

describe('parseUciGet', () => {
  const config = parseUciGet('firewall', FIREWALL);

  it('reads the sections in the order of the file, with their options and lists', () => {
    expect(config.sections.map((section) => section.type)).toEqual(['defaults', 'zone', 'zone', 'forwarding', ...Array(9).fill('rule')]);
    expect(config.sections[2]).toMatchObject({ type: 'zone', anonymous: true, index: 2, options: { name: 'wan', network: ['wan', 'wan6'], masq: '1' } });
    expect(config.sections[2]!.options).not.toHaveProperty('.type');
  });

  it('says what it got instead of JSON', () => {
    expect(() => parseUciGet('firewall', 'Command failed: Not found')).toThrow(/did not print JSON for firewall: Command failed/);
  });

  it('names sections as people do: by their name option, else as uci show does', () => {
    const [defaults, lan, , forwarding, dhcp] = config.sections;
    expect(sectionLabel(config, lan!)).toBe('zone "lan"');
    expect(sectionLabel(config, dhcp!)).toBe('rule "Allow-DHCP-Renew"');
    expect(sectionLabel(config, defaults!)).toBe('@defaults[0]');
    expect(sectionLabel(config, forwarding!)).toBe('@forwarding[0]');
    expect(sectionLabel(config, { name: 'guest', type: 'zone', anonymous: false, index: 20, options: {} })).toBe('zone guest');
  });
});

describe('uciCall', () => {
  it('turns each change into its ubus call', () => {
    expect(uciCall('firewall', { kind: 'add', type: 'redirect', values: { name: 'web', src_dport: '8080' } })).toEqual({
      method: 'add',
      message: { config: 'firewall', type: 'redirect', values: { name: 'web', src_dport: '8080' } },
    });
    expect(uciCall('firewall', { kind: 'set', section: 'cfg02dc81', values: { network: ['lan', 'guest'] } }).message).toEqual({
      config: 'firewall',
      section: 'cfg02dc81',
      values: { network: ['lan', 'guest'] },
    });
    expect(uciCall('firewall', { kind: 'unset', section: 'cfg02dc81', options: ['log'] })).toEqual({
      method: 'delete',
      message: { config: 'firewall', section: 'cfg02dc81', options: ['log'] },
    });
    expect(uciCall('firewall', { kind: 'delete', section: 'cfg02dc81' }).message).toEqual({ config: 'firewall', section: 'cfg02dc81' });
    expect(uciCall('firewall', { kind: 'order', sections: ['b', 'a'] })).toEqual({ method: 'order', message: { config: 'firewall', sections: ['b', 'a'] } });
  });
});

describe('parseUciChanges', () => {
  it('reads what rpcd will write', () => {
    expect(parseUciChanges('{"changes":[["add","cfg0e92bd","rule"],["set","cfg0e92bd","name","web"],["remove","cfg03dc81"]]}')).toEqual([
      { kind: 'add', section: 'cfg0e92bd', option: 'rule' },
      { kind: 'set', section: 'cfg0e92bd', option: 'name', value: 'web' },
      { kind: 'remove', section: 'cfg03dc81' },
    ]);
    expect(parseUciChanges('{}')).toEqual([]);
  });
});

describe('uciBoolean and uciList', () => {
  it('read options as fw4 does', () => {
    expect(uciBoolean('1', false)).toBe(true);
    expect(uciBoolean('off', true)).toBe(false);
    expect(uciBoolean(undefined, true)).toBe(true);
    expect(uciBoolean('maybe', false)).toBe(false);
    expect(uciList('tcp udp')).toEqual(['tcp', 'udp']);
    expect(uciList(['wan', 'wan6'])).toEqual(['wan', 'wan6']);
    expect(uciList(undefined)).toEqual([]);
  });
});

describe('openwrtFirewall', () => {
  const firewall = openwrtFirewall(parseUciGet('firewall', FIREWALL));

  it('types the zones, forwardings and rules of a fresh OpenWrt', () => {
    expect(firewall.defaults).toMatchObject({ input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', synFlood: true });
    expect(firewall.zones.map(({ section: _, ...zone }) => zone)).toEqual([
      { name: 'lan', networks: ['lan'], devices: [], subnets: [], input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT', masquerade: false, mtuFix: false, log: false, enabled: true },
      { name: 'wan', networks: ['wan', 'wan6'], devices: [], subnets: [], input: 'REJECT', output: 'ACCEPT', forward: 'DROP', masquerade: true, mtuFix: true, log: false, enabled: true },
    ]);
    expect(firewall.forwardings.map(({ src, dest }) => `${src}>${dest}`)).toEqual(['lan>wan']);
    expect(firewall.rules).toHaveLength(9);
    expect(firewall.rules.find((rule) => rule.name === 'Allow-MLD')).toMatchObject({
      src: 'wan',
      dest: undefined,
      protocols: ['icmp'],
      srcIps: ['fe80::/10'],
      icmpTypes: ['130/0', '131/0', '132/0', '143/0'],
      family: 'ipv6',
      target: 'ACCEPT',
      enabled: true,
    });
    expect(firewall.redirects).toEqual([]);
    expect(firewall.other).toEqual([]);
  });

  it('reads a port forward, with NAT loopback on unless it is off, and an IP set', () => {
    const config = parseUciGet(
      'firewall',
      JSON.stringify({
        values: {
          web: { '.anonymous': false, '.type': 'redirect', '.name': 'web', '.index': 0, name: 'Web', src: 'wan', src_dport: '8080', dest: 'lan', dest_ip: '192.168.1.10', dest_port: '80', proto: 'tcp udp' },
          ssh: { '.anonymous': true, '.type': 'redirect', '.name': 'cfg01', '.index': 1, target: 'dnat', reflection: '0', enabled: '0' },
          set: { '.anonymous': true, '.type': 'ipset', '.name': 'cfg02', '.index': 2, name: 'blocked', match: ['src_net'], entry: ['192.0.2.0/24', '198.51.100.7'] },
          inc: { '.anonymous': true, '.type': 'include', '.name': 'cfg03', '.index': 3, path: '/etc/x.nft' },
        },
      }),
    );
    const { redirects, ipsets, other } = openwrtFirewall(config);
    expect(redirects.map(({ section: _, ...redirect }) => redirect)).toEqual([
      { name: 'Web', target: 'DNAT', src: 'wan', srcDport: '8080', dest: 'lan', destIp: '192.168.1.10', destPort: '80', protocols: ['tcp', 'udp'], reflection: true, enabled: true },
      { name: undefined, target: 'DNAT', src: undefined, srcDport: undefined, dest: undefined, destIp: undefined, destPort: undefined, protocols: [], reflection: false, enabled: false },
    ]);
    expect(ipsets.map(({ section: _, ...set }) => set)).toEqual([
      { name: 'blocked', family: 'ipv4', match: ['src_net'], entries: ['192.0.2.0/24', '198.51.100.7'], loadfile: undefined, comment: undefined, enabled: true },
    ]);
    expect(other).toEqual([]);
    expect(openwrtFirewall(config).includes.map(({ section: _, ...include }) => include)).toEqual([
      { type: 'script', path: '/etc/x.nft', position: undefined, chain: undefined, enabled: true, managed: false },
    ]);
  });
});
