import {
  NAMED_OBJECT_KINDS,
  type Family,
  type Json,
  type NamedObjectKind,
  type NftChain,
  type NftFlowtable,
  type NftMetainfo,
  type NftNamedObject,
  type NftRule,
  type NftSet,
  type NftTable,
} from './nft-json.ts';

export interface ChainNode {
  chain: NftChain;
  /** In evaluation order, as listed by nft. */
  rules: NftRule[];
}

export interface NamedObjectNode {
  kind: NamedObjectKind;
  object: NftNamedObject;
}

export interface TableNode {
  table: NftTable;
  chains: ChainNode[];
  sets: NftSet[];
  maps: NftSet[];
  flowtables: NftFlowtable[];
  objects: NamedObjectNode[];
}

/**
 * A ruleset grouped by table. Every object is the one nft printed, not a copy;
 * items nftm does not recognise are kept verbatim in `unknown`.
 */
export interface Ruleset {
  metainfo: NftMetainfo | undefined;
  tables: TableNode[];
  unknown: Json[];
}

export class RulesetParseError extends Error {
  override name = 'RulesetParseError';
}

type JsonObject = { [key: string]: Json };

interface Entry {
  kind: string;
  value: JsonObject;
  item: Json;
}

/** Parses the output of `nft -j list ruleset`. */
export function parseRuleset(doc: unknown): Ruleset {
  if (!isObject(doc as Json) || !Array.isArray((doc as JsonObject)['nftables'])) {
    throw new RulesetParseError('expected an object with an "nftables" array');
  }
  const items = (doc as JsonObject)['nftables'] as Json[];
  let metainfo: NftMetainfo | undefined;
  const unknown = new Set<Json>();

  // nft prints tables before their contents and chains before their rules, but
  // grouping in passes keeps us independent of that order.
  const tables = new Map<string, TableNode>();
  const rest: Entry[] = [];
  for (const item of items) {
    const entry = toEntry(item);
    if (entry === undefined) {
      unknown.add(item);
    } else if (entry.kind === 'metainfo') {
      metainfo = cast<NftMetainfo>(entry.value);
    } else if (entry.kind === 'table' && isNewTable(entry.value, tables)) {
      tables.set(key(entry.value['family'], entry.value['name']), {
        table: cast<NftTable>(entry.value),
        chains: [],
        sets: [],
        maps: [],
        flowtables: [],
        objects: [],
      });
    } else {
      rest.push(entry);
    }
  }

  const chains = new Map<string, ChainNode>();
  const rules: Entry[] = [];
  for (const entry of rest) {
    const { kind, value } = entry;
    if (kind === 'rule') {
      rules.push(entry);
      continue;
    }
    const table = tables.get(key(value['family'], value['table']));
    if (table === undefined) {
      unknown.add(entry.item);
    } else if (kind === 'chain') {
      const node: ChainNode = { chain: cast<NftChain>(value), rules: [] };
      table.chains.push(node);
      chains.set(key(value['family'], value['table'], value['name']), node);
    } else if (kind === 'set') {
      table.sets.push(cast<NftSet>(value));
    } else if (kind === 'map') {
      table.maps.push(cast<NftSet>(value));
    } else if (kind === 'flowtable') {
      table.flowtables.push(cast<NftFlowtable>(value));
    } else if (isNamedObjectKind(kind)) {
      table.objects.push({ kind, object: cast<NftNamedObject>(value) });
    } else {
      unknown.add(entry.item);
    }
  }

  for (const entry of rules) {
    const { value } = entry;
    const chain = chains.get(key(value['family'], value['table'], value['chain']));
    if (chain === undefined) unknown.add(entry.item);
    else chain.rules.push(cast<NftRule>(value));
  }

  return {
    metainfo,
    tables: [...tables.values()],
    unknown: items.filter((item) => unknown.has(item)),
  };
}

export function findTable(ruleset: Ruleset, family: Family, name: string): TableNode | undefined {
  return ruleset.tables.find((node) => node.table.family === family && node.table.name === name);
}

/** Every item of the top-level array is an object with exactly one key. */
function toEntry(item: Json): Entry | undefined {
  if (!isObject(item)) return undefined;
  const keys = Object.keys(item);
  if (keys.length !== 1) return undefined;
  const kind = keys[0]!;
  const value = item[kind]!;
  return isObject(value) ? { kind, value, item } : undefined;
}

/** A duplicate table would hide the first one, so it is kept as unknown instead. */
function isNewTable(value: JsonObject, tables: Map<string, TableNode>): boolean {
  return (
    isString(value['family']) && isString(value['name']) && !tables.has(key(value['family'], value['name']))
  );
}

/** Only the envelope is checked; the fields are trusted to follow libnftables-json(5). */
function cast<T>(value: JsonObject): T {
  return value as unknown as T;
}

function key(...parts: (Json | undefined)[]): string {
  return JSON.stringify(parts);
}

function isObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: Json | undefined): value is string {
  return typeof value === 'string';
}

function isNamedObjectKind(kind: string): kind is NamedObjectKind {
  return (NAMED_OBJECT_KINDS as readonly string[]).includes(kind);
}
