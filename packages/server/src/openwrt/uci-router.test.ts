// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { openwrtFirewall } from '@hopdeck/core';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeployTarget } from '../firewall/deploy.ts';
import { SshExecutor } from '../hosts/ssh.ts';
import { hostTarget, testHost } from '../testing/test-host.ts';
import { dhcpHosts, readConfig, UciPlans } from './uci-plans.ts';

const STOP_SERVER = 'start-stop-daemon --stop --quiet --pidfile /tmp/hd-www.pid --remove-pidfile 2>/dev/null; true';

// Against the router of dev/vm-host/router.sh, with a client behind it: what goes through the router.
describe.skipIf(testHost?.client === undefined)('a port forward through the test router to the client behind it', { timeout: 120_000 }, () => {
  let router: DeployTarget;
  let client: SshExecutor;
  const plans = new UciPlans({ seconds: 20 });
  const wan = testHost?.address ?? '';
  const sh = async (executor: { exec(argv: string[]): Promise<{ stdout: string; stderr: string }> }, script: string) => {
    const result = await executor.exec(['sh', '-c', script]);
    return `${result.stdout}${result.stderr}`.trim();
  };
  const removeForward = async () => {
    const config = await readConfig(router, 'firewall', undefined);
    const forward = openwrtFirewall(config).redirects.find((redirect) => redirect.name === 'hd-router-web');
    if (forward === undefined) return;
    const plan = await plans.prepare(router, 'firewall', [{ kind: 'delete', section: forward.section.name }]);
    await plans.apply(plan.id, router);
    await plans.confirm(plan.id, router);
  };

  beforeAll(async () => {
    const dir = await mkdtemp(`${tmpdir()}/hopdeck-router-`);
    router = await hostTarget('root', dir);
    client = new SshExecutor({ destination: 'hopdeck-test-client', controlDir: dir, configFile: testHost!.sshConfig });
    await removeForward();
    // By a pid file: a pattern for pkill would match the shell that runs it too.
    await sh(client, `${STOP_SERVER}; mkdir -p /tmp/hd-www && echo "served behind the router" > /tmp/hd-www/index.html; start-stop-daemon --start --background --make-pidfile --pidfile /tmp/hd-www.pid --exec /usr/bin/python3 -- -m http.server 80 --directory /tmp/hd-www; sleep 1`);
  });

  afterAll(async () => {
    await removeForward().catch(() => undefined);
    await sh(client, `${STOP_SERVER}; rm -rf /tmp/hd-www`).catch(() => undefined);
  });

  it('knows the client by its lease', async () => {
    expect(await dhcpHosts(router)).toContainEqual(expect.objectContaining({ ip: testHost!.client!.address, static: false }));
  });

  it('forwards from the WAN to the client, and back to it from inside by the WAN address', async () => {
    const before = await fetch(`http://${wan}:8080/`, { signal: AbortSignal.timeout(3000) }).then(
      () => 'answered',
      () => 'no answer',
    );
    expect(before).toBe('no answer');

    const plan = await plans.prepare(router, 'firewall', [
      {
        kind: 'add',
        type: 'redirect',
        ref: 'new-1',
        values: { name: 'hd-router-web', target: 'DNAT', src: 'wan', src_dport: '8080', dest: 'lan', dest_ip: testHost!.client!.address, dest_port: '80', proto: ['tcp'] },
      },
    ]);
    expect((await plans.apply(plan.id, router)).state).toBe('awaiting-confirmation');
    expect((await plans.confirm(plan.id, router)).state).toBe('confirmed');

    // From this machine, on the router's WAN side.
    const answer = await fetch(`http://${wan}:8080/`, { signal: AbortSignal.timeout(5000) }).then((response) => response.text());
    expect(answer.trim()).toBe('served behind the router');
    // NAT loopback: the client reaches itself by the router's outside address.
    expect(await sh(client, `python3 -c "import urllib.request; print(urllib.request.urlopen('http://${wan}:8080/', timeout=5).read().decode().strip())"`)).toBe('served behind the router');
  });
});
