// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import firewallJson from '../../test/fixtures/openwrt/firewall-25.12.json' with { type: 'json' };
import { openwrtFirewall } from './firewall.ts';
import {
  deleteIpSetChanges,
  includeChanges,
  includeForm,
  includePath,
  includeProblems,
  includeVersion,
  deleteZoneChanges,
  natChanges,
  natForm,
  natProblems,
  ipSetChanges,
  ipSetForm,
  ipSetProblems,
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

  it('changes only what changed in a redirect that leaves defaults out', () => {
    const config = parseUciGet(
      'firewall',
      JSON.stringify({ values: { web: { '.anonymous': true, '.type': 'redirect', '.name': 'cfg01', '.index': 0, name: 'Web', src: 'wan', src_dport: '8080', dest: 'lan', dest_ip: '192.168.1.10' } } }),
    );
    const redirect = openwrtFirewall(config).redirects[0]!;
    expect(redirectChanges(redirect, redirectForm(redirect, ['lan', 'wan']), 'new-1')).toEqual([]);
    expect(redirectChanges(redirect, { ...redirectForm(redirect, ['lan', 'wan']), enabled: false }, 'new-1')).toEqual([
      { kind: 'set', section: 'cfg01', values: { enabled: '0' } },
    ]);
  });

  it('wants a port and an address to forward to', () => {
    const form = redirectForm(undefined, ['lan', 'wan']);
    expect(redirectProblems(form).map((problem) => problem.field)).toEqual(['srcDport', 'destIp']);
    expect(redirectProblems({ ...form, srcDport: '80', destIp: 'host' })).toEqual([{ field: 'destIp', code: 'address', value: 'host' }]);
  });
});

describe('NAT rules', () => {
  const withNat = parseUciGet(
    'firewall',
    JSON.stringify({
      values: {
        wan: { '.anonymous': true, '.type': 'zone', '.name': 'cfg01', '.index': 0, name: 'wan', network: ['wan'], masq: '1' },
        vpn: { '.anonymous': true, '.type': 'nat', '.name': 'cfg02', '.index': 1, name: 'Office', src: 'wan', src_ip: '192.168.1.0/24', dest_ip: '10.8.0.0/16' },
        snat: { '.anonymous': true, '.type': 'nat', '.name': 'cfg03', '.index': 2, src: 'wan', target: 'SNAT', src_ip: '192.168.1.20', snat_ip: '203.0.113.5' },
      },
    }),
  );
  const nats = openwrtFirewall(withNat);
  const [office, fixed] = nats.nats;

  it('reads the rules, masquerading where they do not say', () => {
    expect(office).toMatchObject({ name: 'Office', src: 'wan', target: 'MASQUERADE', srcIp: '192.168.1.0/24', destIp: '10.8.0.0/16', protocols: [] });
    expect(fixed).toMatchObject({ name: undefined, target: 'SNAT', snatIp: '203.0.113.5' });
  });

  it('starts from wan, masquerading all protocols, and says the target it writes', () => {
    const form = { ...natForm(undefined, ['lan', 'wan']), name: 'Guests', srcIp: '192.168.2.0/24' };
    expect(natProblems(form)).toEqual([]);
    expect(natChanges(undefined, form, 'new-1')).toEqual([
      { kind: 'add', type: 'nat', ref: 'new-1', values: { name: 'Guests', src: 'wan', src_ip: '192.168.2.0/24', target: 'MASQUERADE' } },
    ]);
  });

  it('leaves out the target a rule left out, and the rewrite of a target that has none', () => {
    expect(natChanges(office, natForm(office, ['wan']), 'new-1')).toEqual([]);
    expect(natChanges(office, { ...natForm(office, ['wan']), target: 'ACCEPT', snatIp: '203.0.113.9' }, 'new-1')).toEqual([
      { kind: 'set', section: 'cfg02', values: { target: 'ACCEPT' } },
    ]);
    expect(natChanges(fixed, { ...natForm(fixed, ['wan']), target: 'MASQUERADE' }, 'new-1')).toEqual([
      { kind: 'set', section: 'cfg03', values: { target: 'MASQUERADE' } },
      { kind: 'unset', section: 'cfg03', options: ['snat_ip'] },
    ]);
  });

  it('wants what fw4 wants: an address or port for SNAT, TCP or UDP for ports, one family', () => {
    const form = { ...natForm(undefined, ['wan']), target: 'SNAT' };
    expect(natProblems(form)).toEqual([{ field: 'snatIp', code: 'snat-needs' }]);
    expect(natProblems({ ...form, snatPort: '1000-2000', protocols: ['icmp'] })).toEqual([{ field: 'snatPort', code: 'ports-tcpudp' }]);
    expect(natProblems({ ...form, snatPort: '1000 2000' })).toEqual([{ field: 'snatPort', code: 'ports', value: '1000 2000' }]);
    expect(natProblems({ ...form, snatIp: '203.0.113.0/24' })).toEqual([{ field: 'snatIp', code: 'address', value: '203.0.113.0/24' }]);
    expect(natProblems({ ...form, snatIp: '2001:db8::1', srcIp: '192.168.1.0/24' })).toEqual([{ field: 'family', code: 'families' }]);
    expect(natProblems({ ...form, snatIp: '2001:db8::1', family: 'ipv4' })).toEqual([{ field: 'family', code: 'family' }]);
    expect(natProblems({ ...form, snatIp: '203.0.113.5', destPort: '53', protocols: ['all'], device: 'eth1' })).toEqual([]);
    expect(natProblems({ ...form, snatIp: '203.0.113.5', device: 'a very long name' }).map((problem) => problem.code)).toEqual(['device']);
  });

  it('follows a renamed zone, and keeps a zone they leave through', () => {
    const wan = nats.zones[0]!;
    expect(zoneChanges(nats, wan, { ...zoneForm(nats, wan), name: 'internet' }, 'new-1').filter((change) => change.kind === 'set' && change.section !== 'cfg01')).toEqual([
      { kind: 'set', section: 'cfg02', values: { src: 'internet' } },
      { kind: 'set', section: 'cfg03', values: { src: 'internet' } },
    ]);
    expect(deleteZoneChanges(nats, wan).usedBy).toEqual(['Office', 'cfg03']);
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

describe('IP sets', () => {
  const withSet = parseUciGet(
    'firewall',
    JSON.stringify({
      values: {
        set: { '.anonymous': true, '.type': 'ipset', '.name': 'cfg01', '.index': 0, name: 'blocked', match: ['src_net'], entry: ['192.0.2.0/24'] },
        drop: { '.anonymous': true, '.type': 'rule', '.name': 'cfg02', '.index': 1, name: 'Drop blocked', src: 'wan', ipset: 'blocked', target: 'DROP' },
        other: { '.anonymous': true, '.type': 'rule', '.name': 'cfg03', '.index': 2, name: 'Not blocked', src: 'wan', ipset: '!blocked src', target: 'ACCEPT' },
      },
    }),
  );
  const sets = openwrtFirewall(withSet);
  const blocked = sets.ipsets[0]!;

  it('adds a set of networks, saying its family', () => {
    const form = { ...ipSetForm(undefined), name: 'bad', entries: ['203.0.113.0/24', '198.51.100.7'] };
    expect(ipSetProblems(sets, undefined, form)).toEqual([]);
    expect(ipSetChanges(sets, undefined, form, 'new-1')).toEqual([
      { kind: 'add', type: 'ipset', ref: 'new-1', values: { name: 'bad', family: 'ipv4', match: ['src_net'], entry: ['203.0.113.0/24', '198.51.100.7'] } },
    ]);
  });

  it('changes only entries, leaving out the family fw4 takes by default', () => {
    expect(ipSetChanges(sets, blocked, { ...ipSetForm(blocked), entries: ['192.0.2.0/24', '10.0.0.0/8'] }, 'new-1')).toEqual([
      { kind: 'set', section: 'cfg01', values: { entry: ['192.0.2.0/24', '10.0.0.0/8'] } },
    ]);
  });

  it('renames the set where rules use it, keeping "!" and the direction', () => {
    expect(ipSetChanges(sets, blocked, { ...ipSetForm(blocked), name: 'banned' }, 'new-1')).toEqual([
      { kind: 'set', section: 'cfg01', values: { name: 'banned' } },
      { kind: 'set', section: 'cfg02', values: { ipset: 'banned' } },
      { kind: 'set', section: 'cfg03', values: { ipset: '!banned src' } },
    ]);
  });

  it('is not removed while rules use it', () => {
    expect(deleteIpSetChanges(sets, blocked)).toEqual({ changes: [], usedBy: ['Drop blocked', 'Not blocked'] });
  });

  it('checks entries against what the set holds', () => {
    const form = ipSetForm(blocked);
    expect(ipSetProblems(sets, blocked, { ...form, entries: ['192.0.2.0/24', 'fe80::/10'] })).toEqual([{ field: 'entries', code: 'entry', value: 'fe80::/10' }]);
    expect(ipSetProblems(sets, blocked, { ...form, match: ['dest_port'], entries: ['80', '8000-8080', 'http'] })).toEqual([{ field: 'entries', code: 'entry', value: 'http' }]);
    expect(ipSetProblems(sets, blocked, { ...form, match: ['src_mac'], entries: ['aa:bb:cc:dd:ee:ff'] })).toEqual([]);
    expect(ipSetProblems(sets, undefined, { ...form, name: 'blocked' })).toEqual([{ field: 'name', code: 'set-taken', value: 'blocked' }]);
    expect(ipSetProblems(sets, undefined, { ...form, name: 'two words' })).toEqual([{ field: 'name', code: 'set-name', value: 'two words' }]);
  });

  it('lets a rule match a set there is', () => {
    expect(trafficRuleForm(sets.rules[1]).ipset).toBe('!blocked src');
    expect(trafficRuleProblems({ ...trafficRuleForm(undefined), ipset: '!nope' }, ['blocked'])).toEqual([{ field: 'ipset', code: 'set-unknown', value: 'nope' }]);
    expect(trafficRuleChanges(undefined, { ...trafficRuleForm(undefined), name: 'x', ipset: 'blocked' }, 'new-2')[0]).toMatchObject({ values: { ipset: 'blocked' } });
  });
});

describe('nftables includes', () => {
  const withInclude = parseUciGet(
    'firewall',
    JSON.stringify({
      values: {
        hopdeck_ssh: { '.anonymous': false, '.type': 'include', '.name': 'hopdeck_ssh', '.index': 0, type: 'nftables', path: '/etc/hopdeck/fw4/ssh.3.nft', position: 'chain-pre', chain: 'input_wan' },
        old: { '.anonymous': true, '.type': 'include', '.name': 'cfg02', '.index': 1, path: '/etc/firewall.user' },
      },
    }),
  );
  const firewall = openwrtFirewall(withInclude);
  const [ssh, user] = firewall.includes;

  it('knows its own includes from others', () => {
    expect(ssh).toMatchObject({ type: 'nftables', position: 'chain-pre', chain: 'input_wan', managed: true });
    expect(user).toMatchObject({ type: 'script', managed: false });
    expect(includeVersion(ssh!.path)).toBe(3);
    expect(includeVersion('/etc/firewall.user')).toBeUndefined();
  });

  it('adds a named section and the first file', () => {
    const form = { ...includeForm(undefined, 'tcp dport 22 accept\n'), name: 'web' };
    expect(includeProblems(firewall, undefined, form)).toEqual([]);
    expect(includeChanges(undefined, form, { committedPath: undefined, contentChanged: true })).toEqual({
      changes: [{ kind: 'add', type: 'include', name: 'hopdeck_web', values: { type: 'nftables', path: includePath('web', 1), position: 'chain-pre', chain: 'input' } }],
      file: { path: '/etc/hopdeck/fw4/web.1.nft', content: 'tcp dport 22 accept\n' },
    });
  });

  it('writes new content to the next version, however often it is edited before review', () => {
    const form = { ...includeForm(ssh, 'old'), content: 'tcp dport 2222 accept\n' };
    const first = includeChanges(ssh, form, { committedPath: ssh!.path, contentChanged: true });
    expect(first).toEqual({
      changes: [{ kind: 'set', section: 'hopdeck_ssh', values: { path: '/etc/hopdeck/fw4/ssh.4.nft' } }],
      file: { path: '/etc/hopdeck/fw4/ssh.4.nft', content: 'tcp dport 2222 accept\n' },
    });
    const pending = { ...ssh!, path: '/etc/hopdeck/fw4/ssh.4.nft', section: { ...ssh!.section, options: { ...ssh!.section.options, path: '/etc/hopdeck/fw4/ssh.4.nft' } } };
    expect(includeChanges(pending, { ...form, content: 'again' }, { committedPath: ssh!.path, contentChanged: true }).file).toEqual({ path: '/etc/hopdeck/fw4/ssh.4.nft', content: 'again\n' });
    // Moved without new content, it keeps its file.
    expect(includeChanges(ssh, { ...form, position: 'chain-post' }, { committedPath: ssh!.path, contentChanged: false })).toEqual({
      changes: [{ kind: 'set', section: 'hopdeck_ssh', values: { position: 'chain-post' } }],
    });
  });

  it('ends the file with a line break, as fw4 puts it in as it is', () => {
    expect(includeChanges(undefined, { ...includeForm(undefined, 'tcp dport 22 accept'), name: 'x' }, { committedPath: undefined, contentChanged: true }).file?.content).toBe('tcp dport 22 accept\n');
  });

  it('wants a free name, a chain for a chain, and content', () => {
    const form = includeForm(undefined, '');
    expect(includeProblems(firewall, undefined, { ...form, name: 'ssh', chain: '' }).map((problem) => problem.code)).toEqual(['include-taken', 'required', 'content']);
    expect(includeProblems(firewall, undefined, { ...form, name: 'Bad-Name', content: 'x' })).toEqual([{ field: 'name', code: 'include-name', value: 'Bad-Name' }]);
  });
});
