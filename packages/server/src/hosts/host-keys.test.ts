import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fingerprint, hashName, HostKeys, knownHostsName, parseSshSettings } from './host-keys.ts';
import { SshExecutor } from './ssh.ts';

describe('parseSshSettings and knownHostsName', () => {
  const output = [
    'user root',
    'hostname 10.0.0.1',
    'port 2222',
    'hashknownhosts yes',
    'globalknownhostsfile /etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2',
    'userknownhostsfile /home/a/.ssh/known_hosts /home/a/.ssh/known_hosts2',
  ].join('\n');

  it('reads what ssh -G prints', () => {
    expect(parseSshSettings(output)).toEqual({
      hostname: '10.0.0.1',
      port: 2222,
      hostKeyAlias: undefined,
      userKnownHostsFiles: ['/home/a/.ssh/known_hosts', '/home/a/.ssh/known_hosts2'],
      globalKnownHostsFiles: ['/etc/ssh/ssh_known_hosts', '/etc/ssh/ssh_known_hosts2'],
      hashKnownHosts: true,
    });
  });

  it('names hosts the way known_hosts does', () => {
    const settings = parseSshSettings(output);
    expect(knownHostsName(settings)).toBe('[10.0.0.1]:2222');
    expect(knownHostsName({ ...settings, port: 22 })).toBe('10.0.0.1');
    expect(knownHostsName({ ...settings, hostKeyAlias: 'fw1' })).toBe('fw1');
  });
});

describe('fingerprint and hashName', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nftm-keys-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('match what ssh-keygen computes and finds', async () => {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'key')]);
    const [type, key] = (await readFile(join(dir, 'key.pub'), 'utf8')).split(' ') as [string, string];
    const listed = execFileSync('ssh-keygen', ['-lf', join(dir, 'key.pub')], { encoding: 'utf8' });
    expect(listed.split(' ')[1]).toBe(fingerprint(key));

    await writeFile(join(dir, 'known_hosts'), `${hashName('[10.0.0.1]:2222')} ${type} ${key}\n`);
    const found = execFileSync('ssh-keygen', ['-F', '[10.0.0.1]:2222', '-f', join(dir, 'known_hosts')], { encoding: 'utf8' });
    expect(found).toContain(key);
  });
});

// Against the podman test host: NFTM_TEST_HOST=1 pnpm test (after dev/test-host/up.sh).
const repo = resolve(import.meta.dirname, '../../../..');
const testKey = join(repo, '.dev/test-host/id_ed25519');
const port = process.env['NFTM_TEST_PORT'] ?? '2222';

describe.skipIf(!process.env['NFTM_TEST_HOST'] || !existsSync(testKey))('HostKeys against the test host', () => {
  let dir: string;
  let keys: HostKeys;
  let serverFingerprint: string;
  const bogusKey = 'AAAAC3NzaC1lZDI1NTE5AAAAIOl5iG6n0rA8Z6z9Z9t8b7T4y1bqf3o0X2cWq8JwWmZs';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nftm-hostkeys-'));
    const common = `HostName 127.0.0.1\n\tPort ${port}\n\tUser root\n\tIdentityFile ${testKey}\n\tIdentitiesOnly yes\n\tStrictHostKeyChecking yes`;
    await writeFile(
      join(dir, 'ssh_config'),
      `Host unknown\n\t${common}\n\tUserKnownHostsFile ${dir}/known_hosts\n\tHashKnownHosts yes\n` +
        `Host changed\n\t${common}\n\tUserKnownHostsFile ${dir}/known_hosts.changed\n\tHashKnownHosts no\n`,
    );
    await writeFile(join(dir, 'known_hosts.changed'), `[127.0.0.1]:${port} ssh-ed25519 ${bogusKey}\n`);
    keys = new HostKeys({ configFile: join(dir, 'ssh_config') });
    serverFingerprint = (await keys.check('unknown')).presented.fingerprint;
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const connects = (destination: string) =>
    new SshExecutor({ destination, controlDir: dir, configFile: join(dir, 'ssh_config') }).exec(['id', '-u']);

  it('reports an unknown key and records it hashed once confirmed', async () => {
    const check = await keys.check('unknown');
    expect(check).toMatchObject({ name: `[127.0.0.1]:${port}`, knownHostsFile: `${dir}/known_hosts`, known: [] });
    await expect(connects('unknown')).rejects.toMatchObject({ code: 'ssh-host-key' });

    await expect(keys.trust('unknown', 'SHA256:not-what-the-server-has', false)).rejects.toMatchObject({ code: 'host-key-mismatch' });
    await keys.trust('unknown', serverFingerprint, false);
    expect(await readFile(join(dir, 'known_hosts'), 'utf8')).toMatch(/^\|1\|/);
    expect((await connects('unknown')).stdout).toBe('0\n');
  });

  it('replaces a changed key only when asked, keeping a backup', async () => {
    const check = await keys.check('changed');
    expect(check.known).toEqual([{ type: 'ssh-ed25519', fingerprint: fingerprint(bogusKey), file: `${dir}/known_hosts.changed` }]);
    await expect(connects('changed')).rejects.toMatchObject({ code: 'ssh-host-key-changed' });

    await expect(keys.trust('changed', serverFingerprint, false)).rejects.toMatchObject({ code: 'ssh-host-key-changed' });
    await keys.trust('changed', serverFingerprint, true);
    expect(await readFile(join(dir, 'known_hosts.changed.old'), 'utf8')).toContain(bogusKey);
    expect((await connects('changed')).stdout).toBe('0\n');
  });
});
