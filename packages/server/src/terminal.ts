// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

/**
 * Control characters but line breaks and tabs (C0, DEL, C1), and the Unicode
 * marks that reorder text: what a terminal would act on rather than show.
 */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/**
 * Text for this machine's terminal, which hosts' output can reach through
 * error messages: control characters are shown as \xNN or \uNNNN instead of
 * acting. Unescaped, a host could clear the screen, hide text, or set the
 * clipboard (OSC 52) to a command for the admin to paste.
 */
export function forTerminal(text: string): string {
  return text.replace(CONTROL, (char) => {
    const code = char.charCodeAt(0);
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

/** An error as console.error would print it, made safe for the terminal. */
export function errorForTerminal(error: unknown): string {
  return forTerminal(error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error));
}
