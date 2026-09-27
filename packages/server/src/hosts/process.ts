// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { spawn } from 'node:child_process';
import type { ExecResult } from '@hopdeck/core';
import { HostError } from './errors.ts';

export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Output kept per stream. A ruleset with large sets stays well below it; a
 * host printing without end is stopped, so it cannot exhaust this machine's
 * memory.
 */
export const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export interface RunOptions {
  stdin?: string | undefined;
  timeoutMs: number;
  /** Defaults to MAX_OUTPUT_BYTES. */
  maxOutputBytes?: number;
  /** Variables set on top of this process's environment. */
  env?: Readonly<Record<string, string>> | undefined;
}

/**
 * Runs a program directly, without a shell, and collects its output. A non-zero
 * exit code is a normal result; failing to start or timing out rejects.
 */
export function runProcess(file: string, args: readonly string[], options: RunOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'pipe', ...(options.env !== undefined && { env: { ...process.env, ...options.env } }) });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const sizes = { stdout: 0, stderr: 0 };
    const limit = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    let timedOut = false;
    let tooLong: string | undefined;
    // Killing the program alone is not enough: a program it started may hold the
    // pipes open and go on writing. With our ends closed, it gets SIGPIPE.
    const stop = () => {
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const collect = (stream: 'stdout' | 'stderr', chunks: Buffer[]) => (chunk: Buffer) => {
      sizes[stream] += chunk.length;
      if (sizes[stream] > limit) {
        tooLong ??= stream;
        stop();
        return;
      }
      chunks.push(chunk);
    };

    child.stdout.on('data', collect('stdout', stdout));
    child.stderr.on('data', collect('stderr', stderr));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new HostError('spawn-failed', `${file}: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (tooLong !== undefined) {
        reject(new HostError('command-failed', `${file} printed more than ${limit} bytes on ${tooLong}, so it was stopped`));
      } else if (timedOut) {
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
