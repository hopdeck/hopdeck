// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

/** Map keys for ruleset objects. Names may contain any character, so parts are JSON-encoded. */

export function tableKey(family: string, table: string): string {
  return JSON.stringify([family, table]);
}

export function chainKey(family: string, table: string, chain: string): string {
  return JSON.stringify([family, table, chain]);
}

/** Rule handles are unique within a table. */
export function ruleKey(family: string, table: string, handle: number): string {
  return JSON.stringify([family, table, handle]);
}

/** `kind` as nft prints it: "set", "map", "flowtable", "counter", "ct helper", ... */
export function blockKey(family: string, table: string, kind: string, name: string): string {
  return JSON.stringify([family, table, kind, name]);
}
