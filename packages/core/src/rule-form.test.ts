import { describe, expect, it } from 'vitest';
import basicListing from '../test/fixtures/basic.listing?raw';
import rulesJson from '../test/fixtures/rules.json' with { type: 'json' };
import rulesListing from '../test/fixtures/rules.listing?raw';
import { parseListing, stripHandles } from './listing.ts';
import { ruleKey } from './keys.ts';
import { emptyRule, renderRule, ruleForm, type RuleForm } from './rule-form.ts';
import { parseRuleset } from './ruleset.ts';
import { chainPolicy, chains, editableTable, newChain, newTable, renderTable, withPolicy } from './table-edit.ts';

const ruleset = parseRuleset(rulesJson);
const listing = parseListing(rulesListing);
const rules = ruleset.tables[0]!.chains.flatMap((chain) => chain.rules);
const printed = (handle: number) => listing.rules.get(ruleKey('inet', 't', handle))!;
const form = (handle: number) => ruleForm(rules.find((rule) => rule.handle === handle)!, printed(handle));

describe('ruleForm', () => {
  it('covers the common rules, each rendering back to exactly what nft printed', () => {
    const covered = rules.filter((rule) => ruleForm(rule, printed(rule.handle)) !== undefined).map((rule) => printed(rule.handle));
    expect(covered).toEqual([
      'ct state established,related accept',
      'ct state new tcp dport 22 accept',
      'ct state invalid drop',
      'iif "lo" accept',
      'iifname "eth0" oifname "wg*" accept',
      'ip saddr 10.0.0.0/24 tcp dport { 80, 443 } counter packets 0 bytes 0 accept',
      'ip saddr != 192.168.1.1 udp sport 1000-2000 drop',
      'ip6 daddr fe80::/10 icmpv6 type echo-request accept',
      'ip saddr @admins tcp dport 22 accept comment "ssh from admins"',
      'meta l4proto tcp reject with tcp reset',
      'icmp type echo-request limit rate 5/second burst 5 packets accept',
      'tcp dport 8080 log prefix "web: " level info drop',
      'tcp dport 25 reject',
      'udp dport 53 jump other',
      'tcp dport 3000-3010 goto other',
      'ip daddr 10.0.0.1-10.0.0.9 return',
      'ip saddr 1.2.3.4 counter name "hits" drop',
      'tcp dport 22 ip saddr 10.0.0.1 accept',
      'tcp dport 80 dnat ip to 10.0.0.2:8080',
      'tcp dport 81 redirect to :8081',
      'oifname "eth0" masquerade',
      'ip saddr 10.0.0.0/24 snat ip to 1.2.3.4',
      'iifname { "wg0", "eth0" } accept',
      'oifname != { "eth1", "eth2" } drop',
      'tcp dport != { 80, 443 } drop',
      'ip saddr { 10.0.0.0/24, 192.168.1.10 } accept',
      'icmp type { echo-reply, echo-request } accept',
      'tcp dport { 80, 443, 8000-8080 } counter packets 0 bytes 0 accept',
    ]);
    expect(covered).toHaveLength(rules.length);
  });

  it('reads the fields of a rule', () => {
    expect(form(17)).toEqual({
      ipVersion: 'ip',
      srcAddress: { value: '@admins', negate: false },
      protocol: 'tcp',
      dstPort: { value: '22', negate: false },
      action: { kind: 'accept' },
      comment: 'ssh from admins',
      order: ['srcAddress', 'dstPort', 'action'],
    });
  });

  it('shows several values as a plain list, without the braces of the set', () => {
    expect(form(36)).toMatchObject({ protocol: 'tcp', dstPort: { value: '80, 443', negate: true } });
    expect(form(32)).toMatchObject({ inInterface: { value: 'wg0, eth0', negate: false, byIndex: false } });
    expect(form(40)).toMatchObject({ protocol: 'icmp', icmpType: 'echo-reply, echo-request' });
  });

  it('leaves a rule as text when the form cannot hold all of it', () => {
    expect(basicListing).toContain('tcp dport vmap @port_policy');
    const vmap = { vmap: { key: { payload: { protocol: 'tcp', field: 'dport' } }, data: '@port_policy' } };
    const rule = { family: 'inet' as const, table: 'filter', chain: 'input', handle: 14, expr: [vmap] };
    expect(ruleForm(rule, 'tcp dport vmap @port_policy')).toBeUndefined();
  });
});

describe('renderRule', () => {
  it('keeps the order of existing parts and puts new ones in canonical places', () => {
    const edited: RuleForm = { ...form(26)!, ctState: ['new'], comment: 'admin' };
    expect(renderRule(edited, 'inet')).toBe('ct state new tcp dport 22 ip saddr 10.0.0.1 accept comment "admin"');
  });

  it('builds a new rule from scratch', () => {
    const rule: RuleForm = {
      ...emptyRule(),
      protocol: 'udp',
      dstPort: { value: '53,123', negate: false },
      inInterface: { value: 'eth0', negate: true, byIndex: false },
      ctState: ['related', 'established'],
      counter: true,
      action: { kind: 'accept' },
    };
    expect(renderRule(rule, 'inet')).toBe('ct state established,related iifname != "eth0" udp dport { 53, 123 } counter accept');
    expect(
      renderRule(
        {
          ...emptyRule(),
          srcAddress: { value: '10.0.0.0/24, 192.168.1.10', negate: false },
          inInterface: { value: 'eth0, "wg0"', negate: false, byIndex: false },
          protocol: 'icmp',
          icmpType: 'echo-request, echo-reply',
        },
        'ip',
      ),
    ).toBe('iifname { "eth0", "wg0" } ip saddr { 10.0.0.0/24, 192.168.1.10 } icmp type { echo-request, echo-reply } accept');
    expect(renderRule({ ...emptyRule(), protocol: 'tcp', dstPort: { value: '{ 80, 443 }', negate: true } }, 'inet')).toBe(
      'tcp dport != { 80, 443 } accept',
    );
    expect(renderRule({ ...emptyRule(), protocol: 'tcp', action: { kind: 'reject', with: 'tcp reset' } }, 'inet')).toBe(
      'meta l4proto tcp reject with tcp reset',
    );
  });
});

describe('editableTable', () => {
  it('renders an untouched table exactly as nft lists it, without handles', () => {
    const table = editableTable(rulesListing, 'inet', 't')!;
    expect(renderTable(table)).toBe(stripHandles(rulesListing));
    expect(chains(table).map((chain) => [chain.name, chain.rules.length])).toEqual([
      ['other', 0],
      ['c', 18],
      ['nat', 2],
      ['post', 2],
      ['lists', 6],
    ]);
  });

  it('changes a policy and the rules of a chain, keeping everything else', () => {
    const table = editableTable(basicListing, 'inet', 'filter')!;
    const input = chains(table)[0]!;
    expect(chainPolicy(input)).toBe('drop');
    const edited = withPolicy(input, 'accept');
    edited.rules = [{ handle: undefined, text: 'tcp dport 22 accept' }, ...edited.rules.slice(1)];
    table.parts = table.parts.map((part) => (part.kind === 'chain' && part.chain === input ? { kind: 'chain', chain: edited } : part));
    const text = renderTable(table);
    expect(text).toContain('\t\ttype filter hook input priority filter; policy accept;\n\t\ttcp dport 22 accept\n\t\tiif "lo" accept');
    expect(text).not.toContain('ct state established,related accept');
    expect(text).toContain('\tset admins {');
  });
});

describe('newTable and newChain', () => {
  it('write a new table and its chains the way nft lists them', () => {
    const table = newTable('inet', 'my fw');
    const input = newChain('input', { type: 'filter', hook: 'input', priority: 'filter', policy: 'drop' });
    input.rules.push({ handle: undefined, text: 'iif "lo" accept' });
    const ingress = newChain('in-eth0', { type: 'filter', hook: 'ingress', device: 'eth0', priority: '-150', policy: 'accept' });
    table.parts.splice(2, 0, { kind: 'chain', chain: input }, { kind: 'chain', chain: ingress }, { kind: 'chain', chain: newChain('ssh') });
    expect(renderTable(table)).toBe(
      [
        'table inet "my fw" {',
        '\tcomment "managed by nftm"',
        '\tchain input {',
        '\t\ttype filter hook input priority filter; policy drop;',
        '\t\tiif "lo" accept',
        '\t}',
        '\tchain in-eth0 {',
        '\t\ttype filter hook ingress device "eth0" priority -150; policy accept;',
        '\t}',
        '\tchain ssh {',
        '\t}',
        '}',
        '',
      ].join('\n'),
    );
    expect(chainPolicy(input)).toBe('drop');
  });
});
