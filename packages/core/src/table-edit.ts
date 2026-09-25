import { MANAGED_COMMENT, nftName } from './changes.ts';
import { parseSetBlock } from './set-elements.ts';
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

/** A named object of the table (set, map, counter, flowtable, ...), kept as nft listed it. */
export interface EditableBlock {
  kind: string;
  name: string;
  /** From "\tset NAME {" to "\t}". */
  lines: string[];
}

export type TablePart = { kind: 'line'; text: string } | { kind: 'chain'; chain: EditableChain } | { kind: 'block'; block: EditableBlock };

/** A table's text split into what the editor changes (chains and rules) and what it keeps verbatim. */
export interface EditableTable {
  family: Family;
  name: string;
  parts: TablePart[];
}

const HANDLE = / # handle \d+$/;
const BLOCK = /^\t(set|map|flowtable|counter|quota|limit|ct helper|ct timeout|ct expectation|synproxy|secmark|tunnel) (.+?) \{(?: # handle \d+)?$/;

/** Reads a table out of `nft -a list ruleset` (or `nft -a list table`); undefined if it is not there. */
export function editableTable(listing: string, family: Family, name: string): EditableTable | undefined {
  const lines = listing.split('\n');
  const opening = `table ${family} ${nftName(name)} {`;
  const start = lines.findIndex((line) => line.replace(HANDLE, '') === opening);
  if (start === -1) return undefined;

  const parts: TablePart[] = [{ kind: 'line', text: opening }];
  let chain: EditableChain | undefined;
  let block: EditableBlock | undefined;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === '}') {
      parts.push({ kind: 'line', text: '}' });
      return { family, name, parts };
    }
    if (block !== undefined) {
      block.lines.push(line.replace(HANDLE, ''));
      if (line === '\t}') block = undefined;
      continue;
    }
    const blockStart = BLOCK.exec(line);
    if (blockStart !== null) {
      block = { kind: blockStart[1]!, name: blockStart[2]!.replace(/^"(.*)"$/, '$1'), lines: [line.replace(HANDLE, '')] };
      parts.push({ kind: 'block', block });
      continue;
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
    if (part.kind === 'block') {
      lines.push(...part.block.lines);
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

/** What a new named set or map is declared with. */
export interface SetSpec {
  kind: 'set' | 'map';
  name: string;
  /** Key type, e.g. "ipv4_addr" or "ipv4_addr . inet_service". */
  type: string;
  /** For a map: the value type, e.g. "verdict". */
  value?: string;
  flags: string[];
  /** Default timeout of elements, e.g. "1h". */
  timeout?: string;
  counter: boolean;
  elements: string[];
}

/** What the set dialog can show of an existing set or map; the other declaration lines stay as they are. */
export function setSpecOf(block: EditableBlock): SetSpec | undefined {
  const parsed = parseSetBlock(block.lines.map((line) => line.replace(/^\t/, '')).join('\n'));
  if (parsed === undefined) return undefined;
  const typeLine = parsed.declaration.find((line) => line.startsWith('type '));
  if (typeLine === undefined) return undefined;
  const [type, value] = typeLine.slice('type '.length).split(' : ');
  const flags = parsed.declaration.find((line) => line.startsWith('flags '))?.slice('flags '.length).split(',') ?? [];
  const timeout = parsed.declaration.find((line) => line.startsWith('timeout '))?.slice('timeout '.length);
  return {
    kind: parsed.kind,
    name: parsed.name,
    type: type!,
    ...(parsed.kind === 'map' && value !== undefined && { value }),
    flags,
    ...(timeout !== undefined && { timeout }),
    counter: parsed.declaration.includes('counter'),
    elements: parsed.elements,
  };
}

/**
 * The block with the dialog's changes, in nft's line order: lines the dialog
 * does not know (size, policy, ...) stay, and unchanged elements keep nft's
 * own wrapping.
 */
export function editSetBlock(block: EditableBlock, spec: SetSpec): EditableBlock {
  const original = setSpecOf(block);
  const parsed = parseSetBlock(block.lines.map((line) => line.replace(/^\t/, '')).join('\n'));
  if (original === undefined || parsed === undefined) return newSetBlock(spec);

  const wanted = {
    flags: spec.flags.length > 0 ? `flags ${spec.flags.join(',')}` : undefined,
    counter: spec.counter ? 'counter' : undefined,
    timeout: spec.timeout !== undefined ? `timeout ${spec.timeout}` : undefined,
  };
  const declaration: string[] = [];
  const placed = new Set<string>();
  for (const line of parsed.declaration) {
    if (line.startsWith('type ')) declaration.push(`type ${spec.type}${spec.kind === 'map' ? ` : ${spec.value}` : ''}`);
    else if (line.startsWith('flags ')) (placed.add('flags'), wanted.flags && declaration.push(wanted.flags));
    else if (line === 'counter') (placed.add('counter'), wanted.counter && declaration.push(wanted.counter));
    else if (line.startsWith('timeout ')) (placed.add('timeout'), wanted.timeout && declaration.push(wanted.timeout));
    else declaration.push(line);
  }
  // New lines go where nft prints them: type, flags, counter, timeout.
  const prefixes = ['type ', 'flags ', 'counter', 'timeout '];
  (['flags', 'counter', 'timeout'] as const).forEach((key, index) => {
    const line = wanted[key];
    if (placed.has(key) || line === undefined) return;
    const earlier = prefixes.slice(0, index + 1);
    const after = declaration.findLastIndex((existing) => earlier.some((prefix) => existing.startsWith(prefix)));
    declaration.splice(after + 1, 0, line);
  });

  const sameElements = spec.elements.length === original.elements.length && spec.elements.every((element, index) => element === original.elements[index]);
  const start = block.lines.findIndex((line) => /^\t\telements = \{/.test(line));
  const elements = sameElements && start !== -1 ? block.lines.slice(start, -1) : spec.elements.length > 0 ? [`\t\telements = { ${spec.elements.join(', ')} }`] : [];
  return { kind: spec.kind, name: spec.name, lines: [block.lines[0]!, ...declaration.map((line) => `\t\t${line}`), ...elements, '\t}'] };
}

/** A new set or map, written the way nft lists them. */
export function newSetBlock(spec: SetSpec): EditableBlock {
  const lines = [`\t${spec.kind} ${nftName(spec.name)} {`, `\t\ttype ${spec.type}${spec.kind === 'map' ? ` : ${spec.value}` : ''}`];
  if (spec.flags.length > 0) lines.push(`\t\tflags ${spec.flags.join(',')}`);
  if (spec.counter) lines.push('\t\tcounter');
  if (spec.timeout !== undefined) lines.push(`\t\ttimeout ${spec.timeout}`);
  if (spec.elements.length > 0) lines.push(`\t\telements = { ${spec.elements.join(', ')} }`);
  lines.push('\t}');
  return { kind: spec.kind, name: spec.name, lines };
}

/**
 * The definition, with every named object (set, map, counter, ...) that the
 * user left as it was in `base` taken from `current`, the table as it is now:
 * elements that expired meanwhile stay gone and counters keep their values.
 * Objects the user changed stay as written. A definition this cannot take
 * apart without loss comes back unchanged.
 */
export function refreshUntouched(definition: string, base: string, current: string, family: Family, name: string): string {
  const edited = editableTable(definition, family, name);
  const before = editableTable(base, family, name);
  const now = editableTable(current, family, name);
  if (edited === undefined || before === undefined || now === undefined || renderTable(edited) !== definition) return definition;

  const blocks = (table: EditableTable) =>
    new Map<string, string[]>(table.parts.flatMap((part) => (part.kind === 'block' ? [[`${part.block.kind} ${part.block.name}`, part.block.lines]] : [])));
  const original = blocks(before);
  const live = blocks(now);
  edited.parts = edited.parts.map((part) => {
    if (part.kind !== 'block') return part;
    const key = `${part.block.kind} ${part.block.name}`;
    const untouched = original.get(key)?.join('\n') === part.block.lines.join('\n');
    const lines = live.get(key);
    return untouched && lines !== undefined ? { kind: 'block', block: { ...part.block, lines: [...lines] } } : part;
  });
  return renderTable(edited);
}
