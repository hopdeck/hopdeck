// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { NftTable } from './nft-json.ts';

/** The comment that marks a table as managed by hopdeck; see docs/ARCHITECTURE.md, "Ownership". */
export const MANAGED_COMMENT = 'managed by hopdeck';

/**
 * The marker from before hopdeck had its name. nft cannot change the comment of
 * an existing table, so tables adopted then keep it until their next change,
 * which writes MANAGED_COMMENT instead.
 */
const LEGACY_MANAGED_COMMENTS = ['managed by nftm'];

const MARKERS = [MANAGED_COMMENT, ...LEGACY_MANAGED_COMMENTS];

/** The user's own part of a table comment, without the hopdeck marker. */
export function userComment(comment: string | undefined): string | undefined {
  if (comment === undefined) return undefined;
  for (const marker of MARKERS) {
    if (comment === marker) return undefined;
    if (comment.startsWith(`${marker}: `)) return comment.slice(marker.length + 2);
  }
  return comment;
}

/** A table is managed when its comment is the marker, or starts with it followed by the user's own comment. */
export function isManaged(table: Pick<NftTable, 'comment'>): boolean {
  const comment = table.comment;
  return comment !== undefined && MARKERS.some((marker) => comment === marker || comment.startsWith(`${marker}: `));
}

/**
 * Puts the marker into a table definition as nft lists it. An existing comment
 * is kept after the marker, so adopting never loses what the user wrote; an
 * older marker gives way to the current one.
 */
export function withManagedComment(definition: string): string {
  const lines = definition.split('\n');
  const opening = lines.findIndex((line) => /^table \S+ .+ \{$/.test(line));
  if (opening === -1) throw new Error('not a table definition: no "table FAMILY NAME {" line');

  const existing = lines.findIndex((line, index) => index > opening && /^\tcomment "/.test(line));
  const current = existing === -1 ? undefined : /^\tcomment "(.*)"$/.exec(lines[existing]!)?.[1];
  const own = userComment(current);

  const marker = `\tcomment "${own === undefined ? MANAGED_COMMENT : `${MANAGED_COMMENT}: ${own}`}"`;
  if (existing === -1) lines.splice(opening + 1, 0, marker);
  else lines[existing] = marker;
  return lines.join('\n');
}

/** A name as nft accepts it: bare when it is a plain identifier, quoted otherwise. */
export function nftName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_./-]*$/.test(name) ? name : JSON.stringify(name);
}

/** One table's block out of `nft list ruleset`, as `nft list table` would print it. */
export function tableText(ruleset: string, family: string, name: string): string | undefined {
  const lines = ruleset.split('\n');
  const start = lines.indexOf(`table ${family} ${nftName(name)} {`);
  if (start === -1) return undefined;
  const end = lines.indexOf('}', start);
  return end === -1 ? undefined : `${lines.slice(start, end + 1).join('\n')}\n`;
}

/**
 * nft input that replaces a table in one transaction, whether it exists or not:
 * create it empty (a no-op if it exists), delete it, define it anew. Unlike
 * `destroy table`, this works on nft older than 1.0.8. Without a definition the
 * table is only removed.
 */
export function replaceTableScript(family: string, name: string, definition: string | undefined): string {
  const table = `table ${family} ${nftName(name)}`;
  const lines = [`${table} {}`, `delete ${table}`];
  if (definition !== undefined) lines.push(definition.trimEnd());
  return `${lines.join('\n')}\n`;
}
