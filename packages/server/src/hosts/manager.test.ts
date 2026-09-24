import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEBIAN_FACTS, FakeExecutor, failed, ok, type Script } from '../testing/fake-executor.ts';
import { HostError } from './errors.ts';
import { HostManager, HostStateError, InvalidHostError } from './manager.ts';
import { Sandbox } from './sandbox.ts';

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
    configDir = await mkdtemp(join(tmpdir(), 'nftm-config-'));
  });
  afterEach(() => rm(configDir, { recursive: true, force: true }));

  it('always has localhost', async () => {
    const hosts = await open();
    expect(hosts.list()).toEqual([{ id: 'local', kind: 'local', name: 'localhost', status: { state: 'new' } }]);
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

  it('connects to localhost', async () => {
    const connected = await (await open()).connect('local');
    expect(connected?.status).toMatchObject({ state: 'connected', facts: { kernel: release() } });
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
    const configDir = await mkdtemp(join(tmpdir(), 'nftm-config-'));
    try {
      const hosts = await HostManager.open({ configDir, controlDir: configDir, sandbox: sandbox.executor });
      const connected = await hosts.connect('sandbox');
      expect(connected?.status).toMatchObject({ state: 'connected', privilege: { kind: 'root' } });
    } finally {
      await sandbox.dispose();
      await rm(configDir, { recursive: true, force: true });
    }
  });
});
