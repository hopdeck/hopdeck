import {
  chainKey,
  parseListing,
  parseRuleset,
  tableOwner,
  type Json,
  type Listing,
  type NftChain,
  type NftRule,
  type Ruleset,
  type RulesetSnapshot,
  type TableNode,
  type TableOwner,
} from '@nftm/core';

export interface RulesetModel {
  ruleset: Ruleset;
  listing: Listing;
  /** The text listing as nft printed it, with handles. */
  text: string;
  owners: Map<TableNode, TableOwner>;
  counts: { tables: number; chains: number; rules: number };
  readAt: Date;
}

/** Throws RulesetParseError when nft's JSON is not a ruleset. */
export function buildModel(snapshot: RulesetSnapshot): RulesetModel {
  const ruleset = parseRuleset(snapshot.json);
  const listing = parseListing(snapshot.listing);
  const chains = ruleset.tables.flatMap((node) => node.chains);
  return {
    ruleset,
    listing,
    text: snapshot.listing,
    owners: new Map(ruleset.tables.map((node) => [node, tableOwner(node, listing)])),
    counts: {
      tables: ruleset.tables.length,
      chains: chains.length,
      rules: chains.reduce((sum, chain) => sum + chain.rules.length, 0),
    },
    readAt: new Date(snapshot.readAt),
  };
}

/** DOM id of a chain in the rules tab, so other views can scroll to it. */
export function chainAnchor(family: string, table: string, chain: string): string {
  return `chain-${encodeURIComponent(chainKey(family, table, chain))}`;
}

export function tableCounts(node: TableNode) {
  return {
    chains: node.chains.length,
    rules: node.chains.reduce((sum, chain) => sum + chain.rules.length, 0),
    sets: node.sets.length,
    maps: node.maps.length,
  };
}

/** Packets and bytes of a rule's counter: an anonymous one, or the named counter it refers to. */
export function ruleCounter(rule: NftRule, table: TableNode): { packets: number; bytes: number } | undefined {
  for (const statement of rule.expr) {
    if (!isObject(statement) || !('counter' in statement)) continue;
    const counter = statement['counter'];
    if (isObject(counter)) return packetsAndBytes(counter);
    if (typeof counter === 'string') {
      const named = table.objects.find((object) => object.kind === 'counter' && object.object.name === counter);
      if (named !== undefined) return packetsAndBytes(named.object as unknown as Json);
    }
  }
  return undefined;
}

/** "filter + 10" as nft prints it when the listing has the chain, else the number from JSON. */
export function priorityText(header: string | undefined, chain: NftChain): string | undefined {
  const fromListing = header === undefined ? undefined : /priority ([^;]+);/.exec(header)?.[1];
  return fromListing ?? (chain.prio === undefined ? undefined : String(chain.prio));
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

export function formatBytes(bytes: number, locale: string): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit > 0 && value < 10 ? 1 : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)} ${UNITS[unit]}`;
}

function packetsAndBytes(value: Json): { packets: number; bytes: number } | undefined {
  if (!isObject(value)) return undefined;
  const { packets, bytes } = value;
  return typeof packets === 'number' && typeof bytes === 'number' ? { packets, bytes } : undefined;
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
