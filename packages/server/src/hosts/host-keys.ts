// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { HostKey, HostKeyCheck } from '@hopdeck/core';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HostError } from './errors.ts';
import { DEFAULT_TIMEOUT_MS, runProcess } from './process.ts';
import { sshFailure } from './ssh.ts';

/** What `ssh -G` reports for a destination, as far as host keys are concerned. */
export interface HostKeySettings {
  hostname: string;
  port: number;
  hostKeyAlias: string | undefined;
  userKnownHostsFiles: string[];
  globalKnownHostsFiles: string[];
  hashKnownHosts: boolean;
}

export interface HostKeysOptions {
  /** The ssh config file hopdeck uses instead of ~/.ssh/config, if any. */
  configFile?: string | undefined;
  sshPath?: string;
  sshKeygenPath?: string;
  timeoutMs?: number;
}

interface PresentedKey extends HostKey {
  /** Base64 key blob, as in known_hosts. */
  key: string;
}

/**
 * Reads and records SSH host keys with the user's own ssh configuration, so the
 * result is what ssh itself would check: same known_hosts files, host name form
 * and hashing.
 */
export class HostKeys {
  readonly #configArgs: string[];
  readonly #ssh: string;
  readonly #keygen: string;
  readonly #timeoutMs: number;

  constructor(options: HostKeysOptions = {}) {
    this.#configArgs = options.configFile !== undefined ? ['-F', options.configFile] : [];
    this.#ssh = options.sshPath ?? 'ssh';
    this.#keygen = options.sshKeygenPath ?? 'ssh-keygen';
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async check(destination: string): Promise<HostKeyCheck> {
    const settings = await this.settings(destination);
    const name = knownHostsName(settings);
    const presented = await this.#presented(destination);
    const known = await this.#known(name, [...settings.userKnownHostsFiles, ...settings.globalKnownHostsFiles]);
    return {
      name,
      knownHostsFile: settings.userKnownHostsFiles[0] ?? '',
      presented: { type: presented.type, fingerprint: presented.fingerprint },
      known,
    };
  }

  /**
   * Records the key the server presents now, but only if its fingerprint is the
   * one the user confirmed; the server is asked again rather than trusting what
   * the browser sends. Replacing a different known key needs `replace`.
   */
  async trust(destination: string, fingerprint: string, replace: boolean): Promise<void> {
    const settings = await this.settings(destination);
    const name = knownHostsName(settings);
    const file = settings.userKnownHostsFiles[0];
    if (file === undefined || file === '/dev/null') {
      throw new HostError('known-hosts-unwritable', `the ssh configuration of ${destination} sets UserKnownHostsFile to ${file ?? 'nothing'}`);
    }

    const presented = await this.#presented(destination);
    if (presented.fingerprint !== fingerprint) {
      throw new HostError('host-key-mismatch', `the server now presents ${presented.fingerprint}, not the confirmed ${fingerprint}`);
    }

    const known = await this.#known(name, [...settings.userKnownHostsFiles, ...settings.globalKnownHostsFiles]);
    const others = known.filter((key) => key.fingerprint !== presented.fingerprint);
    if (others.length > 0) {
      if (!replace) {
        throw new HostError('ssh-host-key-changed', `known_hosts has a different key for ${name}: ${others.map((key) => key.fingerprint).join(', ')}`);
      }
      const global = others.filter((key) => settings.globalKnownHostsFiles.includes(key.file));
      if (global.length > 0) {
        throw new HostError('host-key-in-global-file', `the old key is in ${[...new Set(global.map((key) => key.file))].join(', ')}, which only root can change`);
      }
      // ssh-keygen -R keeps the previous file as FILE.old.
      for (const oldFile of new Set(others.map((key) => key.file))) {
        const removed = await runProcess(this.#keygen, ['-R', name, '-f', oldFile], { timeoutMs: this.#timeoutMs });
        if (removed.exitCode !== 0) throw new HostError('command-failed', removed.stderr.trim());
      }
    } else if (known.some((key) => settings.userKnownHostsFiles.includes(key.file))) {
      return;
    }

    const entry = `${settings.hashKnownHosts ? hashName(name) : name} ${presented.type} ${presented.key}\n`;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const current = await readFile(file, 'utf8').catch(() => '');
    await appendFile(file, current === '' || current.endsWith('\n') ? entry : `\n${entry}`, { mode: 0o600 });
  }

  async settings(destination: string): Promise<HostKeySettings> {
    const result = await runProcess(this.#ssh, [...this.#configArgs, '-G', '--', destination], { timeoutMs: this.#timeoutMs });
    if (result.exitCode !== 0) throw new HostError('command-failed', result.stderr.trim());
    return parseSshSettings(result.stdout);
  }

  /**
   * Connects with every authentication method off and a throwaway known_hosts:
   * the server's key gets recorded during key exchange, and nothing is ever sent
   * to the unverified server. Unlike ssh-keyscan, this honours ProxyJump and
   * the rest of the ssh configuration.
   */
  async #presented(destination: string): Promise<PresentedKey> {
    const dir = await mkdtemp(join(tmpdir(), 'hopdeck-hostkey-'));
    const file = join(dir, 'known_hosts');
    try {
      const result = await runProcess(
        this.#ssh,
        [
          ...this.#configArgs,
          '-T',
          ...['-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none'],
          ...['-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${file}`],
          ...['-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'HashKnownHosts=no', '-o', 'CheckHostIP=no'],
          ...['-o', 'PubkeyAuthentication=no', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no'],
          ...['-o', 'GSSAPIAuthentication=no', '-o', 'HostbasedAuthentication=no'],
          '--',
          destination,
          'true',
        ],
        { timeoutMs: this.#timeoutMs },
      );
      const line = (await readFile(file, 'utf8').catch(() => '')).split('\n').find((text) => text.trim() !== '');
      if (line === undefined) {
        throw new HostError(sshFailure(result.stderr) ?? 'ssh-connect', result.stderr.trim());
      }
      const [, type, key] = line.split(/\s+/) as [string, string, string];
      return { type, key, fingerprint: fingerprint(key) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async #known(name: string, files: readonly string[]): Promise<(HostKey & { file: string })[]> {
    const found: (HostKey & { file: string })[] = [];
    for (const file of files) {
      // Exit code 1: no match or no such file.
      const result = await runProcess(this.#keygen, ['-F', name, '-f', file], { timeoutMs: this.#timeoutMs });
      if (result.exitCode !== 0) continue;
      for (const line of result.stdout.split('\n')) {
        if (line.trim() === '' || line.startsWith('#') || line.startsWith('@')) continue;
        const [, type, key] = line.split(/\s+/);
        if (type !== undefined && key !== undefined) found.push({ type, fingerprint: fingerprint(key), file });
      }
    }
    return found;
  }
}

/** `ssh -G` prints "keyword value" lines with the options ssh would use. */
export function parseSshSettings(output: string): HostKeySettings {
  const values = new Map<string, string>();
  for (const line of output.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0 && !values.has(line.slice(0, space))) values.set(line.slice(0, space), line.slice(space + 1).trim());
  }
  const list = (key: string) => (values.get(key) ?? '').split(/\s+/).filter((path) => path !== '' && path !== 'none');
  return {
    hostname: values.get('hostname') ?? '',
    port: Number(values.get('port') ?? 22),
    hostKeyAlias: values.get('hostkeyalias'),
    userKnownHostsFiles: list('userknownhostsfile'),
    globalKnownHostsFiles: list('globalknownhostsfile'),
    hashKnownHosts: values.get('hashknownhosts') === 'yes',
  };
}

/** The name ssh looks up in known_hosts: the alias if set, "[host]:port" for other ports. */
export function knownHostsName(settings: HostKeySettings): string {
  if (settings.hostKeyAlias !== undefined) return settings.hostKeyAlias;
  return settings.port === 22 ? settings.hostname : `[${settings.hostname}]:${settings.port}`;
}

/** "SHA256:..." as ssh-keygen -l prints it. */
export function fingerprint(base64Key: string): string {
  const digest = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/** The HashKnownHosts form of a name: |1|salt|HMAC-SHA1(salt, name). */
export function hashName(name: string): string {
  const salt = randomBytes(20);
  return `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(name).digest('base64')}`;
}
