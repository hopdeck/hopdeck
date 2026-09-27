// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { spawn } from 'node:child_process';
import type { ExecResult } from '@hopdeck/core';
import { HostError } from './errors.ts';

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface RunOptions {
  stdin?: string | undefined;
  timeoutMs: number;
}

/**
 * Runs a program directly, without a shell, and collects its output. A non-zero
 * exit code is a normal result; failing to start or timing out rejects.
 */
export function runProcess(file: string, args: readonly string[], options: RunOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'pipe' });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new HostError('spawn-failed', `${file}: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new HostError('timeout', `${file} timed out after ${options.timeoutMs} ms`));
      } else if (code === null) {
        reject(new HostError('command-failed', `${file} was killed by ${signal}`));
      } else {
        resolve({
          exitCode: code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      }
    });

    // EPIPE when the program exits without reading its input; the exit code tells the story.
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdin);
  });
}
