import { blockKey, chainKey, ruleKey, tableKey } from './keys.ts';

/**
 * What `nft -a list ruleset` prints, cut into pieces. hopdeck shows nft's own text
 * rather than rendering JSON itself, so rules look exactly as nft prints them on
 * this host's version.
 */
export interface Listing {
  /** Each rule's text without the handle comment; keyed by ruleKey(). */
  rules: Map<string, string>;
  /** The definition line of each base chain, e.g. "type filter hook input priority filter + 10; policy accept;"; keyed by chainKey(). */
  chainHeaders: Map<string, string>;
  /** Whole blocks of sets, maps, flowtables and named objects, one indent removed; keyed by blockKey(). */
  blocks: Map<string, string>;
  /** Tables nft reports as managed by iptables-nft; keyed by tableKey(). */
  iptablesNft: Set<string>;
}

const HANDLE = / # handle \d+$/;
const TABLE = /^table (\S+) (.+?) \{(?: # handle \d+)?$/;
const OBJECT = /^\t(chain|set|map|flowtable|counter|quota|limit|ct helper|ct timeout|ct expectation|synproxy|secmark|tunnel) (.+?) \{(?: # handle \d+)?$/;
const RULE = /^\t\t(.*) # handle (\d+)$/;
// Printed since nftables 1.0.7 above tables that iptables-nft marked as its own.
const IPTABLES_WARNING = /^# Warning: table (\S+) (\S+) is managed by iptables-nft/;

export function parseListing(listing: string): Listing {
  const result: Listing = { rules: new Map(), chainHeaders: new Map(), blocks: new Map(), iptablesNft: new Set() };
  let table: { family: string; name: string } | undefined;
  let chain: string | undefined;
  let block: { key: string; lines: string[] } | undefined;

  for (const line of listing.split('\n')) {
    const warning = IPTABLES_WARNING.exec(line);
    if (warning !== null) {
      result.iptablesNft.add(tableKey(warning[1]!, unquote(warning[2]!)));
      continue;
    }
    const tableStart = TABLE.exec(line);
    if (tableStart !== null) {
      table = { family: tableStart[1]!, name: unquote(tableStart[2]!) };
      continue;
    }
    if (table === undefined) continue;
    if (line === '}') {
      table = undefined;
      continue;
    }
    if (line === '\t}') {
      if (block !== undefined) result.blocks.set(block.key, [...block.lines, '}'].join('\n'));
      chain = undefined;
      block = undefined;
      continue;
    }

    const object = OBJECT.exec(line);
    if (object !== null) {
      const [, kind, name] = object as unknown as [string, string, string];
      if (kind === 'chain') chain = unquote(name);
      else block = { key: blockKey(table.family, table.name, kind, unquote(name)), lines: [line.slice(1).replace(HANDLE, '')] };
      continue;
    }

    if (block !== undefined) {
      block.lines.push(line.slice(1));
    } else if (chain !== undefined) {
      const rule = RULE.exec(line);
      if (rule !== null) {
        result.rules.set(ruleKey(table.family, table.name, Number(rule[2])), rule[1]!);
      } else if (line.startsWith('\t\ttype ')) {
        result.chainHeaders.set(chainKey(table.family, table.name, chain), line.slice(2));
      }
    }
  }
  return result;
}

/** Hides the "# handle N" comments, for reading. */
export function stripHandles(listing: string): string {
  return listing.replace(/ # handle \d+$/gm, '');
}

/** nft quotes names that are not plain identifiers. */
function unquote(name: string): string {
  return name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1) : name;
}
