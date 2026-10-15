// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runProcess } from './process.ts';
import { shellCommand, shellQuote } from './shell-quote.ts';

const TRICKY = [
  '',
  'plain',
  '/usr/sbin/nft',
  'with space',
  "it's",
  'a"b',
  '$HOME',
  '`id`',
  '$(id)',
  'back\\slash',
  'new\nline',
  '*',
  '~',
  '#comment',
  '-n',
  'FOO=bar',
  ';rm -rf /',
  '!!',
  'zażółć',
  "'",
  "''",
];

describe('shellQuote', () => {
  it('leaves simple words alone and single-quotes the rest', () => {
    expect(shellQuote('list')).toBe('list');
    expect(shellQuote('/usr/sbin/nft')).toBe('/usr/sbin/nft');
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('')).toBe("''");
  });

  // What a remote login shell does with the command line ssh hands it.
  for (const shell of ['/bin/sh', '/bin/bash', '/bin/dash', '/usr/bin/zsh'].filter((path) => existsSync(path))) {
    it(`survives a round trip through ${shell}`, async () => {
      const result = await runProcess(shell, ['-c', shellCommand(['printf', '[%s]', ...TRICKY])], {
        timeoutMs: 5000,
      });
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(TRICKY.map((arg) => `[${arg}]`).join(''));
    });
  }
});
