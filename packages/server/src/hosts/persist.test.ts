import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Deployments, readTable, type DeployTarget } from './deploy.ts';
import { collectFacts } from './facts.ts';
import { addInclude, bootDefinition, INCLUDE_LINE, persistenceStatus, persistTables, tableFile, type PersistTarget } from './persist.ts';
import { SshExecutor } from './ssh.ts';

describe('tableFile and bootDefinition', () => {
  it('names files safely', () => {
    expect(tableFile('inet', 'filter')).toBe('/etc/nftm/inet-filter.nft');
    expect(tableFile('ip', 'a b/c')).toBe('/etc/nftm/ip-a%20b%2fc.nft');
  });

  it('loads at boot with fresh counters and full timeouts, replacing any earlier definition', () => {
    const listing = 'table inet t {\n\tcounter c {\n\t\tpackets 12 bytes 3400\n\t}\n\tset s {\n\t\telements = { 10.0.0.1 timeout 1h expires 59m12s }\n\t}\n}\n';
    const boot = bootDefinition('inet', 't', listing);
    expect(boot).toContain('table inet t {}\ndelete table inet t\ntable inet t {');
    expect(boot).toContain('packets 0 bytes 0');
    expect(boot).toContain('10.0.0.1 timeout 1h }');
    expect(boot.startsWith('# Written by nftm')).toBe(true);
  });
});

// Against the podman test host: NFTM_TEST_HOST=1 pnpm test (after dev/test-host/up.sh).
const sshConfig = new URL('../../../../.dev/test-host/ssh_config', import.meta.url).pathname;

describe.skipIf(!process.env['NFTM_TEST_HOST'] || !existsSync(sshConfig))('persistence on the test host', { timeout: 90_000 }, () => {
  let root: PersistTarget & { deploy: DeployTarget };
  let backup: string | undefined;
  // As HostManager wires it: a kept change is saved for boot.
  const deployments = new Deployments({ seconds: 30, afterConfirm: (view) => persistTables(root, view.tables) });

  const connect = async (account: 'root' | 'nopass') => {
    const controlDir = await mkdtemp(`${tmpdir()}/nftm-persist-`);
    const destination = `nftm-test-${account}`;
    const executor = new SshExecutor({ destination, controlDir, configFile: sshConfig });
    const access = { executor, nftPath: '/usr/sbin/nft', privilege: account === 'root' ? ({ kind: 'root' } as const) : ({ kind: 'sudo' } as const) };
    const facts = await collectFacts(executor);
    const deploy: DeployTarget = {
      hostId: destination,
      name: destination,
      kind: 'ssh',
      executor,
      access,
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
    await root.executor.exec(['sh', '-c', 'rm -rf /etc/nftm /etc/nftables.conf.nftm-backup-*; systemctl restart nftables.service']);
  });

  it('finds the boot configuration through the nftables service', async () => {
    const status = await persistenceStatus(root);
    expect(status).toMatchObject({ mainConfig: '/etc/nftables.conf', source: 'service', serviceEnabled: true, includePresent: false });
  });

  it('adds the include once, keeping a backup', async () => {
    await addInclude(root);
    await addInclude(root);
    const main = (await root.executor.exec(['cat', '/etc/nftables.conf'])).stdout;
    expect(main.split('\n').filter((line) => line === INCLUDE_LINE)).toHaveLength(1);
    backup = (await root.executor.exec(['sh', '-c', 'ls /etc/nftables.conf.nftm-backup-*'])).stdout.trim();
    expect(backup).toMatch(/nftm-backup-\d{14}$/);
    expect((await persistenceStatus(root)).includePresent).toBe(true);
  });

  it('keeps a kept change across a reload of the boot configuration, and forgets a deleted table', async () => {
    const created = await change([{ kind: 'replace', family: 'inet', table: 'nftm_boot', definition: 'table inet nftm_boot {\n\tset s {\n\t\ttype ipv4_addr\n\t}\n}\n' }]);
    expect(created.persisted).toMatchObject({ written: ['/etc/nftm/inet-nftm_boot.nft'], removed: [] });
    expect((await persistenceStatus(root)).tables).toEqual([
      { family: 'inet', name: 'nftm_boot', file: '/etc/nftm/inet-nftm_boot.nft', state: 'saved', alsoInMainConfig: false },
    ]);

    expect((await reload()).exitCode).toBe(0);
    expect((await readTable(root.access, 'inet', 'nftm_boot'))?.text).toContain('comment "managed by nftm"');

    const deleted = await change([{ kind: 'delete', family: 'inet', table: 'nftm_boot' }]);
    expect(deleted.persisted).toMatchObject({ written: [], removed: ['/etc/nftm/inet-nftm_boot.nft'] });
    await reload();
    expect(await readTable(root.access, 'inet', 'nftm_boot')).toBeUndefined();
  });

  it('says why nothing can be saved when sudo allows only nft', async () => {
    const nopass = await connect('nopass');
    const status = await persistenceStatus(nopass);
    expect(status.problem).toMatchObject({ code: 'persistence-unavailable', detail: expect.stringContaining('sudo allows only nft') });
    expect((await persistTables(nopass, [{ family: 'inet', name: 'x' }])).problem?.code).toBe('persistence-unavailable');
  });
});
