import { nftName } from './changes.ts';
import type { Family } from './nft-json.ts';

/** A named set or map as nft lists it, split into its declaration and its elements. */
export interface SetBlock {
  kind: 'set' | 'map';
  name: string;
  /** The block's other lines, trimmed: "type ipv4_addr", "flags interval", "timeout 1h", ... */
  declaration: string[];
  /** Each element as nft printed it, e.g. `1.2.3.4 timeout 10m expires 9m59s comment "bot"`. */
  elements: string[];
}

/** One element taken apart for display. */
export interface ElementParts {
  /** What identifies the element: the value, or a map's key. Deleting it takes only this. */
  key: string;
  /** A map element's value, e.g. "jump ssh_in" or "10.0.0.2". */
  value?: string;
  timeout?: string;
  /** Time left until the element expires. */
  expires?: string;
  counter?: { packets: number; bytes: number };
  comment?: string;
}

const HEAD = /^(set|map) (.+?) \{$/;
const KEYWORDS = ['timeout', 'expires', 'counter', 'comment'] as const;

/**
 * Reads a set or map block from a listing (a Listing block: the block with one
 * indent removed). Undefined for anything else, e.g. a flowtable.
 */
export function parseSetBlock(block: string): SetBlock | undefined {
  const lines = block.split('\n');
  const head = HEAD.exec(lines[0] ?? '');
  if (head === null || lines.at(-1) !== '}') return undefined;
  const body = lines.slice(1, -1).join('\n');
  const start = body.search(/(^|\n)\s*elements = \{/);
  if (start === -1) return { kind: head[1] as 'set' | 'map', name: unquote(head[2]!), declaration: trimmed(body), elements: [] };

  const open = body.indexOf('{', start);
  const close = matching(body, open);
  if (close === -1) return undefined;
  return {
    kind: head[1] as 'set' | 'map',
    name: unquote(head[2]!),
    declaration: trimmed(`${body.slice(0, start)}\n${body.slice(close + 1)}`),
    elements: splitList(body.slice(open + 1, close)),
  };
}

/** Splits nft list syntax at the commas that separate items, not those inside quotes or braces. */
export function splitList(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '{' || char === '(' || char === '[')) depth += 1;
    else if (!quoted && (char === '}' || char === ')' || char === ']')) depth -= 1;
    if (char === ',' && !quoted && depth === 0) {
      items.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  items.push(current);
  return items.map((item) => item.replace(/\s+/g, ' ').trim()).filter((item) => item !== '');
}

export function elementParts(element: string, map: boolean): ElementParts {
  const colon = map ? outsideQuotes(element, ' : ') : -1;
  const left = colon === -1 ? element : element.slice(0, colon);
  const parts: ElementParts = { key: left };
  if (colon !== -1) parts.value = element.slice(colon + 3).trim();

  const words = tokens(left);
  const first = words.findIndex((word) => (KEYWORDS as readonly string[]).includes(word));
  if (first === -1) return parts;
  parts.key = words.slice(0, first).join(' ');
  for (let index = first; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === 'timeout' || word === 'expires') parts[word] = words[(index += 1)];
    else if (word === 'comment') parts.comment = unquote(words[(index += 1)] ?? '');
    else if (word === 'counter' && words[index + 1] === 'packets') {
      parts.counter = { packets: Number(words[index + 2]), bytes: Number(words[index + 4]) };
      index += 4;
    }
  }
  return parts;
}

/** What a user may type as an element: one item, no second command, no comment that hides the rest. */
export function elementProblem(element: string): string | undefined {
  if (element.trim() === '') return 'the element is empty';
  if (/[\n\r;#]/.test(element.replace(/"[^"]*"/g, '""'))) return `"${element}" contains a newline, ";" or "#"`;
  if ((element.match(/"/g)?.length ?? 0) % 2 !== 0) return `"${element}" has an unclosed quote`;
  if (splitList(element).length !== 1) return `"${element}" is more than one element`;
  let depth = 0;
  for (const char of element.replace(/"[^"]*"/g, '""')) {
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth < 0) return `"${element}" closes a brace it did not open`;
  }
  return depth === 0 ? undefined : `"${element}" has an unclosed brace`;
}

/** nft input that removes and adds elements; `create` fails on an element that is already there. */
export function elementChangeScript(family: Family, table: string, set: string, add: readonly string[], remove: readonly string[]): string {
  const target = `${family} ${nftName(table)} ${nftName(set)}`;
  const lines: string[] = [];
  if (remove.length > 0) lines.push(`delete element ${target} { ${remove.join(', ')} }`);
  if (add.length > 0) lines.push(`create element ${target} { ${add.join(', ')} }`);
  return lines.map((line) => `${line}\n`).join('');
}

/** nft input that puts back exactly these elements, with their timeouts, counters and comments. */
export function restoreElementsScript(family: Family, table: string, kind: 'set' | 'map', set: string, elements: readonly string[]): string {
  const target = `${family} ${nftName(table)} ${nftName(set)}`;
  const lines = [`flush ${kind} ${target}`];
  if (elements.length > 0) lines.push(`add element ${target} { ${elements.join(', ')} }`);
  return lines.map((line) => `${line}\n`).join('');
}

function trimmed(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function matching(text: string, open: number): number {
  let depth = 0;
  let quoted = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === '{') depth += 1;
    else if (!quoted && char === '}' && (depth -= 1) === 0) return index;
  }
  return -1;
}

function outsideQuotes(text: string, needle: string): number {
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '"') quoted = !quoted;
    else if (!quoted && text.startsWith(needle, index)) return index;
  }
  return -1;
}

/** Words, keeping a quoted string as one word with its quotes. */
function tokens(text: string): string[] {
  return text.match(/"[^"]*"|\S+/g) ?? [];
}

function unquote(text: string): string {
  return text.replace(/^"(.*)"$/, '$1');
}
