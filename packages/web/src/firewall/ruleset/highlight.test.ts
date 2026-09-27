// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import { tokenize } from './highlight.ts';

const kinds = (text: string) => tokenize(text).filter((token) => token.kind !== 'plain').map((t) => [t.kind, t.text]);

describe('tokenize', () => {
  it('keeps every character', () => {
    const text = 'ip saddr @admins tcp dport { 22, 80 } accept comment "a # b" # handle 7';
    expect(tokenize(text).map((token) => token.text).join('')).toBe(text);
  });

  it('colours verdicts, strings, references, numbers and comments', () => {
    expect(kinds('ip saddr @admins tcp dport 22 accept comment "ssh # admins" # handle 7')).toEqual([
      ['ref', '@admins'],
      ['number', '22'],
      ['accept', 'accept'],
      ['keyword', 'comment'],
      ['string', '"ssh # admins"'],
      ['comment', '# handle 7'],
    ]);
    expect(kinds('ip saddr 10.0.0.0/24 drop')).toEqual([
      ['number', '10.0.0.0/24'],
      ['drop', 'drop'],
    ]);
    expect(kinds('tcp dport vmap @port_policy')).toEqual([
      ['keyword', 'vmap'],
      ['ref', '@port_policy'],
    ]);
    expect(kinds('jump DOCKER-USER')).toEqual([['jump', 'jump']]);
  });

  it('leaves identifiers containing keywords alone', () => {
    expect(kinds('iifname "eth0" oifname lo-accept')).toEqual([['string', '"eth0"']]);
  });
});
