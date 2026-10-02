// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answerAskpass, SshKeys } from './ssh-keys.ts';

describe('SshKeys with hopdeck\'s own agent', () => {
  let dir: string;
  let keys: SshKeys;

  beforeAll(async () => {
    // Short: the agent's socket goes here, and Unix socket paths have a limit.
    dir = await mkdtemp('/tmp/hd-keys-');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'right passphrase', '-C', 'locked key', '-f', join(dir, 'locked')]);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'open key', '-f', join(dir, 'open')]);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'other key', '-f', join(dir, 'other')]);
    await writeFile(join(dir, 'config'), `Host fw1\n\tIdentityFile ${dir}/locked\n\tIdentityFile ${dir}/open\n\tIdentityFile ${dir}/missing\n`);
    keys = new SshKeys({ configFile: join(dir, 'config'), runtimeDir: dir, sessionAgent: false, sshDir: join(dir, 'ssh') });
    await keys.start();
  });

  afterAll(async () => {
    await keys.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('runs its own agent when asked not to use the session\'s, and ssh reaches it', async () => {
    expect(keys.env['SSH_AUTH_SOCK']).toBe(join(dir, `agent-${process.pid}.sock`));
    expect(existsSync(join(dir, `agent-${process.pid}.sock`))).toBe(true);
  });

  it('lists the keys ssh would offer the host, and which need a passphrase', async () => {
    const view = await keys.list({ destination: 'fw1' });
    expect(view.agent).toBe('hopdeck');
    expect(view.keys.map(({ file, type, comment, encrypted, loaded }) => ({ file, type, comment, encrypted, loaded }))).toEqual([
      { file: join(dir, 'locked'), type: 'ED25519', comment: 'locked key', encrypted: true, loaded: false },
      { file: join(dir, 'open'), type: 'ED25519', comment: 'open key', encrypted: false, loaded: false },
    ]);
    expect(view.keys[0]!.fingerprint).toMatch(/^SHA256:/);
  });

  it('says so when the passphrase is wrong, without asking again and again', async () => {
    await expect(keys.unlock({ destination: 'fw1' }, join(dir, 'locked'), 'wrong', 60)).rejects.toMatchObject({ code: 'wrong-passphrase' });
    expect((await keys.list({ destination: 'fw1' })).keys[0]!.loaded).toBe(false);
  });

  it('adds a key to the agent for as long as asked', async () => {
    const view = await keys.unlock({ destination: 'fw1' }, join(dir, 'locked'), 'right passphrase', 120);
    expect(view.keys[0]!.loaded).toBe(true);
    const listed = execFileSync('ssh-add', ['-l'], { env: { ...process.env, ...keys.env }, encoding: 'utf8' });
    expect(listed).toContain('locked key');
  });

  it('times a key out itself for an agent that takes no time limit, as Windows\' refuses one', async () => {
    // hopdeck's own agent stands for Windows': a second SshKeys uses it as the session's.
    const agent = keys.env['SSH_AUTH_SOCK']!;
    const session = process.env['SSH_AUTH_SOCK'];
    process.env['SSH_AUTH_SOCK'] = agent;
    const windowsLike = new SshKeys({ configFile: join(dir, 'config'), runtimeDir: dir, lifetimes: 'hopdeck' });
    try {
      await windowsLike.start();
    } finally {
      if (session === undefined) delete process.env['SSH_AUTH_SOCK'];
      else process.env['SSH_AUTH_SOCK'] = session;
    }
    const loaded = async () => (await keys.list({ destination: 'fw1' })).keys[0]!.loaded;
    execFileSync('ssh-add', ['-D'], { env: { ...process.env, SSH_AUTH_SOCK: agent }, stdio: 'ignore' });

    await windowsLike.unlock({ destination: 'fw1' }, join(dir, 'locked'), 'right passphrase', 1);
    expect(await loaded()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(await loaded()).toBe(false);

    // What is still timed goes when hopdeck stops.
    await windowsLike.unlock({ destination: 'fw1' }, join(dir, 'locked'), 'right passphrase', 3600);
    expect(await loaded()).toBe(true);
    await windowsLike.close();
    expect(await loaded()).toBe(false);
  });

  it('generates an Ed25519 key with a passphrase, never on the command line, and never over a file', async () => {
    const key = await keys.generate({ type: 'ed25519', name: 'id_ed25519_hopdeck', comment: 'ada@desk', passphrase: 'a long passphrase' });
    expect(key).toMatchObject({ file: join(dir, 'ssh', 'id_ed25519_hopdeck'), type: 'ED25519', comment: 'ada@desk', encrypted: true });
    expect(key.publicKey).toMatch(/^ssh-ed25519 \S+ ada@desk$/);
    expect((statSync(join(dir, 'ssh')).mode & 0o777).toString(8)).toBe('700');
    expect((statSync(key.file).mode & 0o777).toString(8)).toBe('600');
    // The passphrase opens it.
    expect(execFileSync('ssh-keygen', ['-y', '-P', 'a long passphrase', '-f', key.file], { encoding: 'utf8' })).toContain(key.publicKey.split(' ')[1]);
    expect(() => execFileSync('ssh-keygen', ['-y', '-P', 'wrong', '-f', key.file], { stdio: 'ignore' })).toThrow();
    await expect(keys.generate({ type: 'ed25519', name: 'id_ed25519_hopdeck', comment: '', passphrase: '' })).rejects.toMatchObject({ code: 'key-exists' });
  });

  it('generates RSA keys of 2048 bits and more only, and takes plain names only', async () => {
    const key = await keys.generate({ type: 'rsa', bits: 3072, name: 'id_rsa_hopdeck', comment: 'ada@desk', passphrase: '' });
    expect(key).toMatchObject({ type: 'RSA', encrypted: false });
    expect(execFileSync('ssh-keygen', ['-l', '-f', key.file], { encoding: 'utf8' })).toMatch(/^3072 /);
    await expect(keys.generate({ type: 'rsa', bits: 1024, name: 'weak', comment: '', passphrase: '' })).rejects.toThrow(/2048, 3072, 4096/);
    for (const name of ['../escape', '.hidden', 'key.pub', 'a b', '']) {
      await expect(keys.generate({ type: 'ed25519', name, comment: '', passphrase: '' }), name).rejects.toThrow(/name/);
    }
  });

  it('lists the private keys in its ssh directory, and nothing else there', async () => {
    const listed = join(dir, 'listed');
    await mkdir(join(listed, 'subdir'), { recursive: true });
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'a passphrase', '-C', 'new format', '-f', join(listed, 'id_ed25519')]);
    execFileSync('ssh-keygen', ['-q', '-t', 'rsa', '-b', '2048', '-m', 'PEM', '-N', '', '-C', 'pem format', '-f', join(listed, 'legacy_rsa')]);
    // A key without its .pub file still shows its public half.
    await rm(join(listed, 'legacy_rsa.pub'));
    await writeFile(join(listed, 'config'), 'Host *\n');
    await writeFile(join(listed, 'known_hosts'), 'fw1 ssh-ed25519 AAAA\n');
    await writeFile(join(listed, 'notes'), `-----BEGIN NOTHING-----\n${'x'.repeat(100_000)}\n`);
    const available = await new SshKeys({ runtimeDir: dir, sessionAgent: false, sshDir: listed }).available();
    expect(available.map(({ file, type, comment, encrypted }) => ({ file, type, comment, encrypted }))).toEqual([
      { file: join(listed, 'id_ed25519'), type: 'ED25519', comment: 'new format', encrypted: true },
      { file: join(listed, 'legacy_rsa'), type: 'RSA', comment: '', encrypted: false },
    ]);
    expect(available.every((key) => key.fingerprint.startsWith('SHA256:'))).toBe(true);
    expect(await new SshKeys({ runtimeDir: dir, sshDir: join(dir, 'nowhere') }).available()).toEqual([]);
  });

  it('offers the key hopdeck keeps for a host besides those ssh config names', async () => {
    const extra = join(dir, 'other');
    expect((await keys.list({ destination: 'fw1' })).keys.map((key) => key.file)).not.toContain(extra);
    const view = await keys.list({ destination: 'fw1', identityFile: extra });
    expect(view.keys.map((key) => key.file)).toContain(extra);
    expect(view.remembered).toBe(extra);
  });

  it('runs without an agent when there is none to be had, and says why unlocking cannot work', async () => {
    const path = process.env['PATH'];
    // A PATH without ssh-agent, as on a system with no OpenSSH client.
    process.env['PATH'] = join(dir, 'empty');
    const without = new SshKeys({ configFile: join(dir, 'config'), runtimeDir: dir, sessionAgent: false });
    try {
      await without.start();
    } finally {
      process.env['PATH'] = path;
    }
    expect(without.env).toEqual({});
    expect(await without.list({ destination: 'fw1' })).toMatchObject({ agent: 'none', agentError: expect.stringMatching(/ssh-agent is not installed/) });
    await expect(without.unlock({ destination: 'fw1' }, join(dir, 'locked'), 'right passphrase', 60)).rejects.toMatchObject({ code: 'spawn-failed' });
    await without.close();
  });

  it('refuses a key ssh would not offer the host, and a lifetime out of range', async () => {
    await expect(keys.unlock({ destination: 'fw1' }, join(dir, 'other'), '', 60)).rejects.toThrow(/not a key ssh offers fw1/);
    await expect(keys.unlock({ destination: 'fw1' }, join(dir, 'open'), '', 0)).rejects.toThrow(/lifetime/);
  });

  it('takes its agent and keys with it when it closes', async () => {
    const env = { ...process.env, ...keys.env };
    await keys.close();
    expect(() => execFileSync('ssh-add', ['-l'], { env, stdio: 'pipe' })).toThrow();
  });
});

describe('answerAskpass, as Windows runs it for ssh', () => {
  it('answers the secret once, and never a yes/no question', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hopdeck-askpass-test-'));
    try {
      const env = { HOPDECK_ASKPASS_DIR: dir, HOPDECK_ASKPASS_SECRET: 'the secret' };
      const written: string[] = [];
      const write = (text: string) => written.push(text);
      expect(answerAskpass('Are you sure you want to continue connecting (yes/no/[fingerprint])?', env, write)).toBe(1);
      expect(answerAskpass("admin@fw1's password: ", env, write)).toBe(0);
      // Asked again after a wrong secret: no.
      expect(answerAskpass("admin@fw1's password: ", env, write)).toBe(1);
      expect(written).toEqual(['the secret\n']);
      expect(answerAskpass('Password: ', {}, write)).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
