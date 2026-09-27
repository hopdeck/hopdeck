// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { blockKey, ruleKey, tableKey } from './keys.ts';
import type { Json } from './nft-json.ts';
import { TRACE_TABLE_PREFIX } from './trace.ts';

export interface Counter {
  packets: number;
  bytes: number;
}

/** What a periodic look at the host yields: counter values, and whether any table changed. */
export interface LiveState {
  /** When hopdeck read it, ISO 8601. */
  readAt: string;
  /** Rules with an anonymous counter, by ruleKey(). */
  rules: Record<string, Counter>;
  /** Named counters, by blockKey(family, table, 'counter', name). */
  counters: Record<string, Counter>;
  /** Per table, by tableKey(): a hash of everything but what changes on its own. */
  fingerprints: Record<string, string>;
}

type JsonObject = { [key: string]: Json };

/** Counter values and table fingerprints out of `nft -j list ruleset`. */
export function liveState(json: unknown, readAt: string): LiveState {
  const items = nftItems(json);
  const rules: Record<string, Counter> = {};
  const counters: Record<string, Counter> = {};
  for (const item of items) {
    const [kind, body] = entry(item);
    if (kind === 'rule' && isObject(body) && Array.isArray(body['expr'])) {
      const counter = body['expr'].map(counterOf).find((found) => found !== undefined);
      if (counter !== undefined) rules[ruleKey(String(body['family']), String(body['table']), Number(body['handle']))] = counter;
    } else if (kind === 'counter' && isObject(body)) {
      const counter = values(body);
      if (counter !== undefined) counters[blockKey(String(body['family']), String(body['table']), 'counter', String(body['name']))] = counter;
    }
  }
  return { readAt, rules, counters, fingerprints: tableFingerprints(json) };
}

/**
 * Per table, a hash of its definition without counter values, quota use,
 * expiry and set elements: those change on their own. hopdeck's tracing tables
 * are left out, since they come and go while it traces.
 *
 * With `handles: false` the hash is of the content alone: the same after the
 * table is loaded again, e.g. at boot, which gives every object a new handle.
 */
export function tableFingerprints(json: unknown, options: { handles?: boolean } = {}): Record<string, string> {
  const handles = options.handles ?? true;
  const texts = new Map<string, string[]>();
  for (const item of nftItems(json)) {
    const [kind, body] = entry(item);
    if (kind === 'metainfo' || !isObject(body)) continue;
    const table = kind === 'table' ? body['name'] : body['table'];
    if (typeof table !== 'string' || table.startsWith(TRACE_TABLE_PREFIX)) continue;
    const key = tableKey(String(body['family']), table);
    const list = texts.get(key) ?? [];
    list.push(JSON.stringify({ [kind]: stable(kind, body, handles) }));
    texts.set(key, list);
  }
  return Object.fromEntries([...texts].map(([key, list]) => [key, fnv1a(list.join('\n'))]));
}

/** A copy without the values that change on their own. */
function stable(kind: string, body: JsonObject, handles: boolean): Json {
  const copy: JsonObject = { ...body };
  if (!handles) delete copy['handle'];
  if (kind === 'counter') {
    delete copy['packets'];
    delete copy['bytes'];
  }
  if (kind === 'quota') delete copy['used'];
  if (kind === 'set' || kind === 'map' || kind === 'meter') delete copy['elem'];
  return withoutState(copy);
}

/** Counter statements lose their values, quota statements their use, elements their expiry. */
function withoutState(value: Json): Json {
  if (Array.isArray(value)) return value.map(withoutState);
  if (!isObject(value)) return value;
  const copy: JsonObject = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'expires') continue;
    if (key === 'counter' && isObject(inner)) copy[key] = {};
    else if (key === 'quota' && isObject(inner)) {
      const { used: _used, used_unit: _unit, ...rest } = inner;
      copy[key] = withoutState(rest);
    } else copy[key] = withoutState(inner);
  }
  return copy;
}

function counterOf(statement: Json): Counter | undefined {
  if (!isObject(statement) || !('counter' in statement)) return undefined;
  const counter = statement['counter'];
  return isObject(counter) ? values(counter) : undefined;
}

function values(counter: JsonObject): Counter | undefined {
  const { packets, bytes } = counter;
  return typeof packets === 'number' && typeof bytes === 'number' ? { packets, bytes } : undefined;
}

function nftItems(json: unknown): Json[] {
  if (!isObject(json as Json) || !Array.isArray((json as JsonObject)['nftables'])) return [];
  return (json as JsonObject)['nftables'] as Json[];
}

function entry(item: Json): [string, Json] {
  if (!isObject(item)) return ['', null];
  const [key] = Object.keys(item);
  return key === undefined ? ['', null] : [key, item[key]!];
}

function isObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 32-bit FNV-1a, as hex: short, fast and the same in the browser and on the server. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
