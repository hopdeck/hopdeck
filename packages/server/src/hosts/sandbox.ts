import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { ExecOptions, ExecResult, Executor } from '@hopdeck/core';
import { HostError } from './errors.ts';
import { collectFacts } from './facts.ts';
import { DEFAULT_TIMEOUT_MS, runProcess } from './process.ts';

/**
 * A private user and network namespace with its own, initially empty, nftables
 * ruleset. It needs no root: inside, the current user is mapped to root. The
 * real firewall is never touched.
 *
 * A keep-alive process holds the namespaces open. It reads its standard input
 * from hopdeck, so when hopdeck exits, even by crashing, the input closes, the process
 * ends and the namespaces disappear.
 */
export class Sandbox {
  readonly executor: Executor;
  readonly #keeper: ChildProcessWithoutNullStreams;

  private constructor(keeper: ChildProcessWithoutNullStreams, timeoutMs: number) {
    this.#keeper = keeper;
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
    const sandbox = new Sandbox(keeper, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
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
    const facts = await collectFacts(this.executor);
    if (facts.nft === undefined) throw new HostError('nft-missing');
    const result = await this.executor.exec([facts.nft.path, '-f', '-'], { stdin: `flush ruleset\n${ruleset}` });
    if (result.exitCode !== 0) throw new HostError('command-failed', result.stderr.trim());
  }

  async dispose(): Promise<void> {
    if (this.#keeper.exitCode !== null || this.#keeper.signalCode !== null) return;
    const exited = new Promise((resolve) => this.#keeper.once('exit', resolve));
    this.#keeper.stdin.end();
    await exited;
  }
}

/** A small but realistic firewall to explore in the sandbox. */
export function demoRuleset(): Promise<string> {
  return readFile(new URL('./sandbox-demo.nft', import.meta.url), 'utf8');
}

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
