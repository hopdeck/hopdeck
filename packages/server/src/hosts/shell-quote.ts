// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

/**
 * Quotes one argument for a POSIX shell. ssh hands the remote command to the
 * login shell as a single string, so every argument of a remote command must go
 * through this.
 */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@+:,./-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

export function shellCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ');
}
