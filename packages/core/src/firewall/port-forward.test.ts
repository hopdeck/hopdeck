// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import forwardJson from '../../test/fixtures/forward.json' with { type: 'json' };
import forwardListing from '../../test/fixtures/forward.listing?raw';
import forwardNft from '../../test/fixtures/forward.nft?raw';
import hostJson from '../../test/fixtures/forward-host.json' with { type: 'json' };
import hostListing from '../../test/fixtures/forward-host.listing?raw';
import {
  forwardRules,
  natTables,
  parseForwardComment,
  planPortForward,
  portForwardProblem,
  portForwardProblems,
  portForwards,
  REPLIES_COMMENT,
  type PortForward,
} from './port-forward.ts';
import { parseRuleset } from './ruleset.ts';

/** The forwards test/fixtures/forward.nft was written from. */
const FORWARDS: PortForward[] = [
  {
    name: 'web',
    protocols: ['tcp', 'udp'],
    ports: '80, 8000-8010',
    inInterfaces: ['eth0', 'wg0'],
    target: '192.168.1.10',
    targetPort: '80',
    outInterfaces: ['lan0'],
    sources: '10.0.0.0/24, 192.0.2.1',
    masquerade: false,
    hairpin: '192.168.1.0/24',
    log: true,
    limit: 10,
  },
  { name: 'game server', protocols: ['udp'], ports: '27015', inInterfaces: ['eth0'], externalAddress: '203.0.113.5', target: '192.168.1.20', outInterfaces: [], masquerade: true, log: false },
  {
    name: 'v6',
    protocols: ['tcp'],
    ports: '443',
    inInterfaces: [],
    target: '2001:db8::10',
    targetPort: '8443',
    outInterfaces: [],
    sources: '2001:db8:1::/64',
    masquerade: false,
    hairpin: '2001:db8::/64',
    log: false,
  },
];

/** The rules of the fixture's chain, as written. */
const fixtureRules = (chain: string) => {
  const lines = forwardNft.split('\n');
  const start = lines.indexOf(`\tchain ${chain} {`);
  return lines.slice(start + 2, lines.indexOf('\t}', start)).map((line) => line.trim());
};

describe('forwardRules', () => {
  it('writes what the fixture holds, which nft took as it is', () => {
    const all = FORWARDS.map((forward) => forwardRules(forward, 'inet'));
    expect(all.flatMap((rules) => rules.prerouting)).toEqual(fixtureRules('prerouting'));
    expect(all.flatMap((rules) => rules.forward)).toEqual(fixtureRules('forward'));
    expect(all.flatMap((rules) => rules.postrouting)).toEqual(fixtureRules('postrouting'));
  });

  it('matches the host\'s own addresses when no address is given, so connections passing through are left alone', () => {
    expect(forwardRules(FORWARDS[0]!, 'inet').prerouting[0]).toContain('fib daddr type local');
    expect(forwardRules(FORWARDS[1]!, 'inet').prerouting[0]).toContain('ip daddr 203.0.113.5');
  });

  it('writes DNAT as each family of table takes it', () => {
    expect(forwardRules(FORWARDS[0]!, 'ip').prerouting[0]).toContain('dnat to 192.168.1.10:80');
    expect(forwardRules(FORWARDS[2]!, 'ip6').prerouting[0]).toContain('dnat to [2001:db8::10]:8443');
    expect(forwardRules(FORWARDS[2]!, 'inet').prerouting[0]).toContain('dnat ip6 to [2001:db8::10]:8443');
  });

  it('names each rule\'s forward and part in its comment', () => {
    expect(parseForwardComment('hopdeck forward: game server (masquerade)')).toEqual({ name: 'game server', role: 'masquerade' });
    expect(parseForwardComment('hopdeck forward: web')).toEqual({ name: 'web' });
    expect(parseForwardComment('something else')).toBeUndefined();
  });
});

describe('portForwards', () => {
  const found = portForwards(parseRuleset(forwardJson));
  const sorted = (forward: PortForward | undefined) => forward && { ...forward, inInterfaces: [...forward.inInterfaces].sort() };

  it('reads each forward back from the rules nft printed', () => {
    expect(found.map((entry) => entry.name)).toEqual(['web', 'game server', 'v6', 'by hand']);
    for (const [index, forward] of FORWARDS.entries()) expect(sorted(found[index]!.forward)).toEqual(sorted(forward));
    expect(found[0]!.rules.map((rule) => rule.role ?? 'main')).toEqual(['main', 'hairpin', 'accept', 'hairpin']);
    expect(found[0]!.main).toMatchObject({ family: 'inet', table: 't', chain: 'prerouting' });
  });

  it('reads the protocols nft 0.9.8 prints by number', () => {
    const numbered = JSON.parse(JSON.stringify(forwardJson).replaceAll('{"set":["tcp","udp"]}', '{"set":[6,17]}'));
    expect(JSON.stringify(numbered)).toContain('[6,17]');
    expect(portForwards(parseRuleset(numbered))[0]!.forward?.protocols).toEqual(['tcp', 'udp']);
  });

  it('lists a forward changed by hand, without making one up from it', () => {
    expect(found[3]).toMatchObject({ name: 'by hand', rules: [{ chain: 'other' }] });
    expect(found[3]!.forward).toBeUndefined();
  });
});

describe('portForwardProblem', () => {
  const valid = FORWARDS[0]!;
  it('takes what the form writes, and says what is wrong with what nft would not take', () => {
    for (const forward of FORWARDS) expect(portForwardProblem(forward), forward.name).toBeUndefined();
    expect(portForwardProblem({ ...valid, name: 'a "quote"' })).toEqual({ field: 'name', code: 'name' });
    expect(portForwardProblem({ ...valid, ports: '0' })).toEqual({ field: 'ports', code: 'ports', value: '0' });
    expect(portForwardProblem({ ...valid, ports: '90-80' })).toMatchObject({ field: 'ports' });
    expect(portForwardProblem({ ...valid, targetPort: '80-90' })).toEqual({ field: 'targetPort', code: 'targetPortRange' });
    expect(portForwardProblem({ ...valid, target: 'example.com' })).toEqual({ field: 'target', code: 'target', value: 'example.com' });
    expect(portForwardProblem({ ...valid, externalAddress: '2001:db8::1' })).toEqual({ field: 'externalAddress', code: 'externalAddress', value: '2001:db8::1', version: 'IPv4' });
    expect(portForwardProblem({ ...valid, inInterfaces: ['eth0; drop'] })).toEqual({ field: 'inInterfaces', code: 'interface', value: 'eth0; drop' });
    expect(portForwardProblem({ ...valid, sources: '10.0.0.0/8\naccept' })).toMatchObject({ field: 'sources', code: 'addresses' });
    expect(portForwardProblem({ ...valid, hairpin: '2001:db8::/64' })).toEqual({ field: 'hairpin', code: 'mixed', version: 'IPv4' });
    expect(portForwardProblem({ ...valid, protocols: [] })).toEqual({ field: 'protocols', code: 'protocols' });
  });

  it('says what is wrong with every field at once, for the form to show each at its own', () => {
    const problems = portForwardProblems({ ...valid, name: '', ports: 'x', target: 'nowhere', limit: 0 });
    expect(problems.map((problem) => problem.field)).toEqual(['name', 'ports', 'target', 'limit']);
  });
});

describe('planPortForward', () => {
  const host = parseRuleset(hostJson);
  const web = FORWARDS[0]!;

  it('puts the DNAT in the managed table with the forward chain, and an accept in front of what drops the rest', () => {
    expect(natTables(host, 'ip')).toEqual([
      { family: 'inet', name: 'filter', exists: true },
      { family: 'inet', name: 'hopdeck_forward', exists: false },
    ]);
    const plan = planPortForward(host, hostListing, web);
    expect(plan.changes).toHaveLength(1);
    const [change] = plan.changes;
    expect(change).toMatchObject({ kind: 'replace', family: 'inet', table: 'filter' });
    const definition = change!.kind === 'replace' ? change!.definition : '';
    const lines = definition.split('\n').map((line) => line.trim());
    // A nat chain on prerouting, new, with the DNAT and the hairpin DNAT.
    const prerouting = lines.indexOf('chain prerouting {');
    expect(lines[prerouting + 1]).toBe('type nat hook prerouting priority dstnat; policy accept;');
    expect(lines.slice(prerouting + 2, prerouting + 4)).toEqual(forwardRules(web, 'inet').prerouting);
    // The forward chain: replies first, the accept before "Log drops", which would log the packets as dropped.
    const forward = lines.indexOf('chain forward {');
    expect(lines.slice(forward + 2, forward + 6)).toEqual([
      `ct state established,related accept comment "${REPLIES_COMMENT}"`,
      'iifname "lan0" oifname "eth0" accept',
      forwardRules(web, 'inet').forward[0],
      'counter packets 0 bytes 0 limit rate 50/second burst 100 packets log prefix "hopdeck drop inet filter forward: "',
    ]);
    expect(change!.kind === 'replace' && change!.base).toContain('chain forward {');
    expect(plan.accepted).toEqual([{ family: 'inet', table: 'filter', chain: 'forward' }]);
    expect(plan.replies).toEqual([{ family: 'inet', table: 'filter', chain: 'forward' }]);
    // iptables-nft's table, as Docker leaves it: hopdeck cannot let the packets through there.
    expect(plan.blocked).toEqual([{ family: 'ip', table: 'filter', chain: 'FORWARD' }]);
  });

  it('makes a managed table of its own when asked, with what nat needs', () => {
    const plan = planPortForward(host, hostListing, FORWARDS[1]!, { natTable: { family: 'inet', name: 'hopdeck_forward', exists: false } });
    const created = plan.changes.find((change) => change.table === 'hopdeck_forward')!;
    expect(created.kind === 'replace' && created.base).toBeUndefined();
    const definition = created.kind === 'replace' ? created.definition : '';
    expect(definition).toContain('comment "managed by hopdeck"');
    expect(definition).toContain('type nat hook prerouting priority dstnat; policy accept;');
    expect(definition).toContain('type nat hook postrouting priority srcnat; policy accept;');
    expect(plan.changes.map((change) => change.table).sort()).toEqual(['filter', 'hopdeck_forward']);
  });

  it('changes a forward in place of the old one, and removes it with all its rules', () => {
    const ruleset = parseRuleset(forwardJson);
    const changed = planPortForward(ruleset, forwardListing, { ...web, ports: '8080' }, { replacing: 'web', natTable: { family: 'inet', name: 't', exists: true } });
    const definition = changed.changes[0]!.kind === 'replace' ? changed.changes[0]!.definition : '';
    expect(definition.match(/hopdeck forward: web\b/g)).toHaveLength(4);
    expect(definition).toContain('th dport 8080');
    expect(definition).not.toContain('8000-8010');
    // The accept on forward does not change with the external ports: it stays as nft listed it, its counter too.
    expect(definition).toContain('oifname "lan0" ip daddr 192.168.1.10 meta l4proto { tcp, udp } th dport 80 ct status dnat counter packets 0 bytes 0 accept comment "hopdeck forward: web (accept)"');
    // Nothing to change, nothing to deploy: where replies are let through already, the same forward again changes nothing.
    const withReplies = forwardListing.replace('policy drop;\n', 'policy drop;\n\t\tct state established,related accept # handle 99\n');
    expect(planPortForward(ruleset, withReplies, FORWARDS[1]!, { replacing: 'game server', natTable: { family: 'inet', name: 't', exists: true } }).changes).toEqual([]);

    const removed = planPortForward(ruleset, forwardListing, undefined, { replacing: 'web' });
    const left = removed.changes[0]!.kind === 'replace' ? removed.changes[0]!.definition : '';
    expect(left).not.toContain('hopdeck forward: web');
    expect(left).toContain('hopdeck forward: game server');
    expect(removed.accepted).toEqual([]);
  });

  it('leaves a forward chain with replies let through as it begins', () => {
    const plan = planPortForward(parseRuleset(forwardJson), forwardListing, { ...web, name: 'second' }, { natTable: { family: 'inet', name: 't', exists: true } });
    expect(plan.replies).toEqual([{ family: 'inet', table: 't', chain: 'forward' }]);
    // The fixture's forward chain has no rule for replies: so one is added; with one, none would be.
    const again = planPortForward(parseRuleset(hostJson), hostListing.replace('iifname "lan0" oifname "eth0" accept', 'ct state established,related accept'), web);
    expect(again.replies).toEqual([]);
  });
});
