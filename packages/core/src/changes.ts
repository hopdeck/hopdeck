import type { NftTable } from './nft-json.ts';

/** The comment that marks a table as managed by nftm; see docs/ARCHITECTURE.md, "Ownership". */
export const MANAGED_COMMENT = 'managed by nftm';

/** A table is managed when its comment is the marker, or starts with it followed by the user's own comment. */
export function isManaged(table: Pick<NftTable, 'comment'>): boolean {
  const comment = table.comment;
  return comment === MANAGED_COMMENT || (comment?.startsWith(`${MANAGED_COMMENT}: `) ?? false);
}

/**
 * Puts the marker into a table definition as nft lists it. An existing comment
 * is kept after the marker, so adopting never loses what the user wrote.
 */
export function withManagedComment(definition: string): string {
  const lines = definition.split('\n');
  const opening = lines.findIndex((line) => /^table \S+ .+ \{$/.test(line));
  if (opening === -1) throw new Error('not a table definition: no "table FAMILY NAME {" line');

  const existing = lines.findIndex((line, index) => index > opening && /^\tcomment "/.test(line));
  const current = existing === -1 ? undefined : /^\tcomment "(.*)"$/.exec(lines[existing]!)?.[1];
  if (current !== undefined && isManaged({ comment: current })) return definition;

  const marker = `\tcomment "${current === undefined ? MANAGED_COMMENT : `${MANAGED_COMMENT}: ${current}`}"`;
  if (existing === -1) lines.splice(opening + 1, 0, marker);
  else lines[existing] = marker;
  return lines.join('\n');
}

/** A name as nft accepts it: bare when it is a plain identifier, quoted otherwise. */
export function nftName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_./-]*$/.test(name) ? name : JSON.stringify(name);
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
