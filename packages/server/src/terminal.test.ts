// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import { errorForTerminal, forTerminal } from './terminal.ts';

describe('forTerminal', () => {
  it('shows control characters instead of letting the terminal act on them', () => {
    // OSC 52 sets the clipboard; CSI 2J clears the screen; U+009B is CSI in one character.
    expect(forTerminal('\u001b]52;c;ZWNobyBoaQ==\u0007')).toBe('\\x1b]52;c;ZWNobyBoaQ==\\x07');
    expect(forTerminal('a\u001b[2Jb\u009b31mc\u007f')).toBe('a\\x1b[2Jb\\x9b31mc\\x7f');
    expect(forTerminal('ok\u202egnp.exe')).toBe('ok\\u202egnp.exe');
  });

  it('keeps line breaks, tabs and letters of any language', () => {
    expect(forTerminal('nft: błąd\n\tline 2 — ok')).toBe('nft: błąd\n\tline 2 — ok');
  });

  it('prints an error with its stack, escaped', () => {
    const printed = errorForTerminal(new SyntaxError('Unexpected token \u001b'));
    expect(printed).toMatch(/^SyntaxError: Unexpected token \\x1b\n\s+at /);
    expect(errorForTerminal('plain \u0007')).toBe('plain \\x07');
  });
});
