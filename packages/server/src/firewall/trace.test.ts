// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { groupTrace, platform, type Executor, type TraceView } from '@hopdeck/core';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeployTarget } from './deploy.ts';
import { Sandbox } from '../hosts/sandbox.ts';
import { Traces } from './trace.ts';
import { hasAccount, hostTarget, testHost } from '../testing/test-host.ts';

const NFT = ['/usr/sbin/nft', '/sbin/nft', '/usr/bin/nft'].find((path) => existsSync(path));
const USERNS = spawnSync('unshare', ['--user', '--map-root-user', '--net', 'true']).status === 0;
const PING = ['/usr/bin/ping', '/bin/ping'].find((path) => existsSync(path));

const RULESET = `table inet f {
	chain input {
		type filter hook input priority filter; policy accept;
		icmp type echo-request counter drop comment "no ping"
	}
}
`;

describe.skipIf(NFT === undefined || !USERNS || PING === undefined)('Traces in a sandbox', { timeout: 30_000 }, () => {
  let sandbox: Sandbox;
  let executor: Executor;
  let target: DeployTarget;
  const traces = new Traces();
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const tables = async () => (await executor.exec([NFT!, 'list', 'tables'])).stdout;
  const ping = () => executor.exec([PING!, '-c', '1', '-W', '1', '127.0.0.1']);

  beforeAll(async () => {
    sandbox = await Sandbox.start();
    executor = sandbox.executor;
    await sandbox.load(RULESET);
    await executor.exec(['sh', '-c', 'PATH="$PATH:/usr/sbin:/sbin"; ip link set lo up']);
    target = {
      hostId: 'sandbox',
      name: 'sandbox',
      kind: 'sandbox',
      executor,
      access: { executor, nftPath: NFT!, privilege: { kind: 'root' } },
      platform: platform('linux'),
      systemd: true,
      manualOverride: false,
      freshExecutor: undefined,
    };
  });
  afterAll(() => sandbox.dispose());

  it('traces matching packets to the rule that decided, then removes its table', async () => {
    const started = await traces.start(target, { protocol: 'icmp' }, { seconds: 20, perSecond: 10 });
    expect(started).toMatchObject({ state: 'running', perSecond: 10 });
    expect(await tables()).toContain(`table inet ${started.table}`);

    await ping();
    let view: TraceView = started;
    for (let attempt = 0; attempt < 20 && !view.lines.some((line) => line.includes('(verdict drop)')); attempt += 1) {
      await sleep(250);
      view = await traces.get(started.id, target);
    }
    const dropped = groupTrace(view.lines).find((packet) => packet.verdict === 'drop');
    expect(dropped?.decidedBy).toMatchObject({ table: 'f', chain: 'input', kind: 'rule', rule: 'icmp type echo-request counter packets 0 bytes 0 drop comment "no ping"' });
    expect(dropped?.summary).toMatchObject({ saddr: '127.0.0.1', protocol: 'icmp', icmpType: 'echo-request' });

    const stopped = await traces.stop(started.id, target);
    expect(stopped.state).toBe('finished');
    expect(stopped.cleanup).toBeUndefined();
    expect(await tables()).not.toContain(started.table);
  });

  it('removes its table on its own when the time is up', async () => {
    const started = await traces.start(target, { protocol: 'icmp' }, { seconds: 5, perSecond: 10 });
    expect(await tables()).toContain(started.table);
    await sleep(7000);
    expect(await tables()).not.toContain(started.table);
    expect((await traces.get(started.id, target)).state).toBe('finished');
  });

  it('refuses a filter that could be more than a filter, before touching the host', async () => {
    await expect(traces.start(target, { protocol: 'tcp', dport: '22 drop' }, { seconds: 10, perSecond: 10 })).rejects.toMatchObject({ code: 'invalid-filter' });
    expect(await tables()).not.toContain('hopdeck_trace_');
  });
});

// Against a podman test host: dev/test-host/up.sh [SYSTEM], then HOPDECK_TEST_HOST=1 (see testing/test-host.ts).
describe.skipIf(testHost === undefined)('Traces on the test host', { timeout: 60_000 }, () => {
  const traces = new Traces();
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let controlDir: string;

  beforeAll(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    controlDir = await mkdtemp(`${tmpdir()}/hopdeck-trace-`);
  });

  for (const account of ['root', 'nopass', 'admin'] as const) {
    // Under sudo with a password, the tracing table needs systemd to be removed when time is up.
    const possible = hasAccount(account) && (account !== 'admin' || testHost?.init === 'systemd');
    it.skipIf(!possible)(`traces as ${account}, and the host removes the table`, async () => {
      const target = await hostTarget(account, controlDir);
      // hopdeck's own SSH connection is the traffic: the container has no ping.
      const started = await traces.start(target, { protocol: 'tcp', dport: '22' }, { seconds: 30, perSecond: 10 });
      expect(started.state).toBe('running');
      await target.executor.exec(['true']);
      let view: TraceView = started;
      for (let attempt = 0; attempt < 20 && groupTrace(view.lines).length < 2; attempt += 1) {
        await sleep(300);
        view = await traces.get(started.id, target);
      }
      expect(groupTrace(view.lines).length).toBeGreaterThanOrEqual(2);
      expect((await traces.stop(started.id, target)).state).toBe('finished');
      const { runNft } = await import('../hosts/privilege.ts');
      expect((await runNft(target.access, ['list', 'tables'])).stdout).not.toContain(started.table);
    });
  }
});
