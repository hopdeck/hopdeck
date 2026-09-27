// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecOptions, ExecResult, Executor } from '@hopdeck/core';
import { HostError } from './errors.ts';
import { collectFacts } from './facts.ts';
import { DEFAULT_TIMEOUT_MS, runProcess } from './process.ts';
import { embedded } from '../web-files.ts';

/**
 * A private user and network namespace with its own, initially empty, nftables
 * ruleset. It needs no root: inside, the current user is mapped to root. The
 * real firewall is never touched.
 *
 * A keep-alive process holds the namespaces open. It reads its standard input
 * from hopdeck, so when hopdeck exits, even by crashing, the input closes, the process
 * ends and the namespaces disappear.
 *
 * The file system is the machine's own, so what hopdeck keeps on a host (the
 * history, settings) goes to a temporary directory instead, removed with the
 * sandbox.
 */
export class Sandbox {
  readonly executor: Executor;
  /** Stands in for / where hopdeck keeps its files on a host. */
  readonly directory: string;
  readonly #keeper: ChildProcessWithoutNullStreams;

  private constructor(keeper: ChildProcessWithoutNullStreams, timeoutMs: number, directory: string) {
    this.#keeper = keeper;
    this.directory = directory;
    this.executor = new SandboxExecutor(keeper.pid!, timeoutMs);
  }

  /** Fails when the system does not allow unprivileged user namespaces. */
  static async start(options: { timeoutMs?: number } = {}): Promise<Sandbox> {
    const keeper = spawn('unshare', ['--user', '--map-root-user', '--net', 'sh', '-c', 'echo ready; exec cat >/dev/null']);
    await new Promise<void>((resolve, reject) => {
      let stderr = '';
      keeper.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      keeper.stdout.once('data', () => resolve());
      keeper.once('error', reject);
      keeper.once('exit', () => reject(new Error(`cannot create sandbox: ${stderr.trim() || 'unshare exited'}`)));
    });
    const sandbox = new Sandbox(keeper, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, await mkdtemp(join(tmpdir(), 'hopdeck-sandbox-')));
    // Loopback lets the demo carry traffic to trace; the namespace has no other interface.
    await sandbox.executor.exec(['sh', '-c', 'PATH="$PATH:/usr/sbin:/sbin"; ip link set lo up']).catch(() => undefined);
    return sandbox;
  }


  /** PID of the keep-alive process that holds the namespaces. */
  get pid(): number {
    return this.#keeper.pid!;
  }

  /** Replaces the sandbox's ruleset, e.g. with demoRuleset(). */
  async load(ruleset: string): Promise<void> {
    await this.nft(`flush ruleset\n${ruleset}`);
  }

  /**
   * Runs nft input in the sandbox. It goes through a file: nft 1.0.9 (Ubuntu
   * 24.04) refuses "-f -" when its input is a socket, which is what a program
   * started from Node gets.
   */
  async nft(script: string): Promise<void> {
    const facts = await collectFacts(this.executor);
    if (facts.nft === undefined) throw new HostError('nft-missing');
    const file = join(this.directory, 'input.nft');
    await writeFile(file, script, { mode: 0o600 });
    const result = await this.executor.exec([facts.nft.path, '-f', file]);
    await rm(file, { force: true });
    if (result.exitCode !== 0) throw new HostError('command-failed', result.stderr.trim());
  }

  async dispose(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
    if (this.#keeper.exitCode !== null || this.#keeper.signalCode !== null) return;
    const exited = new Promise((resolve) => this.#keeper.once('exit', resolve));
    this.#keeper.stdin.end();
    await exited;
  }
}

/** A small but realistic firewall to explore in the sandbox. */
export async function demoRuleset(): Promise<string> {
  // Built into hopdeck as one executable, the file is an asset of it.
  return embedded(DEMO_ASSET)?.toString('utf8') ?? readFile(new URL(`./${DEMO_ASSET}`, import.meta.url), 'utf8');
}

/** The demo ruleset's file, next to this one, and its name among the executable's assets. */
export const DEMO_ASSET = 'sandbox-demo.nft';

class SandboxExecutor implements Executor {
  readonly host = 'sandbox';
  readonly #pid: string;
  readonly #timeoutMs: number;

  constructor(pid: number, timeoutMs: number) {
    this.#pid = String(pid);
    this.#timeoutMs = timeoutMs;
  }

  exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    if (argv.length === 0) return Promise.reject(new Error('empty command'));
    const args = ['--target', this.#pid, '--user', '--net', '--preserve-credentials', '--', ...argv];
    return runProcess('nsenter', args, { stdin: options.stdin, timeoutMs: this.#timeoutMs });
  }
}
