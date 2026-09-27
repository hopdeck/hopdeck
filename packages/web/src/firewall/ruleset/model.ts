// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import {
  blockKey,
  chainKey,
  parseListing,
  parseRuleset,
  ruleKey,
  tableFingerprints,
  tableOwner,
  type Json,
  type Listing,
  type NftChain,
  type NftRule,
  type Ruleset,
  type RulesetSnapshot,
  type TableNode,
  type TableOwner,
  withTableComments,
} from '@hopdeck/core';

export interface RulesetModel {
  ruleset: Ruleset;
  listing: Listing;
  /** The text listing as nft printed it, with handles. */
  text: string;
  owners: Map<TableNode, TableOwner>;
  counts: { tables: number; chains: number; rules: number };
  readAt: Date;
  /** Per table, by tableKey(): what live polling compares to notice changes on the host. */
  fingerprints: Record<string, string>;
}

/** Throws RulesetParseError when nft's JSON is not a ruleset. */
export function buildModel(snapshot: RulesetSnapshot): RulesetModel {
  const listing = parseListing(snapshot.listing);
  // The managed marker is the table's comment, which older nft prints only as text.
  const ruleset = withTableComments(parseRuleset(snapshot.json), listing);
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
    fingerprints: tableFingerprints(snapshot.json),
  };
}

/** Where live polling reports a rule's counter: its own (by ruleKey) or a named one (by blockKey). */
export function counterSource(rule: NftRule, table: TableNode): { kind: 'rule' | 'counter'; key: string } | undefined {
  const { family, name } = table.table;
  for (const statement of rule.expr) {
    if (!isObject(statement) || !('counter' in statement)) continue;
    const counter = statement['counter'];
    if (isObject(counter)) return { kind: 'rule', key: ruleKey(family, name, rule.handle) };
    if (typeof counter === 'string') return { kind: 'counter', key: blockKey(family, name, 'counter', counter) };
  }
  return undefined;
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

/** Tables that differ between what the view shows and the host now, as "family name". */
export function changedTables(shown: Record<string, string>, live: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(shown), ...Object.keys(live)]);
  return [...keys]
    .filter((key) => shown[key] !== live[key])
    .map((key) => (JSON.parse(key) as [string, string]).join(' '))
    .sort();
}
