// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { ALLOW_KEYS_FILE } from '@hopdeck/core';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testHost } from '../testing/test-host.ts';
import { KeyLogin } from './key-login.ts';
import { runProcess } from './process.ts';
import { SshExecutor } from './ssh.ts';
import { SshKeys } from './ssh-keys.ts';

const host = testHost;
const PASSWORD = 'hopdeck-test';
/** In the comment of the keys these tests install, to find them again. */
const MARK = 'hopdeck-login-test';
/** Keys off for everyone but the connection the tests keep open as root. */
const BLOCK = '/etc/ssh/sshd_config.d/50-test-no-keys.conf';
const RELOAD = 'if [ -d /run/systemd/system ]; then systemctl reload sshd.service || systemctl reload ssh.service; else rc-service sshd reload; fi';
/** A connection that fails before logging in: sshd is still restarting. */
const RESTARTING = /kex_exchange_identification|Connection (refused|reset|closed)/;

// The key setup logs in with a password: a VM of dev/vm-host takes keys only.
describe.skipIf(host === undefined || !host.passwords)('KeyLogin on the test host', { timeout: 60_000 }, () => {
  let dir: string;
  let keys: SshKeys;
  let login: KeyLogin;
  /** One connection, kept open: it stays in while the tests keep keys out. */
  let root: SshExecutor;
  const fresh = () => join(dir, 'fresh');
  const locked = () => join(dir, 'locked');

  async function asRoot(script: string): Promise<string> {
    const done = await root.exec(['sh', '-c', script]);
    if (done.exitCode !== 0) throw new Error(`${script}: ${done.stderr}`);
    return done.stdout;
  }

  /** Changes sshd's configuration as root and waits until sshd takes new connections again. */
  async function reconfigure(script: string): Promise<void> {
    await asRoot(`${script} && ${RELOAD}`);
    // sshd restarts itself after reload returns, on some systems.
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const tried = await runProcess('ssh', ['-F', join(dir, 'config'), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', 'fresh-root', 'true'], {
        timeoutMs: 10_000,
      });
      if (!RESTARTING.test(tried.stderr)) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('sshd did not take connections again after reloading');
  }

  beforeAll(async () => {
    const { port, dir: state } = host!;
    // Short: the agent's socket and ssh's control sockets go here.
    dir = await mkdtemp('/tmp/hd-login-');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `${MARK} fresh`, '-f', fresh()]);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'the passphrase', '-C', `${MARK} locked`, '-f', locked()]);
    // Each account under three names: with the fresh key, with the locked one,
    // and with none at all (a file that is not there); neither key is on the host yet.
    const entries = ['root', 'admin', 'plain'].flatMap((account) =>
      [
        ['fresh', fresh()],
        ['locked', locked()],
        ['bare', join(dir, 'no-key-yet')],
      ].map(([name, key]) => `Host ${name}-${account}\n\tUser ${account}\n\tIdentityFile ${key}\n`),
    );
    // And one whose ssh config would take any host key: a password must not go there.
    const unverified = ['root', 'admin', 'plain'].map(
      (account) => `Host unverified-${account}\n\tUser ${account}\n\tIdentityFile ${fresh()}\n\tUserKnownHostsFile /dev/null\n\tStrictHostKeyChecking no\n`,
    );
    const common = `Host *\n\tHostName 127.0.0.1\n\tPort ${port}\n\tIdentitiesOnly yes\n\tUserKnownHostsFile ${state}/known_hosts\n\tStrictHostKeyChecking yes\n`;
    await writeFile(join(dir, 'config'), `${entries.join('')}${unverified.join('')}${common}`);
    keys = new SshKeys({ configFile: join(dir, 'config'), runtimeDir: dir, sessionAgent: false, sshDir: join(dir, 'generated') });
    await keys.start();
    login = new KeyLogin({ keys, configFile: join(dir, 'config') });
    root = new SshExecutor({ destination: 'hopdeck-test-root', controlDir: dir, configFile: host!.sshConfig });
    await asRoot('true');
  });

  afterAll(async () => {
    if (root !== undefined) {
      await asRoot(
        `rm -f ${BLOCK} ${ALLOW_KEYS_FILE}; ${host!.platform === 'openwrt' ? '' : `${RELOAD};`} for file in /etc/dropbear/authorized_keys /home/*/.ssh/authorized_keys; do [ -f "$file" ] && sed -i '/${MARK}/d' "$file"; done; true`,
      ).catch((error: unknown) => console.error(error));
    }
    await keys?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('generates a key, puts it on a host no key opened with the password, and logs in with it as hopdeck keeps it', async () => {
    const account = host!.platform === 'openwrt' ? 'root' : 'plain';
    const key = await keys.generate({ type: 'ed25519', name: 'generated', comment: `${MARK} generated`, passphrase: 'the passphrase' });
    // hopdeck keeps the key for the host, apart from the ssh config, which names no key for it.
    const target = { destination: `bare-${account}`, identityFile: key.file };
    await keys.unlock(target, key.file, 'the passphrase', 60);
    expect(await login.setUp(target, key.file, PASSWORD)).toMatchObject({ added: true, outcome: 'works' });
    const executor = new SshExecutor({ ...target, controlDir: dir, configFile: join(dir, 'config'), env: keys.env, shareConnection: false });
    expect((await executor.exec(['id', '-un'])).stdout).toBe(`${account}\n`);
  });

  it('sends no password to a host whose key is unknown, even where the ssh config would take any', async () => {
    const account = host!.platform === 'openwrt' ? 'root' : 'plain';
    await expect(login.setUp({ destination: `unverified-${account}` }, fresh(), PASSWORD)).rejects.toMatchObject({ code: 'ssh-host-key' });
  });

  it('says so when the password is wrong, and installs nothing', async () => {
    const account = host!.platform === 'openwrt' ? 'root' : 'plain';
    await expect(login.setUp({ destination: `fresh-${account}` }, fresh(), 'wrong password')).rejects.toMatchObject({ code: 'login-password-rejected' });
  });

  it.runIf(host?.platform === 'openwrt')('puts root\'s key where OpenWrt\'s dropbear reads it, and the key alone gets in', async () => {
    const result = await login.setUp({ destination: 'fresh-root' }, fresh(), PASSWORD);
    expect(result).toEqual({ file: '/etc/dropbear/authorized_keys', added: true, outcome: 'works', check: { server: 'dropbear', blockers: [] } });
  });

  describe.runIf(host?.platform === 'linux')('with sshd', () => {
    it('says so when the server takes no password for the account', async () => {
      await expect(login.setUp({ destination: 'fresh-root' }, fresh(), PASSWORD)).rejects.toMatchObject({ code: 'password-login-disabled' });
    });

    it('installs the key with one password login, and a new connection gets in with the key alone', async () => {
      const result = await login.setUp({ destination: 'fresh-plain' }, fresh(), PASSWORD);
      expect(result).toMatchObject({ file: '/home/plain/.ssh/authorized_keys', added: true, outcome: 'works', check: { server: 'sshd', blockers: [] } });
      // plain may not use sudo, so sshd's configuration stays unread; with the key working, nothing asks for it.
      expect(result.check.reason).toMatch(/password is required|sudoers/);
      // Alpine's home directories are setgid, and a new .ssh inherits that: harmless to sshd.
      expect(await asRoot("stat -c '%a %U' /home/plain/.ssh /home/plain/.ssh/authorized_keys")).toMatch(/^2?700 plain\n600 plain\n$/);

      const again = await login.setUp({ destination: 'fresh-plain' }, fresh(), PASSWORD);
      expect(again).toMatchObject({ added: false, outcome: 'works' });
      expect(await asRoot(`grep -c '${MARK} fresh' /home/plain/.ssh/authorized_keys`)).toBe('1\n');
      const executor = new SshExecutor({ destination: 'fresh-plain', controlDir: dir, configFile: join(dir, 'config'), env: keys.env, shareConnection: false });
      expect((await executor.exec(['id', '-un'])).stdout).toBe('plain\n');
    });

    it('cannot try a key that needs its passphrase, until it is unlocked', async () => {
      expect(await login.setUp({ destination: 'locked-plain' }, locked(), PASSWORD)).toMatchObject({ added: true, outcome: 'unverified' });
      await keys.unlock({ destination: 'locked-plain' }, locked(), 'the passphrase', 60);
      expect(await login.setUp({ destination: 'locked-plain' }, locked(), PASSWORD)).toMatchObject({ added: false, outcome: 'works' });
    });

    it('says why sshd refuses keys, and lets them in on request, with passwords working as before', async () => {
      await reconfigure(`printf 'PubkeyAuthentication no\\n' > ${BLOCK}`);
      try {
        // admin needs its password for sudo, so reading sshd's configuration takes a second login.
        const refused = await login.setUp({ destination: 'fresh-admin' }, fresh(), PASSWORD);
        expect(refused).toMatchObject({
          added: true,
          outcome: 'refused',
          check: { server: 'sshd', blockers: [{ setting: 'pubkeyauthentication', value: 'no', allow: 'PubkeyAuthentication yes' }] },
        });
        expect(refused.check.reason).toBeUndefined();
        expect(refused.refusal).toMatch(/Permission denied/);

        const allowed = await login.setUp({ destination: 'fresh-admin' }, fresh(), PASSWORD, { allow: true });
        expect(allowed).toMatchObject({
          added: false,
          outcome: 'works',
          allowed: { file: ALLOW_KEYS_FILE, lines: ['PubkeyAuthentication yes'], applied: true },
          check: { server: 'sshd', blockers: [] },
        });
        const written = await asRoot(`cat ${ALLOW_KEYS_FILE}`);
        expect(written).toMatch(/^# Written by hopdeck on .*\n# Passwords work as they did\..*\nPubkeyAuthentication yes\n$/);
        // The password still logs in: the whole setup did, once more.
        expect(await login.setUp({ destination: 'fresh-admin' }, fresh(), PASSWORD)).toMatchObject({ outcome: 'works' });
      } finally {
        await reconfigure(`rm -f ${BLOCK} ${ALLOW_KEYS_FILE}`);
      }
    });

    it('puts everything back when a Match block wins over what hopdeck would add', async () => {
      await reconfigure(`printf 'Match User admin\\n\\tPubkeyAuthentication no\\n' > ${BLOCK}`);
      try {
        const result = await login.setUp({ destination: 'fresh-admin' }, fresh(), PASSWORD, { allow: true });
        expect(result).toMatchObject({
          outcome: 'refused',
          allowed: { file: ALLOW_KEYS_FILE, lines: ['PubkeyAuthentication yes'], applied: false, why: 'overridden', reason: 'pubkeyauthentication no' },
        });
        expect(await asRoot(`[ -e ${ALLOW_KEYS_FILE} ] && echo there || echo gone`)).toBe('gone\n');
      } finally {
        await reconfigure(`rm -f ${BLOCK}`);
      }
    });

    it('says why it cannot read sshd\'s configuration when the account may not use sudo', async () => {
      await reconfigure(`printf 'PubkeyAuthentication no\\n' > ${BLOCK}`);
      try {
        const result = await login.setUp({ destination: 'fresh-plain' }, fresh(), PASSWORD, { allow: true });
        expect(result).toMatchObject({ outcome: 'refused', check: { server: 'sshd', blockers: [] } });
        expect(result.allowed).toBeUndefined();
        expect(result.check.reason).toMatch(/sudoers/);
      } finally {
        await reconfigure(`rm -f ${BLOCK}`);
      }
    });
  });
});
