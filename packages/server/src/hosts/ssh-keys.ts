// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { SshKeyInfo, SshKeysView } from '@hopdeck/core';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
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
  #agent: ChildProcessWithoutNullStreams | undefined;

  constructor(options: SshKeysOptions) {
    this.#options = options;
  }

  /** Finds the session's agent, or starts hopdeck's own. */
  async start(): Promise<void> {
    const session = process.env['SSH_AUTH_SOCK'];
    if (this.#options.sessionAgent !== false && session && (await reachable(session))) {
      this.#socket = session;
      return;
    }
    const socket = join(this.#options.runtimeDir, 'agent.sock');
    await rm(socket, { force: true });
    // The agent lives as long as its input stays open: when hopdeck exits,
    // even by crashing, cat ends and takes the agent and its keys with it.
    const keeper = spawn('sh', ['-c', 'ssh-agent -D -a "$1" >/dev/null 2>&1 & agent=$!; cat >/dev/null; kill "$agent"', 'sh', socket], { stdio: 'pipe' });
    this.#agent = keeper;
    for (let attempt = 0; attempt < 50 && !existsSync(socket); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!existsSync(socket)) throw new HostError('spawn-failed', `ssh-agent did not start at ${socket}`);
    this.#socket = socket;
    this.#kind = 'hopdeck';
  }

  /** What ssh needs to use this agent. */
  get env(): Readonly<Record<string, string>> {
    return this.#socket === undefined ? {} : { SSH_AUTH_SOCK: this.#socket };
  }

  /** The keys ssh would offer the destination, with what they need. */
  async list(destination: string): Promise<SshKeysView> {
    const files = await this.#identityFiles(destination);
    const loaded = await this.#loaded();
    const keys: SshKeyInfo[] = [];
    for (const file of files) keys.push({ file, ...(await describe(file)), loaded: false });
    for (const key of keys) key.loaded = loaded.has(key.fingerprint);
    return { agent: this.#kind, keys };
  }

  /**
   * Adds a key to the agent with its passphrase, for `seconds` or as long as
   * the agent runs. Only a key ssh would offer the destination.
   */
  async unlock(destination: string, file: string, passphrase: string, seconds: number | undefined): Promise<SshKeysView> {
    if (!(await this.#identityFiles(destination)).includes(file)) {
      throw new HostError('command-failed', `${file} is not a key ssh offers ${destination}`);
    }
    if (seconds !== undefined && !(Number.isInteger(seconds) && seconds > 0 && seconds <= MAX_KEY_LIFETIME)) {
      throw new HostError('command-failed', `a key's lifetime must be 1 to ${MAX_KEY_LIFETIME} seconds`);
    }
    const dir = await mkdtemp(join(tmpdir(), 'hopdeck-askpass-'));
    try {
      await chmod(dir, 0o700);
      const askpass = join(dir, 'askpass');
      // ssh-add asks again after a wrong passphrase; the second time the answer is no.
      await writeFile(askpass, '#!/bin/sh\n[ -e "$HOPDECK_ASKPASS_DIR/asked" ] && exit 1\n: > "$HOPDECK_ASKPASS_DIR/asked"\nprintf \'%s\\n\' "$HOPDECK_ASKPASS_SECRET"\n', {
        mode: 0o700,
      });
      const added = await runProcess('ssh-add', [...(seconds === undefined ? [] : ['-t', String(seconds)]), '--', file], {
        timeoutMs: 15_000,
        env: {
          ...this.env,
          SSH_ASKPASS: askpass,
          SSH_ASKPASS_REQUIRE: 'force',
          HOPDECK_ASKPASS_DIR: dir,
          HOPDECK_ASKPASS_SECRET: passphrase,
        },
      });
      if (added.exitCode !== 0) {
        if (existsSync(join(dir, 'asked'))) {
          throw new HostError('wrong-passphrase', added.stderr.trim() || `ssh-add did not accept the passphrase of ${file}`);
        }
        throw new HostError('command-failed', added.stderr.trim() || `ssh-add exited with code ${added.exitCode}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
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

function expandHome(path: string): string {
  if (path === '~' || path.startsWith('~/')) return join(homedir(), path.slice(1));
  return path.replace(/%d/g, homedir());
}
