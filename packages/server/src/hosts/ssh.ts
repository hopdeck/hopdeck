import { chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExecOptions, ExecResult, Executor } from '@nftm/core';
import { DEFAULT_TIMEOUT_MS, runProcess } from './process.ts';
import { shellCommand } from './shell-quote.ts';

export interface SshExecutorOptions {
  /** Anything ssh accepts: "fw1", "admin@10.0.0.1", a Host alias from ~/.ssh/config. */
  destination: string;
  /** Private directory for ControlMaster sockets, see ensureControlDir(). */
  controlDir: string;
  /** Defaults to "ssh" from PATH. */
  sshPath?: string;
  timeoutMs?: number;
}

/**
 * Runs commands over the system OpenSSH client, so ~/.ssh/config, ProxyJump,
 * ssh-agent, FIDO keys and known_hosts all work as they do in a terminal.
 * A shared ControlMaster connection makes repeated commands cheap.
 */
export class SshExecutor implements Executor {
  readonly host: string;
  readonly #sshArgs: readonly string[];
  readonly #sshPath: string;
  readonly #timeoutMs: number;

  constructor(options: SshExecutorOptions) {
    // A leading "-" would turn the destination into an ssh option such as -oProxyCommand=...
    if (options.destination === '' || options.destination.startsWith('-') || /\s/.test(options.destination)) {
      throw new Error(`invalid SSH destination: ${JSON.stringify(options.destination)}`);
    }
    // ssh splits option values on whitespace and expands % tokens in ControlPath.
    if (/[\s%]/.test(options.controlDir)) {
      throw new Error(`control directory must not contain whitespace or %: ${options.controlDir}`);
    }
    this.host = options.destination;
    this.#sshPath = options.sshPath ?? 'ssh';
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#sshArgs = [
      '-T',
      ...['-o', 'BatchMode=yes'],
      ...['-o', 'ConnectTimeout=10'],
      ...['-o', 'ControlMaster=auto'],
      ...['-o', `ControlPath=${join(options.controlDir, '%C')}`],
      ...['-o', 'ControlPersist=60'],
    ];
  }

  exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    if (argv.length === 0) return Promise.reject(new Error('empty command'));
    const args = [...this.#sshArgs, '--', this.host, shellCommand(argv)];
    return runProcess(this.#sshPath, args, { stdin: options.stdin, timeoutMs: this.#timeoutMs });
  }
}

/**
 * Creates the directory for ControlMaster sockets, readable by the current user
 * only: anyone who can open a socket there can use the SSH connection.
 */
export async function ensureControlDir(): Promise<string> {
  const base = process.env['XDG_RUNTIME_DIR'] || join(homedir(), '.cache');
  const dir = join(base, 'nftm', 'ssh');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}
