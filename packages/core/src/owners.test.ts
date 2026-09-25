import { describe, expect, it } from 'vitest';
import foreignJson from '../test/fixtures/foreign.json' with { type: 'json' };
import foreignListing from '../test/fixtures/foreign.listing?raw';
import { parseListing } from './listing.ts';
import { tableOwner } from './owners.ts';
import { parseRuleset, type TableNode } from './ruleset.ts';

describe('tableOwner', () => {
  const ruleset = parseRuleset(foreignJson);
  const listing = parseListing(foreignListing);
  const owners = Object.fromEntries(
    ruleset.tables.map((node) => [`${node.table.family} ${node.table.name}`, tableOwner(node, listing)]),
  );

  it('recognises tools by their table names', () => {
    expect(owners['inet firewalld']).toEqual({ kind: 'tool', tool: 'firewalld', evidence: 'table-name' });
    expect(owners['inet f2b-table']).toEqual({ kind: 'tool', tool: 'fail2ban', evidence: 'table-name' });
    expect(owners['ip libvirt_network']).toEqual({ kind: 'tool', tool: 'libvirt', evidence: 'table-name' });
  });

  it('recognises OpenWrt firewall4', () => {
    const fw4: TableNode = { ...table('fw4', []), table: { family: 'inet', name: 'fw4', handle: 1 } };
    expect(tableOwner(fw4)).toEqual({ kind: 'tool', tool: 'openwrt', evidence: 'table-name' });
  });

  it('recognises iptables-nft tables and the tools inside them', () => {
    expect(owners['ip filter']).toEqual({ kind: 'iptables-nft', evidence: 'chains', users: ['docker'] });
  });

  it('claims nothing about other tables', () => {
    expect(owners['inet mine']).toEqual({ kind: 'unknown' });
  });

  const table = (name: string, chains: TableNode['chains']): TableNode => ({
    table: { family: 'ip', name, handle: 1 },
    chains,
    sets: [],
    maps: [],
    flowtables: [],
    objects: [],
  });

  it('trusts the iptables-nft marker and xt expressions over names', () => {
    const marked = parseListing('# Warning: table ip custom is managed by iptables-nft, do not touch!\n');
    expect(tableOwner(table('custom', []), marked)).toMatchObject({ kind: 'iptables-nft', evidence: 'marker' });

    // The xt statement as libnftables-json(5) documents it.
    const xtRule = { family: 'ip' as const, table: 'custom', chain: 'c', handle: 2, expr: [{ xt: { type: 'match', name: 'recent' } }] };
    const chain = { chain: { family: 'ip' as const, table: 'custom', name: 'c', handle: 1 }, rules: [xtRule] };
    expect(tableOwner(table('custom', [chain]))).toMatchObject({ kind: 'iptables-nft', evidence: 'xt' });
  });
});
