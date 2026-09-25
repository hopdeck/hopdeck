import { createHash } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExecOptions, ExecResult, Executor } from '@nftm/core';
import { HostError, type HostErrorCode } from './errors.ts';
import { DEFAULT_TIMEOUT_MS, runProcess } from './process.ts';
import { shellCommand } from './shell-quote.ts';

export interface SshExecutorOptions {
  /** Anything ssh accepts: "fw1", "admin@10.0.0.1", a Host alias from ~/.ssh/config. */
  destination: string;
  /** Private directory for ControlMaster sockets, see ensureControlDir(). */
  controlDir: string;
  /** Replaces ~/.ssh/config (ssh -F), e.g. to reach a test host without touching the user's setup. */
  configFile?: string | undefined;
  /** Defaults to "ssh" from PATH. */
  sshPath?: string;
  timeoutMs?: number;
  /**
   * false: a new connection for every command, sharing nothing. After a change,
   * that proves new connections still get through; a shared connection would
   * survive a rule that blocks every new one.
   */
  shareConnection?: boolean;
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
    if (!isValidDestination(options.destination)) {
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
      ...(options.configFile !== undefined ? ['-F', options.configFile] : []),
      '-T',
      ...['-o', 'BatchMode=yes'],
      ...['-o', 'ConnectTimeout=10'],
      ...(options.shareConnection === false
        ? ['-o', 'ControlMaster=no', '-o', 'ControlPath=none']
        : [
            ...['-o', 'ControlMaster=auto'],
            ...['-o', `ControlPath=${join(options.controlDir, controlName(options.destination, options.configFile))}`],
            ...['-o', 'ControlPersist=60'],
          ]),
    ];
  }

  /** Rejects with a HostError when ssh itself fails; the remote command's exit code is returned as is. */
  async exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    if (argv.length === 0) throw new Error('empty command');
    const args = [...this.#sshArgs, '--', this.host, shellCommand(argv)];
    const result = await runProcess(this.#sshPath, args, { stdin: options.stdin, timeoutMs: this.#timeoutMs });
    const failure = result.exitCode === 255 ? sshFailure(result.stderr) : undefined;
    if (failure !== undefined) throw new HostError(failure, result.stderr.trim());
    return result;
  }
}

/**
 * One shared connection per nftm host. ssh's own %C hashes the resolved user,
 * address and port, so two aliases for the same server (say, with different
 * known_hosts) would share a connection, and the second would skip its host
 * key check. Hashing exactly what nftm asks ssh for avoids that; the hash also
 * keeps the socket path short.
 */
function controlName(destination: string, configFile: string | undefined): string {
  return createHash('sha256').update(`${destination}\0${configFile ?? ''}`).digest('hex').slice(0, 32);
}

/** A leading "-" would turn the destination into an ssh option such as -oProxyCommand=... */
export function isValidDestination(destination: string): boolean {
  return destination.length > 0 && destination.length <= 255 && !destination.startsWith('-') && !/\s/.test(destination);
}

/**
 * ssh exits with 255 on its own errors, but a remote command may do the same,
 * so the message decides. OpenSSH messages are not localized.
 */
export function sshFailure(stderr: string): HostErrorCode | undefined {
  // A changed key can mean a man-in-the-middle; it must never look like a first contact.
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/.test(stderr)) return 'ssh-host-key-changed';
  if (/Host key verification failed|No .*host key is known/.test(stderr)) return 'ssh-host-key';
  if (/Permission denied|Too many authentication failures/.test(stderr)) return 'ssh-auth';
  if (/^ssh: |Connection (refused|timed out|closed|reset)|Could not resolve|No route to host/m.test(stderr)) {
    return 'ssh-connect';
  }
  return undefined;
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
