import { MANAGED_COMMENT, nftName } from './changes.ts';
import type { Family } from './nft-json.ts';

export interface EditableRule {
  /** Handle of the live rule; undefined for a rule added in the editor. */
  handle: number | undefined;
  /** The rule in nft syntax, without the handle comment. */
  text: string;
}

export interface EditableChain {
  name: string;
  /** "\tchain NAME {", as nft printed it. */
  opening: string;
  /** Lines before the rules: type, hook, priority and policy, devices, comment. */
  header: string[];
  rules: EditableRule[];
}

export type TablePart = { kind: 'line'; text: string } | { kind: 'chain'; chain: EditableChain };

/** A table's text split into what the editor changes (chains and rules) and what it keeps verbatim. */
export interface EditableTable {
  family: Family;
  name: string;
  parts: TablePart[];
}

const HANDLE = / # handle \d+$/;

/** Reads a table out of `nft -a list ruleset` (or `nft -a list table`); undefined if it is not there. */
export function editableTable(listing: string, family: Family, name: string): EditableTable | undefined {
  const lines = listing.split('\n');
  const opening = `table ${family} ${nftName(name)} {`;
  const start = lines.findIndex((line) => line.replace(HANDLE, '') === opening);
  if (start === -1) return undefined;

  const parts: TablePart[] = [{ kind: 'line', text: opening }];
  let chain: EditableChain | undefined;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === '}') {
      parts.push({ kind: 'line', text: '}' });
      return { family, name, parts };
    }
    if (chain !== undefined) {
      if (line === '\t}') {
        chain = undefined;
        continue;
      }
      const handle = / # handle (\d+)$/.exec(line);
      if (handle !== null) chain.rules.push({ handle: Number(handle[1]), text: line.replace(HANDLE, '').slice(2) });
      else chain.header.push(line);
      continue;
    }
    const chainStart = /^\tchain (.+?) \{(?: # handle \d+)?$/.exec(line);
    if (chainStart !== null) {
      chain = { name: chainStart[1]!.replace(/^"(.*)"$/, '$1'), opening: line.replace(HANDLE, ''), header: [], rules: [] };
      parts.push({ kind: 'chain', chain });
      continue;
    }
    parts.push({ kind: 'line', text: line.replace(HANDLE, '') });
  }
  return undefined;
}

/** The table's definition for a deployment: nft syntax without handles. */
export function renderTable(table: EditableTable): string {
  const lines: string[] = [];
  for (const part of table.parts) {
    if (part.kind === 'line') {
      lines.push(part.text);
      continue;
    }
    const { opening, header, rules } = part.chain;
    lines.push(opening, ...header, ...rules.map((rule) => `\t\t${rule.text}`), '\t}');
  }
  return `${lines.join('\n')}\n`;
}

export function chains(table: EditableTable): EditableChain[] {
  return table.parts.flatMap((part) => (part.kind === 'chain' ? [part.chain] : []));
}

/** The policy of a base chain, from its header; undefined for a regular chain. */
export function chainPolicy(chain: EditableChain): 'accept' | 'drop' | undefined {
  for (const line of chain.header) {
    const policy = /policy (accept|drop);/.exec(line);
    if (policy !== null) return policy[1] as 'accept' | 'drop';
  }
  return undefined;
}

export function withPolicy(chain: EditableChain, policy: 'accept' | 'drop'): EditableChain {
  return { ...chain, header: chain.header.map((line) => line.replace(/policy (accept|drop);/, `policy ${policy};`)) };
}

/** What makes a chain a base chain: where it hooks into the packet path. */
export interface BaseChainSpec {
  type: string;
  hook: string;
  /** A number or a standard name, e.g. "filter" or "dstnat - 10". */
  priority: string;
  policy: 'accept' | 'drop';
  /** Netdev chains and inet ingress chains attach to one interface. */
  device?: string;
}

/** A new chain, written as nft lists chains: a regular one, or a base chain with its hook. */
export function newChain(name: string, base?: BaseChainSpec): EditableChain {
  const device = base?.device === undefined ? '' : ` device ${JSON.stringify(base.device)}`;
  const header = base === undefined ? [] : [`\t\ttype ${base.type} hook ${base.hook}${device} priority ${base.priority}; policy ${base.policy};`];
  return { name, opening: `\tchain ${nftName(name)} {`, header, rules: [] };
}

/** A table that does not exist yet, marked as managed by nftm, without chains. */
export function newTable(family: Family, name: string): EditableTable {
  return {
    family,
    name,
    parts: [
      { kind: 'line', text: `table ${family} ${nftName(name)} {` },
      { kind: 'line', text: `\tcomment "${MANAGED_COMMENT}"` },
      { kind: 'line', text: '}' },
    ],
  };
}
