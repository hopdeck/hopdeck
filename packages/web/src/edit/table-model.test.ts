import { editableTable, emptyRule, findTable, renderRule, renderTable } from '@nftm/core';
import { describe, expect, it } from 'vitest';
import basicJson from '../../../core/test/fixtures/basic.json' with { type: 'json' };
import basicListing from '../../../core/test/fixtures/basic.listing?raw';
import rulesJson from '../../../core/test/fixtures/rules.json' with { type: 'json' };
import rulesListing from '../../../core/test/fixtures/rules.listing?raw';
import { buildModel } from '../ruleset/model.ts';
import { definitionOf, initialChains, type ChainState } from './table-model.ts';

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
    expect(chains.map((state) => [state.chain.name, state.rows.length, state.policy, state.priority])).toEqual([
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
