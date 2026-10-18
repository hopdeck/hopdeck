// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import firewallJson from '../../test/fixtures/openwrt/firewall-25.12.json' with { type: 'json' };
import { openwrtFirewall } from './firewall.ts';
import {
  deleteZoneChanges,
  redirectChanges,
  redirectForm,
  redirectProblems,
  trafficRuleChanges,
  trafficRuleForm,
  trafficRuleProblems,
  zoneChanges,
  zoneForm,
  zoneProblems,
} from './firewall-edit.ts';
import { addUciChange, nextRef, previewUci } from './uci-edit.ts';
import { parseUciGet, type UciChange } from './uci.ts';

const config = parseUciGet('firewall', JSON.stringify(firewallJson));
const firewall = openwrtFirewall(config);
const [lan, wan] = firewall.zones;
const ping = firewall.rules.find((rule) => rule.name === 'Allow-Ping')!;

describe('zones', () => {
  it('fills the form from the zone and its forwardings', () => {
    expect(zoneForm(firewall, lan)).toEqual({
      name: 'lan',
      networks: ['lan'],
      input: 'ACCEPT',
      output: 'ACCEPT',
      forward: 'ACCEPT',
      masquerade: false,
      mtuFix: false,
      log: false,
      forwardTo: ['wan'],
    });
  });

  it('writes what changed, and adds or removes forwardings', () => {
    const form = { ...zoneForm(firewall, wan), masquerade: false, log: true, forwardTo: ['lan'] };
    expect(zoneChanges(firewall, wan, form, 'new-1')).toEqual([
      { kind: 'set', section: wan!.section.name, values: { log: '1' } },
      { kind: 'unset', section: wan!.section.name, options: ['masq'] },
      { kind: 'add', type: 'forwarding', ref: 'new-1-fwd-1', values: { src: 'wan', dest: 'lan' } },
    ]);
    expect(zoneChanges(firewall, lan, { ...zoneForm(firewall, lan), forwardTo: [] }, 'new-1')).toEqual([
      { kind: 'delete', section: firewall.forwardings[0]!.section.name },
    ]);
  });

  it('renames the zone where rules, port forwards and forwardings name it', () => {
    const changes = zoneChanges(firewall, wan, { ...zoneForm(firewall, wan), name: 'internet' }, 'new-1');
    expect(changes[0]).toEqual({ kind: 'set', section: wan!.section.name, values: { name: 'internet' } });
    // The forwarding lan > wan, and all nine rules from wan.
    expect(changes.filter((change) => change.kind === 'set' && change.values['dest'] === 'internet')).toHaveLength(1);
    expect(changes.filter((change) => change.kind === 'set' && change.values['src'] === 'internet')).toHaveLength(9);
  });

  it('removes a zone with its forwardings, unless rules still name it', () => {
    expect(deleteZoneChanges(firewall, wan!)).toEqual({ changes: [], usedBy: expect.arrayContaining(['Allow-Ping', 'Allow-ISAKMP']) });
    const bare = openwrtFirewall({ ...config, sections: config.sections.filter((section) => section.type !== 'rule') });
    expect(deleteZoneChanges(bare, bare.zones[1]!)).toEqual({
      changes: [
        { kind: 'delete', section: bare.zones[1]!.section.name },
        { kind: 'delete', section: bare.forwardings[0]!.section.name },
      ],
      usedBy: [],
    });
  });

  it('takes names LuCI takes, once', () => {
    expect(zoneProblems(firewall, undefined, { ...zoneForm(firewall, undefined), name: 'guest' })).toEqual([]);
    expect(zoneProblems(firewall, undefined, { ...zoneForm(firewall, undefined), name: 'lan' })).toEqual([{ field: 'name', code: 'zone-taken', value: 'lan' }]);
    expect(zoneProblems(firewall, undefined, { ...zoneForm(firewall, undefined), name: 'very-long-name' })).toEqual([
      { field: 'name', code: 'zone-name', value: 'very-long-name' },
    ]);
    expect(zoneProblems(firewall, lan, zoneForm(firewall, lan))).toEqual([]);
  });
});

describe('rules', () => {
  it('reads a rule into the form and writes back only what changed', () => {
    const form = trafficRuleForm(ping);
    expect(form).toMatchObject({ name: 'Allow-Ping', family: 'ipv4', protocols: ['icmp'], src: 'wan', dest: '', icmpTypes: ['echo-request'], target: 'ACCEPT' });
    expect(trafficRuleChanges(ping, form, 'new-1')).toEqual([]);
    expect(trafficRuleChanges(ping, { ...form, enabled: false, target: 'DROP' }, 'new-1')).toEqual([
      { kind: 'set', section: ping.section.name, values: { enabled: '0', target: 'DROP' } },
    ]);
  });

  it('adds a rule, leaving out what is empty', () => {
    expect(trafficRuleChanges(undefined, { ...trafficRuleForm(undefined), name: 'SSH', destPort: '22' }, 'new-1')).toEqual([
      { kind: 'add', type: 'rule', ref: 'new-1', values: { name: 'SSH', proto: ['tcp'], src: 'wan', dest_port: '22', target: 'ACCEPT' } },
    ]);
  });

  it('says what is wrong at each field', () => {
    const form = { ...trafficRuleForm(undefined), destPort: '22 1000-2000', srcIps: ['192.0.2.0/24', '!10.0.0.1'] };
    expect(trafficRuleProblems(form)).toEqual([]);
    expect(trafficRuleProblems({ ...form, destPort: '99999' })).toEqual([{ field: 'destPort', code: 'ports', value: '99999' }]);
    expect(trafficRuleProblems({ ...form, protocols: ['icmp'] })).toEqual([{ field: 'destPort', code: 'ports-protocol' }]);
    expect(trafficRuleProblems({ ...form, srcIps: ['10.0.0.0/33'] })).toEqual([{ field: 'srcIps', code: 'address', value: '10.0.0.0/33' }]);
    expect(trafficRuleProblems({ ...form, family: 'ipv6' })).toEqual([{ field: 'srcIps', code: 'family' }]);
    expect(trafficRuleProblems({ ...form, icmpTypes: ['echo-request'] })).toEqual([{ field: 'icmpTypes', code: 'icmp-protocol' }]);
  });
});

describe('port forwards', () => {
  it('starts from wan to lan, and writes a DNAT redirect', () => {
    const form = { ...redirectForm(undefined, ['lan', 'wan']), name: 'Web', srcDport: '8080', destIp: '192.168.1.10', destPort: '80' };
    expect(form).toMatchObject({ src: 'wan', dest: 'lan', reflection: true, protocols: ['tcp'] });
    expect(redirectProblems(form)).toEqual([]);
    expect(redirectChanges(undefined, form, 'new-1')).toEqual([
      {
        kind: 'add',
        type: 'redirect',
        ref: 'new-1',
        values: { name: 'Web', target: 'DNAT', proto: ['tcp'], src: 'wan', src_dport: '8080', dest: 'lan', dest_ip: '192.168.1.10', dest_port: '80' },
      },
    ]);
    expect(redirectChanges(undefined, { ...form, reflection: false }, 'new-1')[0]).toMatchObject({ values: { reflection: '0' } });
  });

  it('wants a port and an address to forward to', () => {
    const form = redirectForm(undefined, ['lan', 'wan']);
    expect(redirectProblems(form).map((problem) => problem.field)).toEqual(['srcDport', 'destIp']);
    expect(redirectProblems({ ...form, srcDport: '80', destIp: 'host' })).toEqual([{ field: 'destIp', code: 'address', value: 'host' }]);
  });
});

describe('collected and previewed', () => {
  it('a new zone with a forwarding, shown as the router will have it', () => {
    let changes: UciChange[] = [];
    const ref = nextRef(changes);
    for (const change of zoneChanges(firewall, undefined, { ...zoneForm(firewall, undefined), name: 'guest', networks: ['guest'], forwardTo: ['wan'] }, ref)) {
      changes = addUciChange(config, changes, change);
    }
    expect(nextRef(changes)).toBe('new-2');
    const preview = openwrtFirewall(previewUci(config, changes));
    expect(preview.zones.map((zone) => zone.name)).toEqual(['lan', 'wan', 'guest']);
    expect(preview.forwardings.map((forwarding) => `${forwarding.src}>${forwarding.dest}`)).toEqual(['lan>wan', 'guest>wan']);
  });
});
