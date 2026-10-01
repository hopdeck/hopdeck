// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { RSA_BITS, type KeyType, type SshKeyInfo, type SshKeysView } from '@hopdeck/core';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { isSea } from 'node:sea';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  /**
   * Who ends a key's time: the agent (ssh-add -t), or hopdeck, which removes
   * the key itself, for an agent that takes no time limit (Windows'). By
   * default, hopdeck for Windows' agent and the agent otherwise.
   */
  lifetimes?: 'agent' | 'hopdeck';
  /** Where new keys go; ~/.ssh by default. */
  sshDir?: string;
}

/** An SSH host as ssh reaches it: its destination, and the key hopdeck adds for it, if any (ssh -i). */
export interface SshTarget {
  destination: string;
  identityFile?: string | undefined;
}

/** What a new key is to be. */
export interface KeySpec {
  type: KeyType;
  /** RSA only: 2048, 3072 or 4096. */
  bits?: number | undefined;
  /** Its file's name in ~/.ssh, e.g. id_ed25519_hopdeck. */
  name: string;
  comment: string;
  /** Empty: none, so whoever has the file can use the key. */
  passphrase: string;
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
  /** Keys hopdeck removes itself when their time is up, by fingerprint. */
  readonly #expiring = new Map<string, { file: string; timer: ReturnType<typeof setTimeout> }>();

  constructor(options: SshKeysOptions) {
    this.#options = options;
  }

  /**
   * Finds the session's agent, or starts hopdeck's own. Without either,
   * hopdeck still runs: keys without a passphrase work, and unlocking says why
   * it cannot.
   */
  async start(): Promise<void> {
    if (process.platform === 'win32') {
      // Windows' agent is a service, which ssh finds without SSH_AUTH_SOCK; hopdeck cannot start one.
      if (this.#options.sessionAgent !== false && (await reachable(undefined))) {
        this.#kind = 'windows';
        return;
      }
      this.#none('the OpenSSH Authentication Agent service is not running; start it in PowerShell as administrator: Set-Service ssh-agent -StartupType Manual; Start-Service ssh-agent');
      return;
    }
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

  /** The keys ssh would offer the host, with what they need. */
  async list(target: SshTarget): Promise<SshKeysView> {
    const files = await this.#identityFiles(target);
    const loaded = this.#kind === 'none' ? new Set<string>() : await this.#loaded();
    const keys: SshKeyInfo[] = [];
    for (const file of files) keys.push({ file, ...(await describe(file)), loaded: false });
    for (const key of keys) key.loaded = loaded.has(key.fingerprint);
    return {
      agent: this.#kind,
      ...(this.#unavailable !== undefined && { agentError: this.#unavailable }),
      keys,
      ...(target.identityFile !== undefined && { remembered: target.identityFile }),
    };
  }

  /**
   * Generates a key in ~/.ssh with ssh-keygen, never over an existing file.
   * The passphrase goes to ssh-keygen through askpass, which it asks twice
   * (the passphrase, then again to confirm), never on its command line.
   */
  async generate(spec: KeySpec): Promise<{ file: string; type: string; fingerprint: string; comment: string; publicKey: string; encrypted: boolean }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(spec.name) || spec.name.endsWith('.pub')) {
      throw new HostError('command-failed', `a key's name is 1 to 64 letters, digits, ".", "_" or "-", not ending in .pub: ${JSON.stringify(spec.name)}`);
    }
    if (spec.type === 'rsa' && !(RSA_BITS as readonly number[]).includes(spec.bits ?? 0)) {
      throw new HostError('command-failed', `an RSA key has ${RSA_BITS.join(', ')} bits, not ${spec.bits}`);
    }
    if (/[\r\n]/.test(spec.comment) || spec.comment.length > 200) throw new HostError('command-failed', 'a key\'s comment is one line of up to 200 characters');
    const dir = this.#options.sshDir ?? join(homedir(), '.ssh');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, spec.name);
    for (const taken of [file, `${file}.pub`]) {
      if (existsSync(taken)) throw new HostError('key-exists', taken);
    }
    const args = ['-q', '-t', spec.type, ...(spec.type === 'rsa' ? ['-b', String(spec.bits)] : []), '-C', spec.comment, '-f', file];
    const made =
      spec.passphrase === ''
        ? await runProcess('ssh-keygen', [...args, '-N', ''], { timeoutMs: 60_000 })
        : (await withAskpass(spec.passphrase, (askpass) => runProcess('ssh-keygen', args, { timeoutMs: 60_000, env: askpass }), { answers: 2 })).result;
    if (made.exitCode !== 0 || !existsSync(file)) {
      throw new HostError('command-failed', made.stderr.trim() || `ssh-keygen exited with code ${made.exitCode}`);
    }
    const described = await describe(file);
    return { file, ...described, publicKey: (await readFile(`${file}.pub`, 'utf8')).trim() };
  }

  /**
   * Adds a key to the agent with its passphrase, for `seconds` or as long as
   * the agent runs. Only a key ssh would offer the host.
   */
  async unlock(target: SshTarget, file: string, passphrase: string, seconds: number | undefined): Promise<SshKeysView> {
    await this.#offered(target, file);
    if (this.#unavailable !== undefined) throw new HostError('spawn-failed', `no ssh-agent can hold the key: ${this.#unavailable}`);
    if (seconds !== undefined && !(Number.isInteger(seconds) && seconds > 0 && seconds <= MAX_KEY_LIFETIME)) {
      throw new HostError('command-failed', `a key's lifetime must be 1 to ${MAX_KEY_LIFETIME} seconds`);
    }
    // Windows' agent refuses a key with a time limit ("agent refused operation").
    const byHopdeck = (this.#options.lifetimes ?? (this.#kind === 'windows' ? 'hopdeck' : 'agent')) === 'hopdeck';
    const limit = seconds === undefined || byHopdeck ? [] : ['-t', String(seconds)];
    const { result: added, askedAgain } = await withAskpass(passphrase, (askpass) =>
      runProcess('ssh-add', [...limit, '--', file], {
        timeoutMs: 15_000,
        env: { ...this.env, ...askpass },
      }),
    );
    if (added.exitCode !== 0) {
      const said = added.stderr.trim();
      // Asked again ("Bad passphrase, try again"): the passphrase. Anything else, such as the agent refusing the key, is not.
      if (askedAgain) throw new HostError('wrong-passphrase', said || `ssh-add did not accept the passphrase of ${file}`);
      throw new HostError('command-failed', said || `ssh-add exited with code ${added.exitCode}`);
    }
    if (byHopdeck) {
      const { fingerprint } = await describe(file);
      clearTimeout(this.#expiring.get(fingerprint)?.timer);
      this.#expiring.delete(fingerprint);
      if (seconds !== undefined) {
        const timer = setTimeout(() => void this.#remove(fingerprint), seconds * 1000);
        // A key's time is no reason for hopdeck to keep running.
        timer.unref();
        this.#expiring.set(fingerprint, { file, timer });
      }
    }
    return this.list(target);
  }

  /** Takes a key hopdeck timed out of the agent, by its public half. */
  async #remove(fingerprint: string): Promise<void> {
    const entry = this.#expiring.get(fingerprint);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.#expiring.delete(fingerprint);
    const listed = await runProcess('ssh-add', ['-L'], { timeoutMs: 10_000, env: this.env }).catch(() => undefined);
    for (const candidate of listed?.stdout.split('\n') ?? []) {
      const line = authorizedKeyLine(candidate);
      if (line === undefined || (await fingerprintOf(line)) !== fingerprint) continue;
      const dir = await mkdtemp(join(tmpdir(), 'hopdeck-key-'));
      try {
        await writeFile(join(dir, 'key.pub'), `${line}\n`);
        await runProcess('ssh-add', ['-d', join(dir, 'key.pub')], { timeoutMs: 10_000, env: this.env });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      return;
    }
  }

  /** Stops hopdeck's own agent, if it started one. */
  async close(): Promise<void> {
    // Keys hopdeck was to take out go now: after hopdeck, nothing would.
    await Promise.allSettled([...this.#expiring.keys()].map((fingerprint) => this.#remove(fingerprint)));
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
  async publicKey(target: SshTarget, file: string): Promise<{ line: string; key: SshKeyInfo }> {
    await this.#offered(target, file);
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
      if (line !== undefined && (await fingerprintOf(line)) === key.fingerprint) return { line, key };
    }
    throw new HostError(
      'command-failed',
      `hopdeck cannot read the public half of ${file}: there is no ${file}.pub, and the key is locked. Unlock it, or run: ssh-keygen -y -f ${file} > ${file}.pub`,
    );
  }

  /** Throws unless ssh offers the host this key. */
  async #offered(target: SshTarget, file: string): Promise<void> {
    if (!(await this.#identityFiles(target)).includes(file)) {
      throw new HostError('command-failed', `${file} is not a key ssh offers ${target.destination}`);
    }
  }

  /** IdentityFile values ssh uses for the host (ssh -G), with hopdeck's own (-i) first, those that exist. */
  async #identityFiles(target: SshTarget): Promise<string[]> {
    const config = this.#options.configFile === undefined ? [] : ['-F', this.#options.configFile];
    const extra = target.identityFile === undefined ? [] : ['-i', target.identityFile];
    const shown = await runProcess('ssh', [...config, ...extra, '-G', '--', target.destination], { timeoutMs: 10_000 });
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

/** Whether an agent answers at the socket; undefined: where ssh looks by itself, as on Windows. */
async function reachable(socket: string | undefined): Promise<boolean> {
  // 0: keys, 1: no keys, 2: no agent there.
  const listed = await runProcess('ssh-add', ['-l'], { timeoutMs: 5_000, env: socket === undefined ? undefined : { SSH_AUTH_SOCK: socket } }).catch(() => undefined);
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
 * Runs `run` with SSH_ASKPASS set up to answer `secret` once (or `answers`
 * times), for ssh-add, ssh or ssh-keygen; `asked` says whether it was asked,
 * `askedAgain` whether it was asked once more than it answers, as after a
 * wrong secret. It answers no yes/no question, so a
 * host key to accept never gets the secret for an answer. The secret travels
 * in the environment of the program and the answering one only.
 *
 * On Linux a sh script answers. Windows has no sh: there hopdeck answers
 * itself (answerAskpass()), the executable directly, or from source through
 * a .cmd that runs Node.js with hopdeck's main script.
 */
export async function withAskpass<T>(
  secret: string,
  run: (env: Record<string, string>) => Promise<T>,
  options: { answers?: number } = {},
): Promise<{ result: T; asked: boolean; askedAgain: boolean }> {
  const dir = await mkdtemp(join(tmpdir(), 'hopdeck-askpass-'));
  try {
    await chmod(dir, 0o700);
    let askpass: string;
    const extra: Record<string, string> = {};
    if (process.platform === 'win32') {
      if (isSea()) {
        askpass = process.execPath;
      } else {
        askpass = join(dir, 'askpass.cmd');
        await writeFile(askpass, `@echo off\r\n"${process.execPath}" "${process.argv[1]}" %*\r\n`);
      }
      extra['HOPDECK_ASKPASS'] = '1';
      // OpenSSH before 8.4, as in Windows 10, knows no SSH_ASKPASS_REQUIRE and wants a DISPLAY.
      if (process.env['DISPLAY'] === undefined) extra['DISPLAY'] = 'hopdeck:0';
    } else {
      askpass = join(dir, 'askpass');
      await writeFile(askpass, ASKPASS_SCRIPT, { mode: 0o700 });
    }
    const result = await run({
      SSH_ASKPASS: askpass,
      SSH_ASKPASS_REQUIRE: 'force',
      HOPDECK_ASKPASS_DIR: dir,
      HOPDECK_ASKPASS_SECRET: secret,
      HOPDECK_ASKPASS_ANSWERS: String(options.answers ?? 1),
      ...extra,
    });
    return { result, asked: existsSync(join(dir, 'asked.1')), askedAgain: existsSync(join(dir, 'asked-again')) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * hopdeck as SSH_ASKPASS, where no sh can be (Windows): answers the secret
 * once, and never a yes/no question, as the sh script does. Returns the exit
 * code.
 */
export function answerAskpass(
  prompt: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  write: (text: string) => void = (text) => writeSync(1, text),
): number {
  const dir = env['HOPDECK_ASKPASS_DIR'];
  const secret = env['HOPDECK_ASKPASS_SECRET'];
  if (dir === undefined || secret === undefined || (prompt ?? '').includes('(yes/no')) return 1;
  let answer = 1;
  while (existsSync(join(dir, `asked.${answer}`))) answer += 1;
  if (answer > Number(env['HOPDECK_ASKPASS_ANSWERS'] ?? 1)) {
    writeFileSync(join(dir, 'asked-again'), '');
    return 1;
  }
  writeFileSync(join(dir, `asked.${answer}`), '');
  write(`${secret}\n`);
  return 0;
}

/**
 * The askpass script on Linux: the secret as many times as it may answer
 * (once, or twice where ssh-keygen asks to confirm a new passphrase), then
 * no, noted in "asked-again"; never an answer to a yes/no question.
 */
const ASKPASS_SCRIPT = [
  '#!/bin/sh',
  'case "${1-}" in *"(yes/no"*) exit 1 ;; esac',
  'd=$HOPDECK_ASKPASS_DIR',
  'n=1',
  'while [ -e "$d/asked.$n" ]; do n=$((n + 1)); done',
  'if [ "$n" -gt "${HOPDECK_ASKPASS_ANSWERS:-1}" ]; then : > "$d/asked-again"; exit 1; fi',
  ': > "$d/asked.$n"',
  "printf '%s\\n' \"$HOPDECK_ASKPASS_SECRET\"",
  '',
].join('\n');

/** A public key as one authorized_keys line: type, key, and a comment without control characters. */
export function authorizedKeyLine(text: string): string | undefined {
  const match = /^((?:sk-)?(?:ssh|ecdsa)-[a-z0-9@.-]+) ([A-Za-z0-9+/]+={0,3})(?: (.*))?$/.exec(text.trim());
  if (match === null) return undefined;
  const comment = (match[3] ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return `${match[1]} ${match[2]}${comment === '' ? '' : ` ${comment}`}`;
}

async function fingerprintOf(line: string): Promise<string | undefined> {
  const shown = await runProcess('ssh-keygen', ['-l', '-f', '-'], { stdin: `${line}\n`, timeoutMs: 5_000 });
  return /^\d+ (\S+) /.exec(shown.stdout)?.[1];
}

function expandHome(path: string): string {
  if (path === '~' || path.startsWith('~/')) return join(homedir(), path.slice(1));
  return path.replace(/%d/g, homedir());
}
