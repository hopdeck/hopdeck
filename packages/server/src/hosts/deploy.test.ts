import { parseListing, parseRuleset, type Executor } from '@hopdeck/core';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDefinition, comparable, Deployments, planTable, readTable, type CurrentTable, type DeployTarget } from './deploy.ts';
import { HostError } from './errors.ts';
import { Sandbox } from './sandbox.ts';

const MINE = 'table inet mine {\n\tchain input {\n\t\ttype filter hook input priority filter; policy accept;\n\t}\n}\n';

function current(text: string, comment?: string): CurrentTable {
  const table = { family: 'inet' as const, name: 'mine', handle: 1, ...(comment !== undefined && { comment }) };
  const node = parseRuleset({ nftables: [{ table }] }).tables[0]!;
  return { node, listing: parseListing(text), text };
}

describe('planTable', () => {
  it('adopts a plain table by adding the marker', () => {
    const plan = planTable({ kind: 'adopt', family: 'inet', table: 'mine' }, current(MINE), false);
    expect(plan.action).toBe('adopt');
    expect(plan.diff.filter((line) => line.kind !== 'same')).toEqual([{ kind: 'add', text: '\tcomment "managed by hopdeck"' }]);
  });

  it('changes unmanaged tables only with Manual override, and keeps the marker on managed ones', () => {
    const replace = { kind: 'replace' as const, family: 'inet' as const, table: 'mine', definition: MINE };
    expect(() => planTable(replace, current(MINE), false)).toThrow(/adopt it first, or switch on Manual override/);
    expect(planTable(replace, current(MINE), true).after).toBe(MINE);
    expect(planTable(replace, current(MINE, 'managed by hopdeck'), false).after).toContain('comment "managed by hopdeck"');
    expect(planTable(replace, undefined, false)).toMatchObject({ action: 'create', before: undefined });
  });

  it('changes elements of a set in place, and can put them back', () => {
    const text = 'table inet mine {\n\tset allow {\n\t\ttype ipv4_addr\n\t\telements = { 10.0.0.1, 10.0.0.2 comment "b" }\n\t}\n}\n';
    const change = { kind: 'elements' as const, family: 'inet' as const, table: 'mine', set: 'allow', setKind: 'set' as const, add: ['10.0.0.3'], remove: ['10.0.0.1'] };
    expect(() => planTable(change, current(text), false)).toThrow(/adopt it first/);
    const plan = planTable(change, current(text, 'managed by hopdeck'), false);
    expect(plan).toMatchObject({
      action: 'elements',
      set: { kind: 'set', name: 'allow' },
      after: undefined,
      script: 'delete element inet mine allow { 10.0.0.1 }\ncreate element inet mine allow { 10.0.0.3 }\n',
      rollback: 'flush set inet mine allow\nadd element inet mine allow { 10.0.0.1, 10.0.0.2 comment "b" }\n',
    });
    expect(plan.diff.filter((line) => line.kind !== 'same')).toEqual([
      { kind: 'remove', text: '10.0.0.1' },
      { kind: 'add', text: '10.0.0.3' },
    ]);
    expect(() => planTable({ ...change, set: 'nope' }, current(text, 'managed by hopdeck'), false)).toThrow(/has no set nope/);
    expect(() => planTable({ ...change, add: ['1.2.3.4 }\nflush ruleset'] }, current(text, 'managed by hopdeck'), false)).toThrow(/newline/);
  });

  it('takes sets the editor left alone from the host as it is now', () => {
    const table = (elements: string, policy: string) =>
      `table inet mine {\n\tcomment "managed by hopdeck"\n\tset s {\n\t\ttype ipv4_addr\n\t\tflags timeout\n\t\telements = { ${elements} }\n\t}\n\n\tchain input {\n\t\ttype filter hook input priority filter; policy ${policy};\n\t}\n}\n`;
    const base = table('1.1.1.1 expires 50m, 2.2.2.2 expires 10s', 'accept');
    const now = table('1.1.1.1 expires 49m', 'accept');
    const change = { kind: 'replace' as const, family: 'inet' as const, table: 'mine', definition: table('1.1.1.1 expires 50m, 2.2.2.2 expires 10s', 'drop'), base };
    const plan = planTable(change, current(now, 'managed by hopdeck'), false);
    expect(plan.after).toBe(table('1.1.1.1 expires 49m', 'drop'));
    expect(plan.diff.filter((line) => line.kind !== 'same').map((line) => line.text)).toEqual([
      '\t\ttype filter hook input priority filter; policy drop;',
      '\t\ttype filter hook input priority filter; policy accept;',
    ]);
  });

  it('never adopts tables of other tools', () => {
    const firewalld = current('table inet firewalld {\n}\n');
    firewalld.node.table.name = 'firewalld';
    expect(() => planTable({ kind: 'adopt', family: 'inet', table: 'firewalld' }, firewalld, true)).toThrow(/cannot be adopted/);
  });
});

describe('checkDefinition', () => {
  const check = (definition: string) => () => checkDefinition(definition, 'inet', 'mine');

  it('accepts one indented block for the named table', () => {
    expect(check(MINE)).not.toThrow();
  });

  it('refuses anything that could reach other tables or files', () => {
    expect(check(MINE.replace('mine', 'other'))).toThrow(/must start with "table inet mine \{"/);
    expect(check(`${MINE}flush ruleset\n`)).toThrow(/must end with/);
    expect(check(MINE.replace('\tchain input {', 'flush ruleset\n\tchain input {'))).toThrow(/must be indented/);
    expect(check(MINE.replace('\tchain input {', '\tinclude "/etc/shadow"\n\tchain input {'))).toThrow(/include is not allowed/);
  });
});

describe('comparable', () => {
  it('ignores what changes on its own', () => {
    const a = 'counter c {\n\tpackets 1 bytes 60\n}\nelements = { 10.0.0.1 timeout 1h expires 59m1s }\nquota q { over 1 mbytes used 10 bytes }';
    const b = 'counter c {\n\tpackets 9 bytes 900\n}\nelements = { 10.0.0.1 timeout 1h expires 2m }\nquota q { over 1 mbytes used 90 kbytes }';
    expect(comparable(a)).toBe(comparable(b));
    expect(comparable(a)).not.toBe(comparable(a.replace('10.0.0.1', '10.0.0.2')));
  });
});

const NFT = ['/usr/sbin/nft', '/sbin/nft', '/usr/bin/nft'].find((path) => existsSync(path));
const USERNS = spawnSync('unshare', ['--user', '--map-root-user', '--net', 'true']).status === 0;

describe.skipIf(NFT === undefined || !USERNS)('Deployments in a sandbox', { timeout: 20_000 }, () => {
  const nft = NFT!;
  let sandbox: Sandbox;
  let target: DeployTarget;
  let executor: Executor;
  const deployments = new Deployments({ seconds: 2 });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const table = async () => (await readTable(target.access, 'inet', 'mine'))?.text ?? '';

  beforeAll(async () => {
    sandbox = await Sandbox.start();
    executor = sandbox.executor;
    await sandbox.load(`${MINE}table inet firewalld {\n\tchain filter_INPUT {\n\t\ttype filter hook input priority filter + 10; policy accept;\n\t}\n}\n`);
    target = {
      hostId: 'sandbox',
      name: 'sandbox',
      kind: 'sandbox',
      executor,
      access: { executor, nftPath: nft, privilege: { kind: 'root' } },
      systemd: true,
      manualOverride: false,
      freshExecutor: undefined,
    };
  });
  afterAll(() => sandbox.dispose());

  it('adopts a table, and the watchdog stands down once confirmed', async () => {
    const plan = await deployments.prepare(target, [{ kind: 'adopt', family: 'inet', table: 'mine' }]);
    expect(plan).toMatchObject({ state: 'planned', validation: { ok: true }, safety: { watchdog: 'detached', seconds: 2 } });

    const applied = await deployments.apply(plan.id, target);
    expect(applied.state).toBe('awaiting-confirmation');
    expect(await table()).toContain('comment "managed by hopdeck"');

    expect((await deployments.confirm(plan.id, target)).state).toBe('confirmed');
    await sleep(3000);
    expect(await table()).toContain('comment "managed by hopdeck"');
    expect((await executor.exec(['test', '-e', plan.safety.directory])).exitCode).toBe(1);
  });

  it('rolls back on request', async () => {
    const before = await table();
    const plan = await deployments.prepare(target, [
      { kind: 'replace', family: 'inet', table: 'mine', definition: MINE.replace('policy accept;', 'policy accept;\n\t\ttcp dport 22 accept') },
    ]);
    await deployments.apply(plan.id, target);
    expect(await table()).toContain('tcp dport 22 accept');
    expect(await deployments.rollback(plan.id, target)).toMatchObject({ state: 'rolled-back', outcome: { reason: 'user' } });
    expect(await table()).toBe(before);
  });

  it('rolls back on its own when nobody confirms', async () => {
    const before = await table();
    const plan = await deployments.prepare(target, [{ kind: 'replace', family: 'inet', table: 'mine', definition: MINE.replace('accept;', 'drop;') }]);
    await deployments.apply(plan.id, target);
    expect(await table()).toContain('policy drop');
    await sleep(3000);
    expect(await deployments.refresh(plan.id, target)).toMatchObject({ state: 'rolled-back', outcome: { reason: 'timeout' } });
    expect(await table()).toBe(before);
  });

  it("shows nft's own message for an invalid change, and applies nothing", async () => {
    const plan = await deployments.prepare(target, [
      { kind: 'replace', family: 'inet', table: 'mine', definition: MINE.replace('policy accept;', 'policy accept;\n\t\ttcp dport 22 acept') },
    ]);
    expect(plan.state).toBe('invalid');
    expect(plan.validation.message).toMatch(/syntax error/);
    await expect(deployments.apply(plan.id, target)).rejects.toMatchObject({ code: 'deployment-state' });
  });

  it('adds and removes set elements, and a rollback restores them with their timeouts and comments', async () => {
    const sets = async () => (await readTable(target.access, 'inet', 'sets'))?.text ?? '';
    const created = await deployments.prepare(target, [
      {
        kind: 'replace',
        family: 'inet',
        table: 'sets',
        definition: 'table inet sets {\n\tset block {\n\t\ttype ipv4_addr\n\t\tflags timeout\n\t\telements = { 1.1.1.1 timeout 1h comment "bot", 2.2.2.2 }\n\t}\n}\n',
      },
    ]);
    await deployments.apply(created.id, target);
    await deployments.confirm(created.id, target);
    const before = await sets();

    const change = { kind: 'elements' as const, family: 'inet' as const, table: 'sets', set: 'block', setKind: 'set' as const };
    const plan = await deployments.prepare(target, [{ ...change, add: ['3.3.3.3 timeout 10m'], remove: ['2.2.2.2'] }]);
    expect(plan.validation).toEqual({ ok: true, message: '' });
    await deployments.apply(plan.id, target);
    expect(await sets()).toContain('3.3.3.3 timeout 10m');
    expect(await sets()).not.toContain('2.2.2.2');
    await deployments.rollback(plan.id, target);
    expect(comparable(await sets())).toBe(comparable(before));

    const missing = await deployments.prepare(target, [{ ...change, add: [], remove: ['9.9.9.9'] }]);
    expect(missing.state).toBe('invalid');
    expect(missing.validation.message).toMatch(/No such file or directory/);
    const duplicate = await deployments.prepare(target, [{ ...change, add: ['1.1.1.1'], remove: [] }]);
    expect(duplicate.validation.message).toMatch(/File exists/);
  });

  it('refuses tables it does not manage, and stops when the table changed meanwhile', async () => {
    await expect(deployments.prepare(target, [{ kind: 'adopt', family: 'inet', table: 'firewalld' }])).rejects.toThrow(HostError);

    const plan = await deployments.prepare(target, [{ kind: 'replace', family: 'inet', table: 'mine', definition: MINE }]);
    await executor.exec([nft, 'add', 'rule', 'inet', 'mine', 'input', 'udp', 'dport', '53', 'accept']);
    await expect(deployments.apply(plan.id, target)).rejects.toMatchObject({ code: 'ruleset-changed' });
  });
});

// Against the podman test host: HOPDECK_TEST_HOST=1 pnpm test (after dev/test-host/up.sh).
const repo = new URL('../../../../', import.meta.url).pathname;
const sshConfig = `${repo}.dev/test-host/ssh_config`;

describe.skipIf(!process.env['HOPDECK_TEST_HOST'] || !existsSync(sshConfig))('Deployments on the test host', { timeout: 90_000 }, () => {
  const deployments = new Deployments({ seconds: 5 });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let controlDir: string;

  const hostTarget = async (account: 'root' | 'nopass' | 'admin'): Promise<DeployTarget> => {
    const { SshExecutor } = await import('./ssh.ts');
    const destination = `hopdeck-test-${account}`;
    const executor = new SshExecutor({ destination, controlDir, configFile: sshConfig });
    const privilege =
      account === 'root' ? ({ kind: 'root' } as const) : account === 'nopass' ? ({ kind: 'sudo' } as const) : ({ kind: 'sudo-password' } as const);
    return {
      hostId: destination,
      name: destination,
      kind: 'ssh',
      executor,
      access: { executor, nftPath: '/usr/sbin/nft', privilege, ...(account === 'admin' && { password: 'hopdeck-test' }) },
      systemd: true,
      manualOverride: false,
      freshExecutor: new SshExecutor({ destination, controlDir, configFile: sshConfig, shareConnection: false }),
    };
  };
  const create = (table: string, body: string) => ({
    kind: 'replace' as const,
    family: 'inet' as const,
    table,
    definition: `table inet ${table} {\n${body}\n}\n`,
  });
  const remove = (table: string) => ({ kind: 'delete' as const, family: 'inet' as const, table });

  beforeAll(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    controlDir = await mkdtemp(`${tmpdir()}/hopdeck-deploy-`);
  });

  it('under sudo with a password, keeps its files where only root can change them', async () => {
    const target = await hostTarget('admin');
    const { makeStaging, stageFile, removeStaging } = await import('./staging.ts');
    const staging = await makeStaging(target);
    expect(staging.asRoot).toBe(true);
    await stageFile(target, staging, 'watchdog.sh', 'echo safe\n');
    const owner = await target.executor.exec(['stat', '-c', '%U %a', staging.dir]);
    expect(owner.stdout.trim()).toBe('root 700');
    // The login user can neither replace the script nor even see it.
    expect((await target.executor.exec(['sh', '-c', 'echo "id > /tmp/pwned" > "$1/watchdog.sh"', 'sh', staging.dir])).exitCode).not.toBe(0);
    await removeStaging(target, staging);
  });

  it('as root, protects the change with a systemd watchdog', async () => {
    const target = await hostTarget('root');
    const plan = await deployments.prepare(target, [create('hopdeck_root', '\tchain c {\n\t\ttype filter hook input priority 100; policy accept;\n\t}')]);
    expect(plan.safety).toMatchObject({ watchdog: 'systemd', freshConnectionCheck: true });
    expect((await deployments.apply(plan.id, target)).state).toBe('awaiting-confirmation');
    expect((await deployments.confirm(plan.id, target)).state).toBe('confirmed');
    const cleanup = await deployments.prepare(target, [remove('hopdeck_root')]);
    await deployments.apply(cleanup.id, target);
    await deployments.confirm(cleanup.id, target);
  });

  // The classic mistake: established traffic still flows, new connections (like the next ssh) are dropped.
  const lockout = create(
    'hopdeck_lockout',
    '\tchain input {\n\t\ttype filter hook input priority filter; policy drop;\n\t\tct state established,related accept\n\t}',
  );

  it('undoes at once a change that blocks new SSH connections', async () => {
    const target = await hostTarget('root');
    const patient = new Deployments({ seconds: 40 });
    const plan = await patient.prepare(target, [lockout]);
    const applied = await patient.apply(plan.id, target);
    expect(applied).toMatchObject({ state: 'rolled-back', outcome: { reason: 'fresh-connection-failed' } });
    expect((await target.freshExecutor!.exec(['true'])).exitCode).toBe(0);
    expect(await readTable(target.access, 'inet', 'hopdeck_lockout')).toBeUndefined();
  });

  it('reports a watchdog that rolled back during the connection check, instead of awaiting confirmation', async () => {
    // With 5 s the watchdog restores the tables while the check still waits for
    // its 10 s connect timeout; the check then gets through.
    const target = await hostTarget('root');
    const plan = await deployments.prepare(target, [lockout]);
    const applied = await deployments.apply(plan.id, target);
    expect(applied).toMatchObject({ state: 'rolled-back', outcome: { reason: 'timeout' } });
    expect(await readTable(target.access, 'inet', 'hopdeck_lockout')).toBeUndefined();
  });

  it('with sudo for nft only, the watchdog survives the SSH session and rolls back', async () => {
    const target = await hostTarget('nopass');
    const plan = await deployments.prepare(target, [create('hopdeck_nopass', '\tset s {\n\t\ttype ipv4_addr\n\t}')]);
    expect(plan.safety.watchdog).toBe('detached');
    await deployments.apply(plan.id, target);
    expect(await readTable(target.access, 'inet', 'hopdeck_nopass')).toBeDefined();
    await sleep(7000);
    expect(await deployments.refresh(plan.id, target)).toMatchObject({ state: 'rolled-back', outcome: { reason: 'timeout' } });
    expect(await readTable(target.access, 'inet', 'hopdeck_nopass')).toBeUndefined();
  });

  it('with a sudo password, starts the watchdog through sudo and systemd', async () => {
    const target = await hostTarget('admin');
    const plan = await deployments.prepare(target, [create('hopdeck_admin', '\tset s {\n\t\ttype ipv4_addr\n\t}')]);
    expect(plan.safety.watchdog).toBe('systemd');
    await deployments.apply(plan.id, target);
    expect((await deployments.rollback(plan.id, target)).state).toBe('rolled-back');
    expect(await readTable(target.access, 'inet', 'hopdeck_admin')).toBeUndefined();
  });
});
