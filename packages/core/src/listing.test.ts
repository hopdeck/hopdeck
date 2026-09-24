import { describe, expect, it } from 'vitest';
import basicListing from '../test/fixtures/basic.listing?raw';
import foreignListing from '../test/fixtures/foreign.listing?raw';
import { blockKey, chainKey, ruleKey, tableKey } from './keys.ts';
import { parseListing, stripHandles } from './listing.ts';

describe('parseListing', () => {
  const listing = parseListing(basicListing);

  it("keeps nft's own text of every rule, by table and handle", () => {
    expect(listing.rules.get(ruleKey('inet', 'filter', 12))).toBe('ct state established,related accept');
    expect(listing.rules.get(ruleKey('inet', 'filter', 17))).toBe('ip saddr @admins accept comment "ssh from admins"');
    expect(listing.rules.get(ruleKey('ip', 'nat', 2))).toBe('oifname "eth0" masquerade');
    expect(listing.rules.size).toBe(6);
  });

  it('keeps base chain definitions as nft prints them', () => {
    expect(listing.chainHeaders.get(chainKey('inet', 'filter', 'input'))).toBe(
      'type filter hook input priority filter; policy drop;',
    );
    expect(listing.chainHeaders.has(chainKey('inet', 'filter', 'ssh_in'))).toBe(false);
    const foreign = parseListing(foreignListing);
    expect(foreign.chainHeaders.get(chainKey('inet', 'firewalld', 'filter_INPUT'))).toBe(
      'type filter hook input priority filter + 10; policy accept;',
    );
  });

  it('keeps whole blocks of sets, maps and named objects, including continued lines', () => {
    expect(listing.blocks.get(blockKey('inet', 'filter', 'map', 'port_policy'))).toBe(
      'map port_policy {\n\ttype inet_service : verdict\n\telements = { 22 : jump ssh_in,\n\t\t     8080 : drop }\n}',
    );
    expect(listing.blocks.get(blockKey('inet', 'filter', 'ct helper', 'ftp'))).toBe(
      'ct helper ftp {\n\ttype "ftp" protocol tcp\n\tl3proto inet\n}',
    );
    expect([...listing.blocks.keys()].map((key) => JSON.parse(key)[2])).toEqual([
      'counter',
      'quota',
      'limit',
      'ct helper',
      'synproxy',
      'set',
      'map',
      'flowtable',
    ]);
  });

  it('notices tables nft marks as managed by iptables-nft', () => {
    const marked = parseListing(
      '# Warning: table ip filter is managed by iptables-nft, do not touch!\ntable ip filter { # handle 1\n}\n',
    );
    expect([...marked.iptablesNft]).toEqual([tableKey('ip', 'filter')]);
  });

  it('reads quoted names', () => {
    const quoted = parseListing('table inet "my table" { # handle 1\n\tchain "in put" { # handle 1\n\t\taccept # handle 2\n\t}\n}\n');
    expect(quoted.rules.get(ruleKey('inet', 'my table', 2))).toBe('accept');
  });
});

describe('stripHandles', () => {
  it('removes only the handle comments', () => {
    expect(stripHandles('table inet t { # handle 1\n\t\taccept comment "# handle 5" # handle 2\n')).toBe(
      'table inet t {\n\t\taccept comment "# handle 5"\n',
    );
  });
});
