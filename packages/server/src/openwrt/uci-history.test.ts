// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { uciRestoreChanges, type UciConfig } from '@hopdeck/core';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostTarget, testHost } from '../testing/test-host.ts';
import { UciHistory, type UciHistoryTarget } from './uci-history.ts';
import { configHash, readConfig, UciPlans } from './uci-plans.ts';

/** A configuration as its content: names UCI made up for anonymous sections left out. */
const content = (config: UciConfig) => config.sections.map((section) => ({ type: section.type, name: section.anonymous ? null : section.name, options: section.options }));

// Against an OpenWrt test host: dev/test-host/up.sh openwrt or dev/vm-host/up.sh openwrt, then HOPDECK_TEST_HOST=1.
describe.skipIf(testHost?.platform !== 'openwrt')('the UCI history on the OpenWrt test host', { timeout: 120_000 }, () => {
  let target: UciHistoryTarget;
  const history = new UciHistory({ operator: { user: 'ada', computer: 'desk' } });
  const plans = new UciPlans({
    seconds: 15,
    beforeChange: (deploy) => history.beforeChange({ ...deploy, login: target.login }),
    record: (view) => history.record(target, view),
  });
  const sh = async (script: string) => (await target.executor.exec(['sh', '-c', script])).stdout.trim();
  const clean = () =>
    sh(`for s in $(uci show firewall | sed -n "s/^firewall\\.\\([^.]*\\)\\.name='hd-hist-.*/\\1/p"); do uci delete firewall.$s; done; uci -q delete firewall.hopdeck_hdhist; uci commit firewall; rm -f /etc/hopdeck/fw4/hdhist.*; /sbin/fw4 reload >/dev/null 2>&1; true`);

  beforeAll(async () => {
    const deploy = await hostTarget('root', await mkdtemp(`${tmpdir()}/hopdeck-uci-history-`));
    target = { ...deploy, login: deploy.facts.user };
    await clean();
    // A history of this test's own.
    await sh('rm -rf /etc/hopdeck/state/firewall/uci-history');
  });

  afterAll(async () => {
    await clean();
  });

  it('keeps the configuration before the first change, the change with who made it, and what changed elsewhere', async () => {
    const baseline = await readConfig(target, 'firewall', undefined);
    const plan = await plans.prepare(
      target,
      'firewall',
      [
        { kind: 'add', type: 'rule', ref: 'new-1', values: { name: 'hd-hist-ssh', src: 'wan', proto: 'tcp', dest_port: '2299', target: 'ACCEPT' } },
        { kind: 'add', type: 'include', name: 'hopdeck_hdhist', values: { type: 'nftables', path: '/etc/hopdeck/fw4/hdhist.1.nft', position: 'table-post' } },
      ],
      { files: [{ path: '/etc/hopdeck/fw4/hdhist.1.nft', content: 'set hdhist { type ipv4_addr; }\n' }] },
    );
    await plans.apply(plan.id, target);
    const kept = await plans.confirm(plan.id, target);
    expect(kept.recorded).toEqual({ version: 2 });

    let state = await history.state(target);
    expect(state.directory).toBe('/etc/hopdeck/state/firewall/uci-history');
    expect(state.versions.map((version) => version.kind)).toEqual(['change', 'baseline']);
    const change = state.versions[0]!;
    expect(change).toMatchObject({ plan: plan.id, author: { user: 'ada', computer: 'desk', login: 'root' } });
    expect(change.includes).toContain('/etc/hopdeck/fw4/hdhist.1.nft');
    expect(change.changes.some((staged) => staged.label === 'rule "hd-hist-ssh"')).toBe(true);
    // Who came in, as dropbear logged it; a container's SSH comes through podman, whose log line there is too.
    expect(change.author.connection).toMatchObject({ method: 'publickey', key: expect.stringMatching(/^ED25519 SHA256:/) });

    // Changed with the uci command: noticed when the panel reads the configuration.
    await sh("uci set firewall.@defaults[0].hd_hist_outside=1; uci commit firewall");
    await history.observe(target, await configHash(target, 'firewall'));
    state = await history.state(target);
    expect(state.versions.map((version) => version.kind)).toEqual(['outside', 'change', 'baseline']);
    await sh('uci delete firewall.@defaults[0].hd_hist_outside; uci commit firewall');

    const detail = (await history.version(target, 2))!;
    expect(detail.text).toContain('hd-hist-ssh');
    expect(detail.includes).toContainEqual({ path: '/etc/hopdeck/fw4/hdhist.1.nft', content: 'set hdhist { type ipv4_addr; }\n' });
    expect(content(detail.config)).toEqual(content(await readConfig(target, 'firewall', undefined)));

    // Putting the baseline back is an ordinary change, recorded as such.
    const first = (await history.version(target, 1))!;
    expect(content(first.config)).toEqual(content(baseline));
    const now = await readConfig(target, 'firewall', undefined);
    const restore = await plans.prepare(target, 'firewall', uciRestoreChanges(now, first.config), { restoredFrom: 1 });
    expect(restore.state).toBe('planned');
    await plans.apply(restore.id, target);
    expect((await plans.confirm(restore.id, target)).recorded?.version).toBeGreaterThan(2);
    expect(content(await readConfig(target, 'firewall', undefined))).toEqual(content(baseline));
    expect((await history.state(target)).versions[0]).toMatchObject({ kind: 'change', restoredFrom: 1 });
    expect(await sh('ls /etc/hopdeck/fw4/ | grep -c hdhist || true')).toBe('0');
  });

  it('says there is no such version', async () => {
    expect(await history.version(target, 999_999)).toBeUndefined();
  });
});
