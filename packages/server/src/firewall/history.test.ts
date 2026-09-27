// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { platform, type Executor, type Platform } from '@hopdeck/core';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Deployments } from './deploy.ts';
import { History, PRUNE, type HistoryTarget } from './history.ts';
import { Sandbox } from '../hosts/sandbox.ts';

describe('prune', () => {
  it('drops the oldest versions beyond the limit, but keeps the minimum', async () => {
    const history = await mkdtemp(join(tmpdir(), 'hopdeck-prune-'));
    for (let id = 1; id <= 14; id += 1) {
      const version = join(history, String(id).padStart(6, '0'));
      await mkdir(version);
      await writeFile(join(version, 'meta.json'), 'x'.repeat(8000));
    }
    // Far over the limit: only the minimum of 10 stays, the newest ones.
    execFileSync('sh', ['-c', `${PRUNE}\nprune "$1" "$2" "$3"`, 'sh', history, '1', '10']);
    expect((await readdir(history)).sort()).toEqual(['000005', '000006', '000007', '000008', '000009', '000010', '000011', '000012', '000013', '000014']);
    // Within the limit: nothing goes.
    execFileSync('sh', ['-c', `${PRUNE}\nprune "$1" "$2" "$3"`, 'sh', history, String(10 * 1024 * 1024), '3']);
    expect(await readdir(history)).toHaveLength(10);
    await rm(history, { recursive: true });
  });
});

const NFT = ['/usr/sbin/nft', '/sbin/nft', '/usr/bin/nft'].find((path) => existsSync(path));
const USERNS = spawnSync('unshare', ['--user', '--map-root-user', '--net', 'true']).status === 0;

const MINE = 'table inet mine {\n\tcomment "managed by hopdeck"\n\tset seen {\n\t\ttype ipv4_addr\n\t\tflags timeout\n\t}\n\tchain input {\n\t\ttype filter hook input priority filter; policy accept;\n\t\tcounter accept\n\t}\n}\n';
const OTHER = 'table inet other {\n\tchain input {\n\t\ttype filter hook input priority 10; policy accept;\n\t}\n}\n';

describe.skipIf(NFT === undefined || !USERNS)('History in a sandbox', { timeout: 30_000 }, () => {
  const nft = NFT!;
  let sandbox: Sandbox;
  let executor: Executor;
  let target: HistoryTarget;
  const deployments = new Deployments({ seconds: 5 });
  const history = new History({ operator: { user: 'ada', computer: 'desk' }, busy: (hostId) => deployments.busy(hostId) });
  const run = async (script: string) => {
    const result = await executor.exec([nft, '-f', '-'], { stdin: script });
    expect(result.stderr).toBe('');
  };
  const json = async () => JSON.parse((await executor.exec([nft, '-j', 'list', 'ruleset'])).stdout) as unknown;
  const look = async () => history.observe(target, await json());
  const deployTarget = () => ({ ...target, name: 'sandbox', systemd: false, manualOverride: false, freshExecutor: undefined });

  beforeAll(async () => {
    sandbox = await Sandbox.start();
    executor = sandbox.executor;
    await sandbox.load(`${MINE}${OTHER}`);
    const host: Platform = { ...platform('linux'), configDir: `${sandbox.directory}/etc/hopdeck`, stateDir: `${sandbox.directory}/var/lib/hopdeck` };
    target = { hostId: 'sandbox', kind: 'sandbox', executor, access: { executor, nftPath: nft, privilege: { kind: 'root' } }, platform: host, login: 'root' };
  });
  afterAll(() => sandbox.dispose());

  it('starts with the managed tables as it first finds them', async () => {
    await look();
    const state = await history.state(target);
    expect(state.versions).toHaveLength(1);
    expect(state.versions[0]).toMatchObject({ id: 1, kind: 'baseline', author: { user: 'ada', computer: 'desk', login: 'root' }, changes: [] });
    expect(state.versions[0]!.tables.map((table) => table.name)).toEqual(['mine']);
    expect(state.size).toBeGreaterThan(0);
    expect(state.settings.history.maxBytes).toBe(10 * 1024 * 1024);

    const detail = await history.version(target, 1);
    expect(detail?.tables).toEqual([{ family: 'inet', name: 'mine', text: expect.stringContaining('counter packets 0 bytes 0 accept') }]);
    expect(await history.version(target, 99)).toBeUndefined();
  });

  it('ignores what changes on its own: counters, elements, handles after a reload', async () => {
    await executor.exec(['ping', '-c', '1', '-W', '1', '127.0.0.1']);
    await run('add element inet mine seen { 10.0.0.1 timeout 1h }\n');
    await run(`table inet mine {}\ndelete table inet mine\n${MINE}`);
    await look();
    expect((await history.state(target)).versions).toHaveLength(1);
  });

  it('records a change made outside hopdeck, and tables it does not manage stay out', async () => {
    await run('add rule inet mine input tcp dport 22 accept\nadd rule inet other input drop\n');
    await look();
    const [outside] = (await history.state(target)).versions;
    expect(outside).toMatchObject({ id: 2, kind: 'outside', author: { user: 'ada' } });
    const detail = await history.version(target, 2);
    expect(detail?.tables.map((table) => table.name)).toEqual(['mine']);
    expect(detail?.tables[0]?.text).toContain('tcp dport 22 accept');
  });

  it('records a kept change with what it touched, and nothing while it waits for confirmation', async () => {
    const definition = `${MINE.replace('counter accept', 'counter accept\n\t\ttcp dport 80 accept')}`;
    const plan = await deployments.prepare(deployTarget(), [{ kind: 'replace', family: 'inet', table: 'mine', definition }], { restoredFrom: 1 });
    await deployments.apply(plan.id, deployTarget());
    await look();
    expect((await history.state(target)).versions).toHaveLength(2);

    const kept = await deployments.confirm(plan.id, deployTarget());
    const recorded = await history.record(target, kept);
    expect(recorded).toEqual({ version: 3 });
    const [change] = (await history.state(target)).versions;
    expect(change).toMatchObject({
      id: 3,
      kind: 'change',
      deployment: plan.id,
      restoredFrom: 1,
      manualOverride: false,
      changes: [{ family: 'inet', name: 'mine', action: 'replace' }],
    });
    await look();
    expect((await history.state(target)).versions).toHaveLength(3);
  });

  it('keeps its settings on the host, and refuses a limit out of range', async () => {
    const state = await history.saveSettings(target, { history: { maxBytes: 2 * 1024 * 1024 } });
    expect(state.settings.history.maxBytes).toBe(2 * 1024 * 1024);
    expect((await executor.exec(['cat', `${target.platform.configDir}/settings.json`])).stdout).toContain('"maxBytes": 2097152');
    await expect(history.saveSettings(target, { history: { maxBytes: 5 } })).rejects.toThrow(/out of range/);
    // A new History, as after a restart, reads them back from the host.
    const again = new History({ operator: { user: 'ada', computer: 'desk' } });
    expect((await again.state(target)).settings.history.maxBytes).toBe(2 * 1024 * 1024);
  });

  it('keeps everything it writes to root alone', async () => {
    const modes = await executor.exec(['stat', '-c', '%a %n', target.platform.stateDir, `${target.platform.stateDir}/firewall/history`, `${target.platform.configDir}/settings.json`]);
    expect(modes.stdout.split('\n').filter(Boolean).map((line) => line.split(' ')[0])).toEqual(['700', '700', '600']);
  });
});

// Against the podman test host: HOPDECK_TEST_HOST=1 pnpm test (after dev/test-host/up.sh).
const repo = new URL('../../../../', import.meta.url).pathname;
const sshConfig = `${repo}.dev/test-host/ssh_config`;

describe.skipIf(!process.env['HOPDECK_TEST_HOST'] || !existsSync(sshConfig))('History on the test host', { timeout: 90_000 }, () => {
  let controlDir: string;
  const history = new History({ operator: { user: 'ada', computer: 'desk' } });

  const hostTarget = async (account: 'root' | 'admin'): Promise<HistoryTarget> => {
    const { SshExecutor } = await import('../hosts/ssh.ts');
    const destination = `hopdeck-test-${account}`;
    const executor = new SshExecutor({ destination, controlDir, configFile: sshConfig });
    const privilege = account === 'root' ? ({ kind: 'root' } as const) : ({ kind: 'sudo-password' } as const);
    return {
      hostId: destination,
      kind: 'ssh',
      executor,
      access: { executor, nftPath: '/usr/sbin/nft', privilege, ...(account === 'admin' && { password: 'hopdeck-test' }) },
      platform: platform('linux'),
      login: account,
    };
  };

  beforeAll(async () => {
    controlDir = await mkdtemp(`${tmpdir()}/hopdeck-history-`);
    const root = await hostTarget('root');
    await root.executor.exec(['sh', '-c', `rm -rf /var/lib/hopdeck; /usr/sbin/nft -f - <<'EOF'\n${MINE}EOF`]);
  });

  afterAll(async () => {
    const root = await hostTarget('root');
    await root.executor.exec(['sh', '-c', 'rm -rf /var/lib/hopdeck; /usr/sbin/nft delete table inet mine']);
  });

  it('names the author by the key sshd accepted for this very connection', async () => {
    const target = await hostTarget('admin');
    const json = JSON.parse((await target.executor.exec(['sh', '-c', 'echo hopdeck-test | sudo -S -p "" /usr/sbin/nft -j list ruleset'])).stdout) as unknown;
    await history.observe(target, json);
    const state = await history.state(target);
    expect(state.failure).toBeUndefined();
    const key = execFileSync('ssh-keygen', ['-lf', `${repo}.dev/test-host/id_ed25519.pub`], { encoding: 'utf8' }).split(' ')[1];
    expect(state.versions[0]?.author).toMatchObject({
      user: 'ada',
      computer: 'desk',
      login: 'admin',
      connection: { address: expect.any(String), port: expect.any(Number), method: 'publickey', key: `ED25519 ${key}` },
    });
  });

  it('under sudo with a password, the history is root’s alone', async () => {
    const target = await hostTarget('admin');
    const modes = await target.executor.exec(['sh', '-c', 'echo hopdeck-test | sudo -S -p "" stat -c "%a %U" /var/lib/hopdeck /var/lib/hopdeck/firewall/history']);
    expect(modes.stdout).toBe('700 root\n700 root\n');
    expect((await target.executor.exec(['ls', '/var/lib/hopdeck'])).exitCode).not.toBe(0);
  });
});
