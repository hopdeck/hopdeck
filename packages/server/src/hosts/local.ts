// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { ExecOptions, ExecResult, Executor } from '@hopdeck/core';
import { DEFAULT_TIMEOUT_MS, runProcess } from './process.ts';

/** Runs commands on the machine hopdeck itself runs on. */
export class LocalExecutor implements Executor {
  readonly host = 'localhost';
  readonly #timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    const [file, ...args] = argv;
    if (file === undefined) return Promise.reject(new Error('empty command'));
    return runProcess(file, args, { stdin: options.stdin, timeoutMs: this.#timeoutMs });
  }
}
