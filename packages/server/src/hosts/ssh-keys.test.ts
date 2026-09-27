// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SshKeys } from './ssh-keys.ts';

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
    keys = new SshKeys({ configFile: join(dir, 'config'), runtimeDir: dir, sessionAgent: false });
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
    const view = await keys.list('fw1');
    expect(view.agent).toBe('hopdeck');
    expect(view.keys.map(({ file, type, comment, encrypted, loaded }) => ({ file, type, comment, encrypted, loaded }))).toEqual([
      { file: join(dir, 'locked'), type: 'ED25519', comment: 'locked key', encrypted: true, loaded: false },
      { file: join(dir, 'open'), type: 'ED25519', comment: 'open key', encrypted: false, loaded: false },
    ]);
    expect(view.keys[0]!.fingerprint).toMatch(/^SHA256:/);
  });

  it('says so when the passphrase is wrong, without asking again and again', async () => {
    await expect(keys.unlock('fw1', join(dir, 'locked'), 'wrong', 60)).rejects.toMatchObject({ code: 'wrong-passphrase' });
    expect((await keys.list('fw1')).keys[0]!.loaded).toBe(false);
  });

  it('adds a key to the agent for as long as asked', async () => {
    const view = await keys.unlock('fw1', join(dir, 'locked'), 'right passphrase', 120);
    expect(view.keys[0]!.loaded).toBe(true);
    const listed = execFileSync('ssh-add', ['-l'], { env: { ...process.env, ...keys.env }, encoding: 'utf8' });
    expect(listed).toContain('locked key');
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
    expect(await without.list('fw1')).toMatchObject({ agent: 'none', agentError: expect.stringMatching(/ssh-agent is not installed/) });
    await expect(without.unlock('fw1', join(dir, 'locked'), 'right passphrase', 60)).rejects.toMatchObject({ code: 'spawn-failed' });
    await without.close();
  });

  it('refuses a key ssh would not offer the host, and a lifetime out of range', async () => {
    await expect(keys.unlock('fw1', join(dir, 'other'), '', 60)).rejects.toThrow(/not a key ssh offers fw1/);
    await expect(keys.unlock('fw1', join(dir, 'open'), '', 0)).rejects.toThrow(/lifetime/);
  });

  it('takes its agent and keys with it when it closes', async () => {
    const env = { ...process.env, ...keys.env };
    await keys.close();
    expect(() => execFileSync('ssh-add', ['-l'], { env, stdio: 'pipe' })).toThrow();
  });
});
