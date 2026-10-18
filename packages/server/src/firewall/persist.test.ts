// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { platform } from '@hopdeck/core';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Deployments, readTable, type DeployTarget } from './deploy.ts';
import { parseFacts } from '../hosts/facts.ts';
import { addInclude, bootDefinition, bootDirectory, includeLine, mainConfigNote, persistenceStatus, persistTables, tableFile, withTableNotes, type PersistTarget } from './persist.ts';
import { DEBIAN_FACTS, FakeExecutor } from '../testing/fake-executor.ts';
import { hasAccount, hostTarget, testHost, type Account } from '../testing/test-host.ts';

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

describe('withTableNotes', () => {
  const include = includeLine('/etc/hopdeck/firewall');
  const filter = { family: 'inet' as const, name: 'filter', file: '/etc/hopdeck/firewall/inet-filter.nft' };
  // As Debian ships it, with hopdeck's include added at the end.
  const main = [
    '#!/usr/sbin/nft -f',
    '',
    'flush ruleset',
    '',
    'table inet filter {',
    '\tchain input {',
    '\t\ttype filter hook input priority filter;',
    '\t}',
    '}',
    'table ip nat {',
    '}',
    '',
    '# Added by hopdeck: the tables it manages are in /etc/hopdeck/firewall.',
    include,
    '',
  ].join('\n');

  it('notes above a table it defines that hopdeck\'s file replaces at boot, once', () => {
    const noted = withTableNotes(main, include, [filter]);
    const lines = noted.split('\n');
    const at = lines.indexOf('table inet filter {');
    expect(lines.slice(at - 2, at)).toEqual(mainConfigNote(filter.file));
    expect(noted.split('\n').filter((line) => line.startsWith('# Managed by hopdeck'))).toHaveLength(1);
    expect(withTableNotes(noted, include, [filter])).toBe(noted);
    // Everything else stays as it was.
    expect(noted.replace(`${mainConfigNote(filter.file).join('\n')}\n`, '')).toBe(main);
  });

  it('takes a note away once it is no longer true, and keeps the user\'s own comments', () => {
    const noted = withTableNotes(`# Managed by hopdeck: my own words\n${main}`, include, [filter]);
    expect(withTableNotes(noted, include, [])).toBe(`# Managed by hopdeck: my own words\n${main}`);
  });

  it('notes nothing after the include, nor without it: hopdeck\'s files do not replace those', () => {
    const after = `${main}table inet late {\n}\n`;
    expect(withTableNotes(after, include, [{ family: 'inet', name: 'late', file: 'x' }])).toBe(after);
    const without = main.replace(include, '');
    expect(withTableNotes(without, include, [filter])).toBe(without);
  });

  it('keeps the indent of the table it notes, and finds quoted names', () => {
    const quoted = `${'\t'}table inet "my table" {\n${'\t'}}\n${include}\n`;
    expect(withTableNotes(quoted, include, [{ family: 'inet', name: 'my table', file: 'f' }]).split('\n')[0]).toBe(`\t${mainConfigNote('f')[0]}`);
  });
});

// Against a test host: dev/test-host/up.sh [SYSTEM] (or dev/vm-host/up.sh), then HOPDECK_TEST_HOST=1 (see testing/test-host.ts).
/** Where each system keeps the configuration its firewall service loads at boot. */
const MAIN_CONFIG: Record<string, string> = { debian: '/etc/nftables.conf', alma: '/etc/sysconfig/nftables.conf', alpine: '/etc/nftables.nft' };

describe.skipIf(testHost?.platform !== 'linux')('persistence on the test host', { timeout: 90_000 }, () => {
  let root: PersistTarget & { deploy: DeployTarget };
  let backup: string | undefined;
  const systemd = testHost?.init === 'systemd';
  const main = MAIN_CONFIG[testHost?.system.replace(/\d+$/, '') ?? ''] ?? '';
  // As HostManager wires it: a kept change is saved for boot.
  const deployments = new Deployments({ seconds: 30, afterConfirm: (view) => persistTables(root, view.tables) });

  const connect = async (account: Account) => {
    const deploy = await hostTarget(account, await mkdtemp(`${tmpdir()}/hopdeck-persist-`));
    return { kind: 'ssh' as const, executor: deploy.executor, access: deploy.access, facts: deploy.facts, deploy };
  };
  // What the machine does at boot: its firewall service loads the main configuration again.
  const reload = () => root.executor.exec(systemd ? ['systemctl', 'restart', 'nftables.service'] : ['rc-service', 'nftables', 'restart']);
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
    if (backup !== undefined) await root.executor.exec(['cp', '-p', backup, main]);
    await root.executor.exec(['sh', '-c', 'rm -rf /etc/hopdeck "$1".hopdeck-backup-*', 'sh', main]);
    await reload();
  });

  it('finds the configuration that loads at boot', async () => {
    const status = await persistenceStatus(root);
    expect(status).toMatchObject(
      systemd
        ? { mainConfig: main, source: 'service', serviceEnabled: true, includePresent: false }
        : { mainConfig: main, source: 'guess', includePresent: false },
    );
  });

  it('adds the include once, keeping a backup', async () => {
    await addInclude(root);
    await addInclude(root);
    const text = (await root.executor.exec(['cat', main])).stdout;
    expect(text.split('\n').filter((line) => line === includeLine('/etc/hopdeck/firewall'))).toHaveLength(1);
    backup = (await root.executor.exec(['sh', '-c', 'ls "$1".hopdeck-backup-*', 'sh', main])).stdout.trim();
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

  it('notes in the main configuration that hopdeck\'s file replaces a table defined there, and takes the note away with the table', async () => {
    const file = '/etc/hopdeck/firewall/inet-hopdeck_main.nft';
    const read = async () => (await root.executor.exec(['cat', main])).stdout;
    // The main configuration defines the table too, before the include, as Debian's does with inet filter.
    const insert = 'awk -v inc="$2" \'$0 == inc { print "table inet hopdeck_main {"; print "}" } { print }\' "$1" > "$1.t" && cat "$1.t" > "$1" && rm "$1.t"';
    await root.executor.exec(['sh', '-c', insert, 'sh', main, includeLine('/etc/hopdeck/firewall')]);
    const mode = (await root.executor.exec(['stat', '-c', '%a', main])).stdout;

    await change([{ kind: 'replace', family: 'inet', table: 'hopdeck_main', definition: 'table inet hopdeck_main {\n\tset s {\n\t\ttype ipv4_addr\n\t}\n}\n' }]);
    const noted = (await read()).split('\n');
    const at = noted.indexOf('table inet hopdeck_main {');
    expect(noted.slice(at - 2, at)).toEqual(mainConfigNote(file));
    expect((await root.executor.exec(['stat', '-c', '%a', main])).stdout).toBe(mode);
    expect((await reload()).exitCode).toBe(0);

    await change([{ kind: 'delete', family: 'inet', table: 'hopdeck_main' }]);
    const after = await read();
    expect(after).not.toContain('# Managed by hopdeck');
    expect(after).toContain('table inet hopdeck_main {');
  });

  it.skipIf(!hasAccount('nopass'))('says why nothing can be saved when sudo allows only nft', async () => {
    const nopass = await connect('nopass');
    const status = await persistenceStatus(nopass);
    expect(status.problem).toMatchObject({ code: 'persistence-unavailable', detail: expect.stringContaining('sudo allows only nft') });
    expect((await persistTables(nopass, [{ family: 'inet', name: 'x' }])).problem?.code).toBe('persistence-unavailable');
  });
});

describe.skipIf(testHost?.platform !== 'openwrt')('persistence on the OpenWrt test host', { timeout: 60_000 }, () => {
  it('saves nothing, since UCI decides what loads at boot', async () => {
    const deploy = await hostTarget('root', await mkdtemp(`${tmpdir()}/hopdeck-persist-`));
    const status = await persistenceStatus({ kind: 'ssh', executor: deploy.executor, access: deploy.access, facts: deploy.facts });
    expect(status.problem).toMatchObject({ code: 'persistence-unavailable', detail: expect.stringContaining('UCI') });
  });
});
