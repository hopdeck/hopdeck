// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

export type TokenKind = 'plain' | 'keyword' | 'accept' | 'drop' | 'jump' | 'string' | 'number' | 'ref' | 'comment';

export interface Token {
  kind: TokenKind;
  text: string;
}

const TOKEN = /(?<string>"(?:[^"\\]|\\.)*")|(?<comment>#.*)|(?<ref>@[\w.-]+)|(?<word>[A-Za-z_][\w-]*)|(?<number>\d[\w.:/-]*)/g;

const ACCEPT = new Set(['accept']);
const DROP = new Set(['drop', 'reject']);
const JUMP = new Set(['jump', 'goto', 'return', 'continue', 'queue']);
const KEYWORDS = new Set([
  'table', 'chain', 'set', 'map', 'flowtable', 'counter', 'quota', 'limit', 'synproxy', 'secmark',
  'type', 'hook', 'priority', 'policy', 'device', 'devices', 'elements', 'flags', 'timeout', 'size',
  'comment', 'typeof', 'vmap', 'name', 'log', 'prefix', 'level', 'masquerade', 'snat', 'dnat',
  'redirect', 'to', 'with', 'notrack', 'meta', 'ct', 'state', 'mark', 'fib', 'rt', 'flow', 'add', 'update',
]);

/**
 * Splits nft text into tokens for colouring. It only colours; it never decides
 * meaning, so an unusual construct just stays plain.
 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const groups = match.groups!;
    const kind: TokenKind =
      groups['string'] !== undefined
        ? 'string'
        : groups['comment'] !== undefined
          ? 'comment'
          : groups['ref'] !== undefined
            ? 'ref'
            : groups['number'] !== undefined
              ? 'number'
              : wordKind(groups['word']!);
    if (kind === 'plain') continue;
    if (match.index > last) tokens.push({ kind: 'plain', text: text.slice(last, match.index) });
    tokens.push({ kind, text: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) tokens.push({ kind: 'plain', text: text.slice(last) });
  return tokens;
}

function wordKind(word: string): TokenKind {
  if (ACCEPT.has(word)) return 'accept';
  if (DROP.has(word)) return 'drop';
  if (JUMP.has(word)) return 'jump';
  if (KEYWORDS.has(word)) return 'keyword';
  return 'plain';
}
