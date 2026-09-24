import type { ExecOptions, ExecResult, Executor } from '@nftm/core';
import { DEFAULT_TIMEOUT_MS, runProcess } from './process.ts';

/** Runs commands on the machine nftm itself runs on. */
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
