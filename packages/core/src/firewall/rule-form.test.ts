// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import basicListing from '../../test/fixtures/basic.listing?raw';
import rulesJson from '../../test/fixtures/rules.json' with { type: 'json' };
import rulesListing from '../../test/fixtures/rules.listing?raw';
import { parseListing, stripHandles } from './listing.ts';
import { ruleKey } from './keys.ts';
import { emptyRule, renderRule, ruleForm, type RuleForm } from './rule-form.ts';
import { parseRuleset } from './ruleset.ts';
import { chainPolicy, chains, editableTable, editSetBlock, newChain, newSetBlock, newTable, refreshUntouched, renderTable, setSpecOf, withPolicy } from './table-edit.ts';

const ruleset = parseRuleset(rulesJson);
const listing = parseListing(rulesListing);
const rules = ruleset.tables[0]!.chains.flatMap((chain) => chain.rules);
const printed = (handle: number) => listing.rules.get(ruleKey('inet', 't', handle))!;
/** The form of the fixture rule nft printed as `text`; handles shift whenever the fixture grows. */
const form = (text: string) => {
  const rule = rules.find((candidate) => printed(candidate.handle) === text);
  if (rule === undefined) throw new Error(`no rule "${text}" in the fixture`);
  return ruleForm(rule, text);
};

describe('ruleForm', () => {
  it('covers every rule of the fixture, each rendering back to exactly what nft printed', () => {
    const uncovered = rules.filter((rule) => ruleForm(rule, printed(rule.handle)) === undefined).map((rule) => printed(rule.handle));
    expect(uncovered).toEqual([]);
    expect(rules.length).toBeGreaterThan(60);
  });

  it('reads the fields of a rule', () => {
    expect(form('ip saddr @admins tcp dport 22 accept comment "ssh from admins"')).toEqual({
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
    expect(form('tcp dport != { 80, 443 } drop')).toMatchObject({ protocol: 'tcp', dstPort: { value: '80, 443', negate: true } });
    expect(form('iifname { "wg0", "eth0" } accept')).toMatchObject({ inInterface: { value: 'wg0, eth0', negate: false, byIndex: false } });
    expect(form('icmp type { echo-reply, echo-request } accept')).toMatchObject({ protocol: 'icmp', icmpType: 'echo-reply, echo-request' });
  });

  it('reads TCP flags in each of the ways nft writes them', () => {
    expect(form('tcp flags syn accept')?.tcpFlags).toEqual({ set: ['syn'], unset: [], any: true });
    expect(form('tcp flags ! syn,ack drop')?.tcpFlags).toEqual({ set: [], unset: ['syn', 'ack'] });
    expect(form('tcp flags & (fin | syn | rst | ack) == syn accept')?.tcpFlags).toEqual({ set: ['syn'], unset: ['fin', 'rst', 'ack'] });
    expect(form('tcp flags == 0x12 accept')?.tcpFlags).toEqual({ set: ['syn', 'ack'], unset: ['fin', 'rst', 'psh', 'urg', 'ecn', 'cwr'] });
  });

  it('reads limits, quotas, marks and per-source limits', () => {
    expect(form('limit rate 100 kbytes/second burst 500 kbytes accept')?.limit).toEqual({ rate: 100, per: 'second', unit: 'kbytes', burst: 500, burstUnit: 'kbytes' });
    expect(form('limit rate over 10/second burst 5 packets drop')?.limit).toEqual({ rate: 10, per: 'second', burst: 5, over: true });
    expect(form('quota over 1000 mbytes drop')?.quota).toEqual({ amount: 1000, unit: 'mbytes', over: true });
    expect(form('ct mark set 0x00000002 accept')?.markSet).toEqual({ target: 'ct', value: '0x00000002' });
    expect(form('update @dyn { ip saddr timeout 1m limit rate over 5/minute burst 3 packets } drop')?.keyedLimit).toEqual({
      verb: 'update',
      set: 'dyn',
      key: 'ip saddr',
      timeout: '1m',
      limit: { rate: 5, per: 'minute', burst: 3, over: true },
    });
    expect(form('tcp dport vmap { 22 : accept, 80 : jump other, 443 : drop }')?.action).toEqual({
      kind: 'vmap',
      key: 'tcp dport',
      map: '{ 22 : accept, 80 : jump other, 443 : drop }',
    });
  });

  it('leaves a rule as text when the form cannot hold all of it', () => {
    const copyMark = { mangle: { key: { ct: { key: 'mark' } }, value: { meta: { key: 'mark' } } } };
    const rule = { family: 'inet' as const, table: 'filter', chain: 'input', handle: 14, expr: [copyMark] };
    expect(ruleForm(rule, 'ct mark set meta mark')).toBeUndefined();
  });
});

describe('renderRule', () => {
  it('keeps the order of existing parts and puts new ones in canonical places', () => {
    const edited: RuleForm = { ...form('tcp dport 22 ip saddr 10.0.0.1 accept')!, ctState: ['new'], comment: 'admin' };
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
      ['more', 33],
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
    const table = newTable('inet', 'my_fw');
    const input = newChain('input', { type: 'filter', hook: 'input', priority: 'filter', policy: 'drop' });
    input.rules.push({ handle: undefined, text: 'iif "lo" accept' });
    const ingress = newChain('in-eth0', { type: 'filter', hook: 'ingress', device: 'eth0', priority: '-150', policy: 'accept' });
    table.parts.splice(2, 0, { kind: 'chain', chain: input }, { kind: 'chain', chain: ingress }, { kind: 'chain', chain: newChain('ssh') });
    expect(renderTable(table)).toBe(
      [
        'table inet my_fw {',
        '\tcomment "managed by hopdeck"',
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

  it('keeps sets and other named objects as whole blocks', () => {
    const table = editableTable(basicListing, 'inet', 'filter')!;
    const blocks = table.parts.flatMap((part) => (part.kind === 'block' ? [`${part.block.kind} ${part.block.name} ${part.block.lines.length}`] : []));
    expect(blocks).toEqual([
      'counter web 3',
      'quota monthly 3',
      'limit slow 3',
      'ct helper ftp 4',
      'synproxy syn 4',
      'set admins 5',
      'map port_policy 5',
      'flowtable fast 4',
    ]);
    const listed = stripHandles(basicListing);
    expect(renderTable(table)).toBe(listed.slice(0, listed.indexOf('\n}\n') + 3));
  });

  it('writes a new set or map as nft lists it', () => {
    expect(newSetBlock({ kind: 'set', name: 'ban', type: 'ipv4_addr', flags: ['interval', 'timeout'], timeout: '1h', counter: true, elements: ['10.0.0.0/24'] }).lines).toEqual([
      '\tset ban {',
      '\t\ttype ipv4_addr',
      '\t\tflags interval,timeout',
      '\t\tcounter',
      '\t\ttimeout 1h',
      '\t\telements = { 10.0.0.0/24 }',
      '\t}',
    ]);
    expect(newSetBlock({ kind: 'map', name: 'm', type: 'ifname', value: 'verdict', flags: [], counter: false, elements: [] }).lines).toEqual([
      '\tmap m {',
      '\t\ttype ifname : verdict',
      '\t}',
    ]);
  });
});

describe('setSpecOf and editSetBlock', () => {
  const dyn = { kind: 'set', name: 'dyn', lines: ['\tset dyn {', '\t\ttype ipv4_addr', '\t\tsize 65535', '\t\tflags dynamic,timeout', '\t\ttimeout 1m', '\t\telements = { 1.1.1.1 expires 30s,', '\t\t\t     2.2.2.2 expires 10s }', '\t}'] };

  it('reads what the dialog shows', () => {
    expect(setSpecOf(dyn)).toEqual({
      kind: 'set',
      name: 'dyn',
      type: 'ipv4_addr',
      flags: ['dynamic', 'timeout'],
      timeout: '1m',
      counter: false,
      elements: ['1.1.1.1 expires 30s', '2.2.2.2 expires 10s'],
    });
  });

  it('changes lines in place and keeps what it does not know', () => {
    expect(editSetBlock(dyn, setSpecOf(dyn)!)).toEqual(dyn);
    const edited = editSetBlock(dyn, { ...setSpecOf(dyn)!, timeout: '5m', counter: true, elements: ['1.1.1.1'] });
    expect(edited.lines).toEqual([
      '\tset dyn {',
      '\t\ttype ipv4_addr',
      '\t\tsize 65535',
      '\t\tflags dynamic,timeout',
      '\t\tcounter',
      '\t\ttimeout 5m',
      '\t\telements = { 1.1.1.1 }',
      '\t}',
    ]);
    const map = { kind: 'map', name: 'm', lines: ['\tmap m {', '\t\ttype inet_service : verdict', '\t}'] };
    expect(editSetBlock(map, { ...setSpecOf(map)!, value: 'ipv4_addr', flags: ['interval'] }).lines).toEqual([
      '\tmap m {',
      '\t\ttype inet_service : ipv4_addr',
      '\t\tflags interval',
      '\t}',
    ]);
  });
});

describe('refreshUntouched', () => {
  const table = (block: string, rule: string) => `table inet t {\n${block}\n\n\tchain c {\n\t\t${rule}\n\t}\n}\n`;
  const set = (elements: string) => `\tset s {\n\t\ttype ipv4_addr\n\t\tflags timeout\n\t\telements = { ${elements} }\n\t}`;

  it('takes objects the user did not touch from the host as it is now', () => {
    const base = table(set('1.1.1.1 expires 50m, 2.2.2.2 expires 1m'), 'accept');
    const now = table(set('1.1.1.1 expires 40m'), 'accept');
    const definition = table(set('1.1.1.1 expires 50m, 2.2.2.2 expires 1m'), 'drop');
    expect(refreshUntouched(definition, base, now, 'inet', 't')).toBe(table(set('1.1.1.1 expires 40m'), 'drop'));
  });

  it('keeps what the user changed, and anything it cannot take apart', () => {
    const base = table(set('1.1.1.1'), 'accept');
    const now = table(set('3.3.3.3'), 'accept');
    const definition = table(set('1.1.1.1, 9.9.9.9'), 'accept');
    expect(refreshUntouched(definition, base, now, 'inet', 't')).toBe(definition);
    const odd = `${definition}# trailing comment\n`;
    expect(refreshUntouched(odd, base, now, 'inet', 't')).toBe(odd);
  });
});
