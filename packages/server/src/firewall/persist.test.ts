import { platform } from '@hopdeck/core';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Deployments, readTable, type DeployTarget } from './deploy.ts';
import { collectFacts, parseFacts } from '../hosts/facts.ts';
import { addInclude, bootDefinition, bootDirectory, includeLine, persistenceStatus, persistTables, tableFile, type PersistTarget } from './persist.ts';
import { SshExecutor } from '../hosts/ssh.ts';
import { DEBIAN_FACTS, FakeExecutor } from '../testing/fake-executor.ts';

describe('tableFile and bootDefinition', () => {
  it('names files safely', () => {
    const directory = bootDirectory(platform('linux'));
    expect(directory).toBe('/etc/hopdeck/firewall');
    expect(tableFile(directory, 'inet', 'filter')).toBe('/etc/hopdeck/firewall/inet-filter.nft');
    expect(tableFile(directory, 'ip', 'a b/c')).toBe('/etc/hopdeck/firewall/ip-a%20b%2fc.nft');
  });

  it('saves nothing on OpenWrt, whose boot firewall comes from UCI', async () => {
    const executor = new FakeExecutor(() => new Error('must not run'));
    const facts = { ...parseFacts(DEBIAN_FACTS), platform: 'openwrt' as const };
    const target: PersistTarget = { kind: 'ssh', executor, access: { executor, nftPath: '/usr/sbin/nft', privilege: { kind: 'root' } }, facts };
    const status = await persistenceStatus(target);
    expect(status.problem).toMatchObject({ code: 'persistence-unavailable', detail: expect.stringContaining('UCI') });
    expect(await persistTables(target, [{ family: 'inet', name: 'filter' }])).toMatchObject({ written: [], problem: { code: 'persistence-unavailable' } });
    expect(executor.calls).toEqual([]);
  });

  it('loads at boot with fresh counters and full timeouts, replacing any earlier definition', () => {
    const listing = 'table inet t {\n\tcounter c {\n\t\tpackets 12 bytes 3400\n\t}\n\tset s {\n\t\telements = { 10.0.0.1 timeout 1h expires 59m12s }\n\t}\n}\n';
    const boot = bootDefinition('inet', 't', listing);
    expect(boot).toContain('table inet t {}\ndelete table inet t\ntable inet t {');
    expect(boot).toContain('packets 0 bytes 0');
    expect(boot).toContain('10.0.0.1 timeout 1h }');
    expect(boot.startsWith('# Written by hopdeck')).toBe(true);
  });
});

// Against the podman test host: HOPDECK_TEST_HOST=1 pnpm test (after dev/test-host/up.sh).
const sshConfig = new URL('../../../../.dev/test-host/ssh_config', import.meta.url).pathname;

describe.skipIf(!process.env['HOPDECK_TEST_HOST'] || !existsSync(sshConfig))('persistence on the test host', { timeout: 90_000 }, () => {
  let root: PersistTarget & { deploy: DeployTarget };
  let backup: string | undefined;
  // As HostManager wires it: a kept change is saved for boot.
  const deployments = new Deployments({ seconds: 30, afterConfirm: (view) => persistTables(root, view.tables) });

  const connect = async (account: 'root' | 'nopass') => {
    const controlDir = await mkdtemp(`${tmpdir()}/hopdeck-persist-`);
    const destination = `hopdeck-test-${account}`;
    const executor = new SshExecutor({ destination, controlDir, configFile: sshConfig });
    const access = { executor, nftPath: '/usr/sbin/nft', privilege: account === 'root' ? ({ kind: 'root' } as const) : ({ kind: 'sudo' } as const) };
    const facts = await collectFacts(executor);
    const deploy: DeployTarget = {
      hostId: destination,
      name: destination,
      kind: 'ssh',
      executor,
      access,
      platform: platform('linux'),
      systemd: true,
      manualOverride: false,
      freshExecutor: new SshExecutor({ destination, controlDir, configFile: sshConfig, shareConnection: false }),
    };
    return { kind: 'ssh' as const, executor, access, facts, deploy };
  };
  const reload = () => root.executor.exec(['systemctl', 'restart', 'nftables.service']);
  const change = async (changes: Parameters<Deployments['prepare']>[1]) => {
    const plan = await deployments.prepare(root.deploy, changes);
    await deployments.apply(plan.id, root.deploy);
    return deployments.confirm(plan.id, root.deploy);
  };

  beforeAll(async () => {
    root = await connect('root');
  });

  afterAll(async () => {
    // Put the test host back as it was.
    if (backup !== undefined) await root.executor.exec(['cp', '-p', backup, '/etc/nftables.conf']);
    await root.executor.exec(['sh', '-c', 'rm -rf /etc/hopdeck /etc/nftables.conf.hopdeck-backup-*; systemctl restart nftables.service']);
  });

  it('finds the boot configuration through the nftables service', async () => {
    const status = await persistenceStatus(root);
    expect(status).toMatchObject({ mainConfig: '/etc/nftables.conf', source: 'service', serviceEnabled: true, includePresent: false });
  });

  it('adds the include once, keeping a backup', async () => {
    await addInclude(root);
    await addInclude(root);
    const main = (await root.executor.exec(['cat', '/etc/nftables.conf'])).stdout;
    expect(main.split('\n').filter((line) => line === includeLine('/etc/hopdeck/firewall'))).toHaveLength(1);
    backup = (await root.executor.exec(['sh', '-c', 'ls /etc/nftables.conf.hopdeck-backup-*'])).stdout.trim();
    expect(backup).toMatch(/hopdeck-backup-\d{14}$/);
    expect((await persistenceStatus(root)).includePresent).toBe(true);
    // Root's alone: host settings and the boot tables.
    expect((await root.executor.exec(['stat', '-c', '%a %U', '/etc/hopdeck', '/etc/hopdeck/firewall'])).stdout).toBe('700 root\n700 root\n');
  });

  it('keeps a kept change across a reload of the boot configuration, and forgets a deleted table', async () => {
    const created = await change([{ kind: 'replace', family: 'inet', table: 'hopdeck_boot', definition: 'table inet hopdeck_boot {\n\tset s {\n\t\ttype ipv4_addr\n\t}\n}\n' }]);
    expect(created.persisted).toMatchObject({ written: ['/etc/hopdeck/firewall/inet-hopdeck_boot.nft'], removed: [] });
    expect((await persistenceStatus(root)).tables).toEqual([
      { family: 'inet', name: 'hopdeck_boot', file: '/etc/hopdeck/firewall/inet-hopdeck_boot.nft', state: 'saved', alsoInMainConfig: false },
    ]);

    expect((await reload()).exitCode).toBe(0);
    expect((await readTable(root.access, 'inet', 'hopdeck_boot'))?.text).toContain('comment "managed by hopdeck"');

    const deleted = await change([{ kind: 'delete', family: 'inet', table: 'hopdeck_boot' }]);
    expect(deleted.persisted).toMatchObject({ written: [], removed: ['/etc/hopdeck/firewall/inet-hopdeck_boot.nft'] });
    await reload();
    expect(await readTable(root.access, 'inet', 'hopdeck_boot')).toBeUndefined();
  });

  it('says why nothing can be saved when sudo allows only nft', async () => {
    const nopass = await connect('nopass');
    const status = await persistenceStatus(nopass);
    expect(status.problem).toMatchObject({ code: 'persistence-unavailable', detail: expect.stringContaining('sudo allows only nft') });
    expect((await persistTables(nopass, [{ family: 'inet', name: 'x' }])).problem?.code).toBe('persistence-unavailable');
  });
});
