import { editableTable, emptyRule, findTable, renderRule, renderTable } from '@nftm/core';
import { describe, expect, it } from 'vitest';
import basicJson from '../../../core/test/fixtures/basic.json' with { type: 'json' };
import basicListing from '../../../core/test/fixtures/basic.listing?raw';
import rulesJson from '../../../core/test/fixtures/rules.json' with { type: 'json' };
import rulesListing from '../../../core/test/fixtures/rules.listing?raw';
import { buildModel } from '../ruleset/model.ts';
import { addedChain, definitionOf, initialChains, liveSource, newTableSource, type ChainState } from './table-model.ts';

const model = buildModel({ json: rulesJson, listing: rulesListing, readAt: '2026-09-25T12:00:00Z' });
const node = findTable(model.ruleset, 'inet', 't')!;
const table = editableTable(model.text, 'inet', 't')!;
const chainsOf = () => initialChains(table, node, model);
const byName = (chains: ChainState[], name: string) => chains.find((state) => state.chain.name === name)!;

/** Every rule row sits on the line the map says, with the text the row has. */
function expectLinesMatch(chains: ChainState[]) {
  const { text, lines } = definitionOf(table, chains);
  const all = text.split('\n');
  const rows = chains.flatMap((state) => state.rows);
  expect(lines.size).toBe(rows.length);
  for (const row of rows) expect(all[lines.get(row.key)! - 1]).toBe(`\t\t${row.text}`);
}

describe('initialChains', () => {
  it('reads every chain with its rules, policy and priority', () => {
    const chains = chainsOf();
    expect(chains.map((state) => [state.chain.name, state.rows.length, state.policy, state.base?.priority])).toEqual([
      ['other', 0, undefined, undefined],
      ['c', 18, 'drop', 'filter'],
      ['nat', 2, 'accept', 'dstnat'],
      ['post', 2, 'accept', 'srcnat'],
      ['lists', 6, undefined, undefined],
    ]);
  });

  it('offers the form only for rules it renders back exactly', () => {
    for (const row of chainsOf().flatMap((state) => state.rows)) {
      if (row.form !== undefined) expect(renderRule(row.form, 'inet')).toBe(row.text.replace(/counter packets \d+ bytes \d+/, 'counter'));
    }
    expect(chainsOf().every((state) => state.rows.every((row) => row.form !== undefined))).toBe(true);

    const basic = buildModel({ json: basicJson, listing: basicListing, readAt: '2026-09-25T12:00:00Z' });
    const filter = findTable(basic.ruleset, 'inet', 'filter')!;
    const textOnly = initialChains(editableTable(basic.text, 'inet', 'filter')!, filter, basic)
      .flatMap((state) => state.rows)
      .filter((row) => row.form === undefined);
    expect(textOnly.map((row) => row.text)).toContain('tcp dport vmap @port_policy');
  });
});

describe('definitionOf', () => {
  it('gives back the table unchanged when nothing was edited', () => {
    const chains = chainsOf();
    expect(definitionOf(table, chains).text).toBe(renderTable(table));
    expectLinesMatch(chains);
  });

  it('follows moved, added and removed rules and a changed policy', () => {
    const chains = chainsOf();
    const c = byName(chains, 'c');
    const [first, second, ...rest] = c.rows;
    c.rows = [second!, first!, ...rest.slice(1)];
    c.policy = 'accept';
    const form = { ...emptyRule(), protocol: 'udp', dstPort: { value: '123', negate: false } };
    byName(chains, 'other').rows.push({ key: 'new-1', handle: undefined, text: renderRule(form, 'inet'), form, status: 'new' });

    const { text } = definitionOf(table, chains);
    expect(text).toContain('\tchain other {\n\t\tudp dport 123 accept\n\t}');
    expect(text).toContain('policy accept;');
    expect(text).not.toContain('ct state invalid drop');
    expect(text.indexOf('ct state new tcp dport 22 accept')).toBeLessThan(text.indexOf('ct state established,related accept'));
    expectLinesMatch(chains);
  });
});

describe('chains added and deleted in the editor', () => {
  it('writes new chains last and drops deleted ones with their empty line', () => {
    const chains = chainsOf().filter((state) => state.chain.name !== 'post');
    const guard = addedChain('guard', { type: 'filter', hook: 'forward', priority: 'filter - 5', policy: 'drop' });
    guard.rows.push({ key: 'new-guard', handle: undefined, text: 'ct state established accept', form: undefined, status: 'new' });
    chains.push(guard, addedChain('helpers', undefined));

    const { text } = definitionOf(table, chains);
    expect(text).not.toContain('chain post');
    expect(text).not.toContain('\n\n\n');
    expect(text.endsWith(
      [
        '\t}',
        '',
        '\tchain guard {',
        '\t\ttype filter hook forward priority filter - 5; policy drop;',
        '\t\tct state established accept',
        '\t}',
        '',
        '\tchain helpers {',
        '\t}',
        '}',
        '',
      ].join('\n'),
    )).toBe(true);
    expectLinesMatch(chains);
  });
});

describe('editor sources', () => {
  it('start a live table from what the host has', () => {
    const source = liveSource(model, node)!;
    expect(source.original).toBe(renderTable(table));
    expect(source.creating).toBe(false);
    expect(source.counters).toEqual(['hits']);
  });

  it('start a new table from the host template', () => {
    const source = newTableSource('inet', 'fw', { template: 'host', ssh: true });
    expect(definitionOf(source.table, source.chains).text).toBe(
      [
        'table inet fw {',
        '\tcomment "managed by nftm"',
        '\tchain input {',
        '\t\ttype filter hook input priority filter; policy drop;',
        '\t\tct state established,related accept',
        '\t\tct state invalid drop',
        '\t\tiif "lo" accept',
        '\t\ticmp type echo-request accept',
        '\t\ticmpv6 type { echo-request, nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept',
        '\t\ttcp dport 22 accept comment "SSH"',
        '\t}',
        '}',
        '',
      ].join('\n'),
    );
    const ip = newTableSource('ip', 'fw', { template: 'host', ssh: false });
    expect(ip.chains[0]!.rows.map((row) => row.text)).not.toContainEqual(expect.stringContaining('icmpv6'));
    expect(ip.chains[0]!.rows.map((row) => row.text)).not.toContainEqual(expect.stringContaining('dport 22'));
    expect(definitionOf(newTableSource('netdev', 'x', { template: 'empty', ssh: true }).table, []).text).toBe(
      'table netdev x {\n\tcomment "managed by nftm"\n}\n',
    );
  });
});
