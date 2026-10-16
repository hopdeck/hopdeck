// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { parseRuleset, planPortForward, platform, portForwards, type Executor, type PortForward, type TableChange } from '@hopdeck/core';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enableForwarding, FORWARDING_FILE, readNetwork, readRoute } from '../hosts/network.ts';
import { hasAccount, hostTarget, testHost } from '../testing/test-host.ts';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Sandbox } from '../hosts/sandbox.ts';
import { Deployments, type DeployTarget } from './deploy.ts';

const NFT = ['/usr/sbin/nft', '/sbin/nft', '/usr/bin/nft'].find((path) => existsSync(path));
const USERNS = spawnSync('unshare', ['--user', '--map-root-user', '--net', 'true']).status === 0;

/** A host whose managed table drops forwarded packets, beside iptables-nft's, as Docker leaves it. */
const HOST = readFileSync(new URL('../../../core/test/fixtures/forward-host.nft', import.meta.url), 'utf8');

const WEB: PortForward = {
  name: 'web',
  protocols: ['tcp'],
  ports: '8080',
  inInterfaces: ['eth0'],
  target: '192.168.1.10',
  targetPort: '80',
  outInterfaces: ['lan0'],
  masquerade: false,
  hairpin: '192.168.1.0/24',
  log: true,
  limit: 20,
};

describe.skipIf(NFT === undefined || !USERNS)('port forwards in a sandbox', { timeout: 30_000 }, () => {
  let sandbox: Sandbox;
  let executor: Executor;
  let target: DeployTarget;
  const deployments = new Deployments({ seconds: 5 });
  const read = async () => {
    const json = await executor.exec([NFT!, '-j', 'list', 'ruleset']);
    const listing = await executor.exec([NFT!, '-a', 'list', 'ruleset']);
    return { ruleset: parseRuleset(JSON.parse(json.stdout)), listing: listing.stdout };
  };
  const deploy = async (changes: TableChange[]) => {
    const plan = await deployments.prepare(target, changes);
    expect(plan.validation, JSON.stringify(plan.validation)).toMatchObject({ ok: true });
    await deployments.apply(plan.id, target);
    return deployments.confirm(plan.id, target);
  };

  beforeAll(async () => {
    sandbox = await Sandbox.start();
    executor = sandbox.executor;
    await sandbox.load(HOST);
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

  it('turns on forwarding in its own network namespace', async () => {
    expect((await readNetwork(executor)).interfaces.map((entry) => entry.name)).toContain('lo');
    const network = await enableForwarding({ executor, access: target.access }, 'ip', false);
    expect(network.forwarding.ip).toBe(true);
  });

  it('puts a forward on the host through the usual deployment, and reads it back as it was', async () => {
    const { ruleset, listing } = await read();
    const plan = planPortForward(ruleset, listing, WEB);
    expect(plan.blocked).toEqual([{ family: 'ip', table: 'filter', chain: 'FORWARD' }]);
    expect((await deploy(plan.changes)).state).toBe('confirmed');
    const found = portForwards((await read()).ruleset);
    expect(found.map((entry) => entry.name)).toEqual(['web']);
    expect(found[0]!.forward).toEqual(WEB);
    expect(found[0]!.rules.map((rule) => `${rule.chain} ${rule.role ?? 'main'}`).sort()).toEqual(['forward accept', 'postrouting hairpin', 'prerouting hairpin', 'prerouting main']);
  });

  it('changes a forward in place of the old one, then removes it with all its rules', async () => {
    const changed = { ...WEB, ports: '8080, 8443', masquerade: true };
    let { ruleset, listing } = await read();
    await deploy(planPortForward(ruleset, listing, changed, { replacing: 'web' }).changes);
    ({ ruleset, listing } = await read());
    expect(portForwards(ruleset).map((entry) => entry.forward)).toEqual([changed]);

    await deploy(planPortForward(ruleset, listing, undefined, { replacing: 'web' }).changes);
    ({ ruleset } = await read());
    expect(portForwards(ruleset)).toEqual([]);
    // The rule that lets replies through stays: other rules may need it.
    expect((await read()).listing).toContain('hopdeck: replies of forwarded connections');
  });
});

// Against a podman test host: each system's ip (BusyBox's on Alpine and OpenWrt) and nft (0.9.8 on Debian 11).
describe.skipIf(testHost === undefined || !hasAccount('root'))('port forwards on the test host', { timeout: 90_000 }, () => {
  let target: DeployTarget;
  const deployments = new Deployments({ seconds: 10 });
  const read = async () => {
    const json = await runNft(['-j', 'list', 'ruleset']);
    const listing = await runNft(['-a', 'list', 'ruleset']);
    return { ruleset: parseRuleset(JSON.parse(json)), listing };
  };
  const runNft = async (args: string[]) => (await target.executor.exec([target.access.nftPath, ...args])).stdout;
  const deploy = async (changes: TableChange[]) => {
    const plan = await deployments.prepare(target, changes);
    expect(plan.validation, JSON.stringify(plan.validation)).toMatchObject({ ok: true });
    await deployments.apply(plan.id, target);
    return deployments.confirm(plan.id, target);
  };

  beforeAll(async () => {
    target = await hostTarget('root', await mkdtemp(`${tmpdir()}/hopdeck-forward-`));
  });

  it('reads the interfaces with their addresses, and a route', async () => {
    const network = await readNetwork(target.executor);
    // podman's pasta names the container's interface after the host's, so any name will do.
    expect(network.interfaces.some((entry) => entry.name !== 'lo' && entry.addresses.some((address) => address.family === 'ip'))).toBe(true);
    expect(typeof network.forwarding.ip).toBe('boolean');
    const gateway = await readRoute(target.executor, '192.0.2.1');
    expect(gateway.device ?? gateway.problem).toBeTruthy();
  });

  it.runIf(testHost?.platform === 'linux')('turns on forwarding, at boot too, in a file of its own, or says why it cannot', async () => {
    // Containers have /proc/sys read-only (BusyBox's test -w tells root otherwise); the sandbox test turns it on in a namespace that may.
    try {
      const enabled = await enableForwarding({ executor: target.executor, access: target.access }, 'ip', true).catch((error: unknown) => error);
      if (enabled instanceof Error) {
        expect(enabled).toMatchObject({ code: 'command-failed', detail: expect.stringMatching(/Read-only file system/) });
        expect((await target.executor.exec(['test', '-e', FORWARDING_FILE])).exitCode).toBe(1);
        return;
      }
      expect((enabled as Awaited<ReturnType<typeof enableForwarding>>).forwarding.ip).toBe(true);
      expect((await target.executor.exec(['cat', FORWARDING_FILE])).stdout).toContain('net.ipv4.ip_forward = 1');
    } finally {
      await target.executor.exec(['sh', '-c', 'echo 0 > /proc/sys/net/ipv4/ip_forward; rm -f "$1"', 'sh', FORWARDING_FILE]);
    }
  });

  it.runIf(testHost?.platform === 'linux')('writes a forward that this nft takes, reads it back, and removes it', async () => {
    const forward: PortForward = { ...WEB, protocols: ['tcp', 'udp'], ports: '8080, 9000-9010', masquerade: true, sources: '198.51.100.0/24' };
    let { ruleset, listing } = await read();
    const nat = { family: 'inet' as const, name: 'hopdeck_forward_test', exists: false };
    expect((await deploy(planPortForward(ruleset, listing, forward, { natTable: nat }).changes)).state).toBe('confirmed');
    try {
      ({ ruleset, listing } = await read());
      expect(portForwards(ruleset).find((entry) => entry.name === 'web')?.forward).toEqual(forward);
    } finally {
      ({ ruleset, listing } = await read());
      await deploy([
        ...planPortForward(ruleset, listing, undefined, { replacing: 'web' }).changes.filter((change) => change.table !== nat.name),
        { kind: 'delete', family: 'inet', table: nat.name },
      ]);
    }
    expect(portForwards((await read()).ruleset)).toEqual([]);
  });
});

