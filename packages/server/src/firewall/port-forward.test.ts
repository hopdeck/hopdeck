// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { dropLogPrefix, dropLogRule, parseListing, parseRuleset, planPortForward, platform, portForwards, renderRule, withTableComments, type Executor, type PortForward, type TableChange } from '@hopdeck/core';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enableForwarding, FORWARDING_FILE, readNetwork, readRoute } from '../hosts/network.ts';
import { hasAccount, hostTarget, testHost } from '../testing/test-host.ts';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Sandbox } from '../hosts/sandbox.ts';
import { Deployments, type DeployTarget } from './deploy.ts';
import { readPacketLog } from './packet-log.ts';

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

// Against a test host: each system's ip (BusyBox's on Alpine and OpenWrt) and nft (0.9.8 on Debian 11).
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

// On a VM of dev/vm-host, whose kernel is its own: packets go through a forward
// between network namespaces, and what the policy drops lands in its log.
//
//   client (203.0.113.7) --hdc-- [the VM] --hdlan-- server (198.51.100.2, HTTP on 80)
//                                                \-- neighbor (198.51.100.3)
describe.skipIf(testHost?.vmid === undefined || testHost.platform !== 'linux' || !hasAccount('root'))('a port forward through the kernel of a test VM', { timeout: 120_000 }, () => {
  let target: DeployTarget;
  let forwarding = '0';
  const deployments = new Deployments({ seconds: 15 });
  // A run of its own: a table, forward and log prefixes no earlier run left in the log.
  const run = String(Date.now() % 1_000_000);
  const table = `hd_e2e_${run}`;
  const nat = { family: 'inet' as const, name: `hd_e2e_nat_${run}`, exists: false };
  const prefix = dropLogPrefix('inet', table, 'forward');
  const web: PortForward = {
    name: `web ${run}`,
    protocols: ['tcp'],
    ports: '8080',
    inInterfaces: ['hdc'],
    target: '198.51.100.2',
    targetPort: '80',
    outInterfaces: ['hdlan'],
    masquerade: false,
    hairpin: '198.51.100.0/24',
    log: true,
  };
  const sh = async (script: string) => {
    const result = await target.executor.exec(['sh', '-c', script]);
    return `${result.stdout}${result.stderr}`.trim();
  };
  const must = async (script: string) => {
    const result = await target.executor.exec(['sh', '-c', `set -e\n${script}`]);
    expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(0);
  };
  // Python is there for cloud-init on every cloud image; curl is not.
  const fetch = (namespace: string, url: string) =>
    sh(`ip netns exec ${namespace} python3 -c 'import sys, urllib.request; print(urllib.request.urlopen(sys.argv[1], timeout=3).read().decode().strip())' ${url} 2>/dev/null || echo "no answer"`);
  const read = async () => {
    const json = await target.executor.exec([target.access.nftPath, '-j', 'list', 'ruleset']);
    const listing = await target.executor.exec([target.access.nftPath, '-a', 'list', 'ruleset']);
    // As the panel reads it: nft 0.9.8 leaves table comments, hopdeck's marker among them, out of its JSON.
    return { ruleset: withTableComments(parseRuleset(JSON.parse(json.stdout)), parseListing(listing.stdout)), listing: listing.stdout };
  };
  const deploy = async (changes: TableChange[]) => {
    const plan = await deployments.prepare(target, changes);
    expect(plan.validation, JSON.stringify(plan.validation)).toMatchObject({ ok: true });
    await deployments.apply(plan.id, target);
    return (await deployments.confirm(plan.id, target)).state;
  };
  const cleanup = `
    for ns in hd-client hd-server hd-neighbor; do ip netns pids $ns 2>/dev/null | xargs -r kill 2>/dev/null; ip netns del $ns 2>/dev/null; done
    for link in hdc hdlan hds hdn; do ip link del $link 2>/dev/null; done
    rm -rf /tmp/hd-e2e-www; true`;

  beforeAll(async () => {
    target = await hostTarget('root', await mkdtemp(`${tmpdir()}/hopdeck-vm-forward-`));
    forwarding = (await sh('cat /proc/sys/net/ipv4/ip_forward')) || '0';
    await sh(cleanup);
    await must(`
      for ns in hd-client hd-server hd-neighbor; do ip netns add $ns; ip -n $ns link set lo up; done
      ip link add hdc type veth peer name eth0 netns hd-client
      ip addr add 203.0.113.1/24 dev hdc; ip link set hdc up
      ip link add hdlan type bridge; ip addr add 198.51.100.1/24 dev hdlan; ip link set hdlan up
      ip link add hds type veth peer name eth0 netns hd-server; ip link set hds master hdlan up
      ip link add hdn type veth peer name eth0 netns hd-neighbor; ip link set hdn master hdlan up
      ip -n hd-client addr add 203.0.113.7/24 dev eth0; ip -n hd-server addr add 198.51.100.2/24 dev eth0; ip -n hd-neighbor addr add 198.51.100.3/24 dev eth0
      for ns in hd-client hd-server hd-neighbor; do ip -n $ns link set eth0 up; done
      ip -n hd-client route add default via 203.0.113.1
      ip -n hd-server route add default via 198.51.100.1; ip -n hd-neighbor route add default via 198.51.100.1
      mkdir -p /tmp/hd-e2e-www; echo "served by the target" > /tmp/hd-e2e-www/index.html
      ip netns exec hd-server python3 -m http.server 80 --directory /tmp/hd-e2e-www </dev/null >/dev/null 2>&1 &
      sleep 1`);
  }, 60_000);

  afterAll(async () => {
    await sh(`nft delete table inet ${table} 2>/dev/null; nft delete table inet ${nat.name} 2>/dev/null; echo ${forwarding === '1' ? 1 : 0} > /proc/sys/net/ipv4/ip_forward; ${cleanup}`);
  }, 60_000);

  it('forwards to the target, back to its own network too, drops the rest, and logs both', async () => {
    // A managed table that drops what nothing forwards, and logs it.
    const definition = `table inet ${table} {\n\tchain forward {\n\t\ttype filter hook forward priority filter; policy drop;\n\t\t${renderRule(dropLogRule(prefix), 'inet')}\n\t}\n}\n`;
    expect(await deploy([{ kind: 'replace', family: 'inet', table, definition }])).toBe('confirmed');
    expect((await enableForwarding({ executor: target.executor, access: target.access }, 'ip', false)).forwarding.ip).toBe(true);
    expect(await fetch('hd-client', 'http://203.0.113.1:8080/')).toBe('no answer');

    let { ruleset, listing } = await read();
    const plan = planPortForward(ruleset, listing, web, { natTable: nat });
    // The table lets nothing back yet: the forward lets replies through too.
    expect(plan.replies).toEqual([{ family: 'inet', table, chain: 'forward' }]);
    expect(await deploy(plan.changes)).toBe('confirmed');
    ({ ruleset, listing } = await read());
    expect(portForwards(ruleset).find((entry) => entry.name === web.name)?.forward).toEqual(web);

    expect(await fetch('hd-client', 'http://203.0.113.1:8080/')).toBe('served by the target');
    // Hairpin: the neighbor reaches the server by the outside address, and the answer comes back the same way.
    expect(await fetch('hd-neighbor', 'http://203.0.113.1:8080/')).toBe('served by the target');
    // The server's own address is no forward: the policy drops it.
    expect(await fetch('hd-client', 'http://198.51.100.2/')).toBe('no answer');

    // syslogd writes a moment later than journald.
    let entries: Awaited<ReturnType<typeof readPacketLog>>['entries'] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      entries = (await readPacketLog(target.access, undefined)).entries;
      if (entries.some((entry) => entry.prefix === prefix) && entries.some((entry) => entry.prefix === `hopdeck forward ${web.name}: `)) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    expect(entries.find((entry) => entry.prefix === prefix)).toMatchObject({ protocol: 'TCP', src: '203.0.113.7', dst: '198.51.100.2', dport: 80, in: 'hdc', out: 'hdlan' });
    expect(entries.find((entry) => entry.prefix === `hopdeck forward ${web.name}: `)).toMatchObject({ protocol: 'TCP', dport: 8080, in: 'hdc' });
  });
});
