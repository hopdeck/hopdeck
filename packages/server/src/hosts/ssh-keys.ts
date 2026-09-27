// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { SshKeyInfo, SshKeysView } from '@hopdeck/core';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { HostError } from './errors.ts';
import { runProcess } from './process.ts';

export interface SshKeysOptions {
  /** Replaces ~/.ssh/config, as for SshExecutor. */
  configFile?: string | undefined;
  /** Where hopdeck's own agent listens when the session has none; Unix socket paths must be short. */
  runtimeDir: string;
  /** false: never use the session's agent, e.g. in tests. */
  sessionAgent?: boolean;
}

/** Lifetimes a key may be given in an agent, in seconds; no lifetime keeps it as long as the agent runs. */
export const MAX_KEY_LIFETIME = 7 * 24 * 60 * 60;

/**
 * Private keys ssh offers to hosts, and the ssh-agent that holds them
 * unlocked: the login session's, or else hopdeck's own, which ends with
 * hopdeck. A passphrase goes to ssh-add once and is kept nowhere.
 */
export class SshKeys {
  readonly #options: SshKeysOptions;
  #socket: string | undefined;
  #kind: SshKeysView['agent'] = 'session';
  /** Why there is no agent, when there is none. */
  #unavailable: string | undefined;
  #agent: ChildProcessWithoutNullStreams | undefined;

  constructor(options: SshKeysOptions) {
    this.#options = options;
  }

  /**
   * Finds the session's agent, or starts hopdeck's own. Without either,
   * hopdeck still runs: keys without a passphrase work, and unlocking says why
   * it cannot.
   */
  async start(): Promise<void> {
    const session = process.env['SSH_AUTH_SOCK'];
    if (this.#options.sessionAgent !== false && session && (await reachable(session))) {
      this.#socket = session;
      return;
    }
    if (!onPath('ssh-agent')) {
      this.#none('ssh-agent is not installed (it comes with the OpenSSH client)');
      return;
    }
    // One per hopdeck process: another one, say a second panel, has its own.
    const socket = join(this.#options.runtimeDir, `agent-${process.pid}.sock`);
    await rm(socket, { force: true });
    // The agent lives as long as its input stays open: when hopdeck exits,
    // even by crashing, cat ends and takes the agent and its keys with it.
    const keeper = spawn('sh', ['-c', 'ssh-agent -D -a "$1" >/dev/null 2>&1 & agent=$!; cat >/dev/null; kill "$agent"', 'sh', socket], { stdio: 'pipe' });
    this.#agent = keeper;
    for (let attempt = 0; attempt < 50 && !existsSync(socket); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!existsSync(socket)) {
      keeper.stdin.end();
      this.#agent = undefined;
      this.#none(`ssh-agent did not start at ${socket}`);
      return;
    }
    this.#socket = socket;
    this.#kind = 'hopdeck';
  }

  #none(reason: string): void {
    this.#kind = 'none';
    this.#unavailable = reason;
  }

  /** What ssh needs to use this agent. */
  get env(): Readonly<Record<string, string>> {
    return this.#socket === undefined ? {} : { SSH_AUTH_SOCK: this.#socket };
  }

  /** The keys ssh would offer the destination, with what they need. */
  async list(destination: string): Promise<SshKeysView> {
    const files = await this.#identityFiles(destination);
    const loaded = this.#kind === 'none' ? new Set<string>() : await this.#loaded();
    const keys: SshKeyInfo[] = [];
    for (const file of files) keys.push({ file, ...(await describe(file)), loaded: false });
    for (const key of keys) key.loaded = loaded.has(key.fingerprint);
    return { agent: this.#kind, ...(this.#unavailable !== undefined && { agentError: this.#unavailable }), keys };
  }

  /**
   * Adds a key to the agent with its passphrase, for `seconds` or as long as
   * the agent runs. Only a key ssh would offer the destination.
   */
  async unlock(destination: string, file: string, passphrase: string, seconds: number | undefined): Promise<SshKeysView> {
    await this.#offered(destination, file);
    if (this.#unavailable !== undefined) throw new HostError('spawn-failed', `no ssh-agent can hold the key: ${this.#unavailable}`);
    if (seconds !== undefined && !(Number.isInteger(seconds) && seconds > 0 && seconds <= MAX_KEY_LIFETIME)) {
      throw new HostError('command-failed', `a key's lifetime must be 1 to ${MAX_KEY_LIFETIME} seconds`);
    }
    const { result: added, asked } = await withAskpass(passphrase, (askpass) =>
      runProcess('ssh-add', [...(seconds === undefined ? [] : ['-t', String(seconds)]), '--', file], {
        timeoutMs: 15_000,
        env: { ...this.env, ...askpass },
      }),
    );
    if (added.exitCode !== 0) {
      if (asked) throw new HostError('wrong-passphrase', added.stderr.trim() || `ssh-add did not accept the passphrase of ${file}`);
      throw new HostError('command-failed', added.stderr.trim() || `ssh-add exited with code ${added.exitCode}`);
    }
    return this.list(destination);
  }

  /** Stops hopdeck's own agent, if it started one. */
  async close(): Promise<void> {
    const agent = this.#agent;
    this.#agent = undefined;
    if (agent === undefined || agent.exitCode !== null) return;
    const exited = new Promise((resolve) => agent.once('exit', resolve));
    agent.stdin.end();
    await exited;
  }

  /**
   * The public half of a key ssh offers the destination, as one authorized_keys
   * line: from its .pub file, from the agent that holds it, or from the key
   * itself when it has no passphrase.
   */
  async publicKey(destination: string, file: string): Promise<{ line: string; key: SshKeyInfo }> {
    await this.#offered(destination, file);
    const key = { file, ...(await describe(file)), loaded: false };
    const candidates: string[] = [];
    if (existsSync(`${file}.pub`)) candidates.push((await readFile(`${file}.pub`, 'utf8')).trim());
    if (this.#kind !== 'none') {
      const listed = await runProcess('ssh-add', ['-L'], { timeoutMs: 10_000, env: this.env });
      if (listed.exitCode === 0) candidates.push(...listed.stdout.split('\n').filter(Boolean));
    }
    const opened = await runProcess('ssh-keygen', ['-y', '-P', '', '-f', file], { timeoutMs: 5_000 });
    if (opened.exitCode === 0) candidates.push(opened.stdout.trim());
    for (const candidate of candidates) {
      const line = authorizedKeyLine(candidate);
      if (line !== undefined && (await fingerprint(line)) === key.fingerprint) return { line, key };
    }
    throw new HostError(
      'command-failed',
      `hopdeck cannot read the public half of ${file}: there is no ${file}.pub, and the key is locked. Unlock it, or run: ssh-keygen -y -f ${file} > ${file}.pub`,
    );
  }

  /** Throws unless ssh offers the destination this key. */
  async #offered(destination: string, file: string): Promise<void> {
    if (!(await this.#identityFiles(destination)).includes(file)) {
      throw new HostError('command-failed', `${file} is not a key ssh offers ${destination}`);
    }
  }

  /** IdentityFile values ssh uses for the destination (ssh -G), those that exist. */
  async #identityFiles(destination: string): Promise<string[]> {
    const config = this.#options.configFile === undefined ? [] : ['-F', this.#options.configFile];
    const shown = await runProcess('ssh', [...config, '-G', '--', destination], { timeoutMs: 10_000 });
    if (shown.exitCode !== 0) throw new HostError('command-failed', shown.stderr.trim() || `ssh -G exited with code ${shown.exitCode}`);
    const files = shown.stdout
      .split('\n')
      .filter((line) => line.startsWith('identityfile '))
      .map((line) => expandHome(line.slice('identityfile '.length).trim()));
    return [...new Set(files)].filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
  }

  /** Fingerprints of the keys in the agent. */
  async #loaded(): Promise<Set<string>> {
    const listed = await runProcess('ssh-add', ['-l'], { timeoutMs: 10_000, env: this.env });
    return new Set(listed.stdout.split('\n').map((line) => line.split(' ')[1] ?? '').filter(Boolean));
  }
}

/** Whether a program is in one of PATH's directories. */
function onPath(program: string): boolean {
  return (process.env['PATH'] ?? '').split(delimiter).some((dir) => dir !== '' && existsSync(join(dir, program)));
}

async function reachable(socket: string): Promise<boolean> {
  // 0: keys, 1: no keys, 2: no agent there.
  const listed = await runProcess('ssh-add', ['-l'], { timeoutMs: 5_000, env: { SSH_AUTH_SOCK: socket } }).catch(() => undefined);
  return listed !== undefined && listed.exitCode !== 2;
}

/** A key's type, fingerprint and comment, and whether it needs a passphrase. */
async function describe(file: string): Promise<Omit<SshKeyInfo, 'file' | 'loaded'>> {
  // The public half is readable without the passphrase, from the .pub file or the key itself.
  const shown = await runProcess('ssh-keygen', ['-l', '-f', existsSync(`${file}.pub`) ? `${file}.pub` : file], { timeoutMs: 5_000 });
  // "256 SHA256:… comment words (ED25519)"
  const match = /^\d+ (\S+) (.*) \((\S+)\)$/.exec(shown.stdout.trim());
  const opened = await runProcess('ssh-keygen', ['-y', '-P', '', '-f', file], { timeoutMs: 5_000 });
  return {
    type: match?.[3] ?? 'unknown',
    fingerprint: match?.[1] ?? '',
    // ssh-keygen says "no comment" for a key without one.
    comment: match?.[2] === 'no comment' ? '' : (match?.[2] ?? ''),
    encrypted: opened.exitCode !== 0 && /passphrase/i.test(opened.stderr),
  };
}

/**
 * Runs `run` with SSH_ASKPASS set up to answer `secret` once, for ssh-add or
 * ssh; `asked` says whether it was asked. It answers no yes/no question, so a
 * host key to accept never gets the secret for an answer. The secret travels
 * in the environment of the program and the script only.
 */
export async function withAskpass<T>(secret: string, run: (env: Record<string, string>) => Promise<T>): Promise<{ result: T; asked: boolean }> {
  const dir = await mkdtemp(join(tmpdir(), 'hopdeck-askpass-'));
  try {
    await chmod(dir, 0o700);
    const askpass = join(dir, 'askpass');
    // After a wrong secret the program asks again; the second time the answer is no.
    await writeFile(
      askpass,
      '#!/bin/sh\ncase "${1-}" in *"(yes/no"*) exit 1 ;; esac\n[ -e "$HOPDECK_ASKPASS_DIR/asked" ] && exit 1\n: > "$HOPDECK_ASKPASS_DIR/asked"\nprintf \'%s\\n\' "$HOPDECK_ASKPASS_SECRET"\n',
      { mode: 0o700 },
    );
    const result = await run({ SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', HOPDECK_ASKPASS_DIR: dir, HOPDECK_ASKPASS_SECRET: secret });
    return { result, asked: existsSync(join(dir, 'asked')) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A public key as one authorized_keys line: type, key, and a comment without control characters. */
export function authorizedKeyLine(text: string): string | undefined {
  const match = /^((?:sk-)?(?:ssh|ecdsa)-[a-z0-9@.-]+) ([A-Za-z0-9+/]+={0,3})(?: (.*))?$/.exec(text.trim());
  if (match === null) return undefined;
  const comment = (match[3] ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return `${match[1]} ${match[2]}${comment === '' ? '' : ` ${comment}`}`;
}

async function fingerprint(line: string): Promise<string | undefined> {
  const shown = await runProcess('ssh-keygen', ['-l', '-f', '-'], { stdin: `${line}\n`, timeoutMs: 5_000 });
  return /^\d+ (\S+) /.exec(shown.stdout)?.[1];
}

function expandHome(path: string): string {
  if (path === '~' || path.startsWith('~/')) return join(homedir(), path.slice(1));
  return path.replace(/%d/g, homedir());
}
