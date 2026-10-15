// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { parseListing, parseRuleset, ruleKey } from '@hopdeck/core';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEBIAN_FACTS, FakeExecutor, failed, ok, type Script } from '../testing/fake-executor.ts';
import { HostError } from './errors.ts';
import { HostManager, HostStateError, InvalidHostError } from './manager.ts';
import { SshKeys } from './ssh-keys.ts';
import { demoRuleset, Sandbox } from './sandbox.ts';

/** A host whose sudo wants the password "secret". */
const SUDO_WITH_PASSWORD: Script = (argv, stdin) => {
  if (argv[0] === 'sh') return ok(DEBIAN_FACTS);
  if (argv.includes('-n')) return failed('sudo: a password is required\n');
  return stdin === 'secret\n' ? ok('nftables v1.0.6') : failed('sudo: 1 incorrect password attempt\n');
};

describe('HostManager', () => {
  let configDir: string;
  const open = (script: Script = SUDO_WITH_PASSWORD) =>
    HostManager.open({ configDir, controlDir: configDir, createSshExecutor: () => new FakeExecutor(script) });

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'hopdeck-config-'));
  });
  afterEach(() => rm(configDir, { recursive: true, force: true }));

  it('always has localhost', async () => {
    const hosts = await open();
    expect(hosts.list()).toEqual([{ id: 'local', kind: 'local', name: 'localhost', status: { state: 'new' }, manualOverride: false }]);
  });

  it('stores SSH hosts in a private hosts.json', async () => {
    const hosts = await open();
    const added = await hosts.add({ destination: ' admin@fw1 ', name: 'Edge firewall' });
    expect(added).toMatchObject({ kind: 'ssh', name: 'Edge firewall', destination: 'admin@fw1' });

    const file = join(configDir, 'hosts.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      hosts: [{ id: added.id, destination: 'admin@fw1', name: 'Edge firewall' }],
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const reopened = await open();
    expect(reopened.get(added.id)).toMatchObject({ destination: 'admin@fw1' });
    expect(await reopened.remove(added.id)).toBe(true);
    expect((await open()).list().map((host) => host.id)).toEqual(['local']);
  });

  it('rejects bad, duplicate and built-in hosts', async () => {
    const hosts = await open();
    await hosts.add({ destination: 'fw1' });
    await expect(hosts.add({ destination: 'fw1' })).rejects.toThrow(InvalidHostError);
    await expect(hosts.add({ destination: '-oProxyCommand=x' })).rejects.toThrow(InvalidHostError);
    expect(await hosts.remove('local')).toBe(false);
    expect(await hosts.remove('missing')).toBe(false);
  });

  it('stops logging in to an SSH host that refused, until it is connected again', async () => {
    let refuse = false;
    const executors: FakeExecutor[] = [];
    const script: Script = (argv, stdin) => (refuse ? new HostError('ssh-auth', 'admin@fw1: Permission denied (publickey).') : SUDO_WITH_PASSWORD(argv, stdin));
    const hosts = await HostManager.open({
      configDir,
      controlDir: configDir,
      createSshExecutor: () => {
        executors.push(new FakeExecutor(script));
        return executors.at(-1)!;
      },
    });
    const { id } = await hosts.add({ destination: 'fw1' });
    await hosts.connect(id);
    const ssh = executors.at(-1)!;

    // The key left the agent: the panel's next readings are refused, and only the first one tries.
    refuse = true;
    const before = ssh.calls.length;
    await expect(hosts.usage(id)).rejects.toMatchObject({ code: 'ssh-auth' });
    await expect(hosts.usage(id)).rejects.toMatchObject({ code: 'ssh-auth' });
    await expect(hosts.usage(id)).rejects.toMatchObject({ code: 'ssh-auth' });
    expect(ssh.calls.length).toBe(before + 1);

    // Connecting again logs in again, and so does what follows.
    refuse = false;
    expect((await hosts.connect(id))?.status).toMatchObject({ state: 'connected' });
    const connected = ssh.calls.length;
    await hosts.usage(id).catch(() => undefined);
    expect(ssh.calls.length).toBe(connected + 1);
  });

  it('generates a key for an SSH host, and has it offered there by hopdeck or by ssh config', async () => {
    const keysDir = await mkdtemp('/tmp/hd-gen-');
    const sshConfig = join(keysDir, 'config');
    await writeFile(sshConfig, '');
    const keys = new SshKeys({ configFile: sshConfig, runtimeDir: keysDir, sessionAgent: false, sshDir: join(keysDir, 'ssh') });
    const made: { destination: string; identityFile: string | undefined }[] = [];
    const hosts = await HostManager.open({
      configDir,
      controlDir: configDir,
      sshKeys: keys,
      sshConfigFile: sshConfig,
      createSshExecutor: (destination, options) => {
        made.push({ destination, identityFile: options?.identityFile });
        return new FakeExecutor(SUDO_WITH_PASSWORD);
      },
    });
    await keys.start();
    try {
      const { id } = await hosts.add({ destination: 'fw1' });
      const kept = await hosts.generateKey(id, { type: 'ed25519', name: 'id_fw1', comment: '', passphrase: '' }, 'hopdeck', undefined);
      const file = join(keysDir, 'ssh', 'id_fw1');
      expect(kept?.key).toMatchObject({ file, use: 'hopdeck', encrypted: false });
      expect(kept?.key.comment).toMatch(/^\S+@\S+$/);
      expect(kept?.keys).toMatchObject({ remembered: file });
      expect(made.at(-1)).toEqual({ destination: 'fw1', identityFile: file });
      expect(JSON.parse(await readFile(join(configDir, 'hosts.json'), 'utf8')).hosts[0]).toMatchObject({ identityFile: file });

      expect((await hosts.forgetKey(id))?.remembered).toBeUndefined();
      expect(made.at(-1)).toEqual({ destination: 'fw1', identityFile: undefined });
      expect(JSON.parse(await readFile(join(configDir, 'hosts.json'), 'utf8')).hosts[0].identityFile).toBeUndefined();

      const named = await hosts.generateKey(id, { type: 'rsa', bits: 2048, name: 'id_fw1_rsa', comment: 'ada@desk', passphrase: '' }, 'config', undefined);
      expect(named?.key).toMatchObject({ use: 'config', config: { file: sshConfig } });
      expect(await readFile(sshConfig, 'utf8')).toContain(`Host fw1\n    IdentityFile ${join(keysDir, 'ssh', 'id_fw1_rsa')}\n`);
      expect(named?.keys.keys.map((key) => key.file)).toContain(join(keysDir, 'ssh', 'id_fw1_rsa'));

      // A second host gets a key already made, instead of a new one.
      const { id: other } = await hosts.add({ destination: 'fw2' });
      const available = await hosts.availableKeys();
      expect(available).toMatchObject({ dir: join(keysDir, 'ssh') });
      expect(available.keys.map((key) => key.file)).toEqual([file, join(keysDir, 'ssh', 'id_fw1_rsa')]);
      const used = await hosts.useKey(other, file, 'hopdeck');
      expect(used?.used).toEqual({ file, use: 'hopdeck' });
      expect(used?.keys).toMatchObject({ remembered: file });
      expect(made.at(-1)).toEqual({ destination: 'fw2', identityFile: file });
      const config = await hosts.useKey(other, join(keysDir, 'ssh', 'id_fw1_rsa'), 'config');
      expect(config?.used).toMatchObject({ use: 'config', config: { file: sshConfig } });
      expect(await readFile(sshConfig, 'utf8')).toContain(`Host fw2\n    IdentityFile ${join(keysDir, 'ssh', 'id_fw1_rsa')}\n`);
      // Only a key from that list: not any file hopdeck can read.
      for (const notKey of [sshConfig, `${file}.pub`, `${keysDir}/ssh/../ssh/id_fw1`]) {
        await expect(hosts.useKey(other, notKey, 'hopdeck'), notKey).rejects.toThrow(/is not a private key in/);
      }
    } finally {
      await keys.close();
      await rm(keysDir, { recursive: true, force: true });
    }
  });

  it('connects to localhost', async () => {
    const connected = await (await open()).connect('local');
    expect(connected?.status).toMatchObject({ state: 'connected', facts: { kernel: release() } });
  });

  it('reads CPU and memory use without root, measuring CPU between readings', async () => {
    const hosts = await open();
    await expect(hosts.usage('local')).rejects.toThrow(/not connected/);
    await hosts.connect('local');
    const first = (await hosts.usage('local'))!;
    expect(first.cpu.threads).toBe(availableParallelism());
    expect(first.cpu.percent).toBeGreaterThanOrEqual(0);
    expect(first.cpu.percent).toBeLessThanOrEqual(first.cpu.threads * 100);
    expect(first.memory.total).toBe(Math.floor(totalmem() / 1024) * 1024);
    expect(first.memory.used).toBeGreaterThan(0);
    expect(first.memory.used).toBeLessThan(first.memory.total);
    expect((await hosts.usage('local'))!.cpu.threads).toBe(first.cpu.threads);
  });

  it('turns connection failures into an error status', async () => {
    const hosts = await open(() => new HostError('ssh-host-key', 'Host key verification failed.'));
    const { id } = await hosts.add({ destination: 'fw1' });
    expect((await hosts.connect(id))?.status).toEqual({
      state: 'error',
      error: { code: 'ssh-host-key', detail: 'Host key verification failed.' },
    });
  });

  it('checks a sudo password and never reveals it', async () => {
    const hosts = await open();
    const { id } = await hosts.add({ destination: 'fw1' });
    expect((await hosts.connect(id))?.status).toMatchObject({ privilege: { kind: 'sudo-password' }, passwordStored: false });

    await expect(hosts.setSudoPassword(id, 'wrong')).rejects.toMatchObject({ code: 'wrong-password' });
    const unlocked = await hosts.setSudoPassword(id, 'secret');
    expect(unlocked?.status).toMatchObject({ passwordStored: true });
    expect(JSON.stringify(hosts.list())).not.toContain('secret');

    await expect(hosts.setSudoPassword('local', 'x')).rejects.toThrow(HostStateError);
  });

  it('reads a ruleset only when nft can run as root', async () => {
    const hosts = await open();
    const { id } = await hosts.add({ destination: 'fw1' });
    await expect(hosts.readRuleset(id)).rejects.toThrow(HostStateError);
    await hosts.connect(id);
    await expect(hosts.readRuleset(id)).rejects.toMatchObject({ code: 'password-required' });
    expect(await hosts.readRuleset('missing')).toBeUndefined();
  });

  it("reports nft's own error and output that is not JSON", async () => {
    const answers = (listed: ReturnType<Script>): Script => (argv) => (argv[0] === 'sh' ? ok(DEBIAN_FACTS) : argv.includes('--version') ? ok() : listed);
    const failing = await open(answers(failed('Error: Could not process rule: Operation not permitted\n')));
    const one = await failing.add({ destination: 'fw1' });
    await failing.connect(one.id);
    await expect(failing.readRuleset(one.id)).rejects.toMatchObject({
      code: 'command-failed',
      detail: 'Error: Could not process rule: Operation not permitted',
    });

    const garbled = await open(answers(ok('Welcome to fw1!\n')));
    const two = await garbled.add({ destination: 'fw2' });
    await garbled.connect(two.id);
    await expect(garbled.readRuleset(two.id)).rejects.toMatchObject({
      code: 'command-failed',
      detail: expect.stringContaining('Welcome to fw1!'),
    });
  });

  it('turns a right password that sudo still refuses into the host state', async () => {
    const hosts = await open((argv, stdin) => {
      if (argv[0] === 'sh') return ok(DEBIAN_FACTS);
      if (argv.includes('-n')) return failed('sudo: a password is required\n');
      return stdin === 'secret\n' ? failed('admin is not in the sudoers file.\n') : failed('Sorry, try again.\n');
    });
    const { id } = await hosts.add({ destination: 'fw1' });
    await hosts.connect(id);

    const refused = await hosts.setSudoPassword(id, 'secret');
    expect(refused?.status).toMatchObject({
      state: 'connected',
      privilege: { kind: 'none', reason: 'sudo-not-allowed', detail: 'admin is not in the sudoers file.' },
      passwordStored: false,
    });
  });
});

const USERNS = spawnSync('unshare', ['--user', '--map-root-user', '--net', 'true']).status === 0;

describe.skipIf(!USERNS)('HostManager with a sandbox', () => {
  it('connects to the sandbox as root', async () => {
    const sandbox = await Sandbox.start();
    const configDir = await mkdtemp(join(tmpdir(), 'hopdeck-config-'));
    try {
      const hosts = await HostManager.open({ configDir, controlDir: configDir, sandbox: { executor: sandbox.executor, directory: sandbox.directory } });
      const connected = await hosts.connect('sandbox');
      expect(connected?.status).toMatchObject({ state: 'connected', privilege: { kind: 'root' } });

      await sandbox.load(await demoRuleset());
      const snapshot = (await hosts.readRuleset('sandbox'))!;
      const ruleset = parseRuleset(snapshot.json);
      const listing = parseListing(snapshot.listing);
      expect(ruleset.tables.map((node) => node.table.name)).toEqual(['filter', 'nat']);
      expect(ruleset.unknown).toEqual([]);
      // Every rule nft lists as JSON has its text in the listing.
      const rules = ruleset.tables.flatMap((node) => node.chains.flatMap((chain) => chain.rules));
      expect(rules.length).toBeGreaterThan(5);
      for (const rule of rules) expect(listing.rules.get(ruleKey(rule.family, rule.table, rule.handle)), JSON.stringify(rule)).toBeTypeOf('string');

      // Live: counters move with traffic, fingerprints stay while only counters change.
      const before = (await hosts.live('sandbox'))!;
      expect(Object.keys(before.fingerprints)).toHaveLength(2);
      await sandbox.executor.exec(['sh', '-c', 'PATH="$PATH:/usr/sbin:/sbin:/bin"; ping -c 2 -i 0.2 -W 1 127.0.0.1']);
      const after = (await hosts.live('sandbox'))!;
      expect(after.fingerprints).toEqual(before.fingerprints);
      const grew = Object.keys(after.rules).filter((key) => after.rules[key]!.packets > (before.rules[key]?.packets ?? 0));
      expect(grew.length).toBeGreaterThan(0);
    } finally {
      await sandbox.dispose();
      await rm(configDir, { recursive: true, force: true });
    }
  });
});
