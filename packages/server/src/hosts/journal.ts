// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { Executor } from '@hopdeck/core';

/**
 * Adds a line to the host's system log, so `journalctl -t hopdeck` (or syslog)
 * shows what hopdeck did there. The log is a courtesy next to the history:
 * a host without `logger` loses the line, and the server's own output says so.
 */
export async function journal(executor: Executor, message: string): Promise<void> {
  const failure = await executor.exec(['logger', '-t', 'hopdeck', '--', message]).then(
    (result) => (result.exitCode === 0 ? undefined : result.stderr.trim() || `logger exited with code ${result.exitCode}`),
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  if (failure !== undefined) console.warn(`hopdeck: could not write to the system log of ${executor.host}: ${failure}`);
}
