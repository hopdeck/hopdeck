// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

/**
 * Types for the libnftables JSON format, as printed by `nft -j list ruleset`
 * and accepted by `nft -j -f`. See libnftables-json(5).
 *
 * Only the object envelopes are typed. Rule expressions, set elements and
 * similar payloads stay as opaque JSON, so constructs hopdeck does not understand
 * yet pass through untouched.
 */

export type Family = 'ip' | 'ip6' | 'inet' | 'arp' | 'bridge' | 'netdev';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface NftMetainfo {
  version: string;
  release_name: string;
  json_schema_version: number;
}

export interface NftTable {
  family: Family;
  name: string;
  handle: number;
  flags?: string | string[];
  comment?: string;
}

export interface NftChain {
  family: Family;
  table: string;
  name: string;
  handle: number;
  /** Base chains only: type, hook, prio and policy. */
  type?: string;
  hook?: string;
  prio?: number;
  policy?: 'accept' | 'drop';
  dev?: string | string[];
  comment?: string;
}

export interface NftRule {
  family: Family;
  table: string;
  chain: string;
  handle: number;
  expr: Json[];
  comment?: string;
}

/** Shared shape of `set` and `map` objects; maps also carry `map`. */
export interface NftSet {
  family: Family;
  table: string;
  name: string;
  handle: number;
  type: Json;
  map?: Json;
  policy?: string;
  flags?: string[];
  elem?: Json[];
  timeout?: number;
  'gc-interval'?: number;
  size?: number;
  comment?: string;
}

export interface NftFlowtable {
  family: Family;
  table: string;
  name: string;
  handle: number;
  hook: string;
  prio: number;
  dev?: string | string[];
}

/** Stateful objects that live in a table and are referenced by name. */
export const NAMED_OBJECT_KINDS = [
  'counter',
  'quota',
  'limit',
  'ct helper',
  'ct timeout',
  'ct expectation',
  'secmark',
  'synproxy',
] as const;

export type NamedObjectKind = (typeof NAMED_OBJECT_KINDS)[number];

/** Common fields of a named object; the rest depends on its kind. */
export interface NftNamedObject {
  family: Family;
  table: string;
  name: string;
  handle: number;
  comment?: string;
}
