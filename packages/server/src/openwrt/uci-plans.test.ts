// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { openwrtFirewall, previewUci, typeOrder, type UciChange } from '@hopdeck/core';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DeployTarget } from '../firewall/deploy.ts';
import { HostError } from '../hosts/errors.ts';
import { hostTarget, testHost } from '../testing/test-host.ts';
import { configHash, readConfig, ubus, UciPlans } from './uci-plans.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Against an OpenWrt test host: dev/test-host/up.sh openwrt or dev/vm-host/up.sh openwrt, then HOPDECK_TEST_HOST=1.
describe.skipIf(testHost?.platform !== 'openwrt')('UCI plans on the OpenWrt test host', { timeout: 90_000 }, () => {
  let target: DeployTarget;
  const plans = new UciPlans({ seconds: 8 });
  /** Plans a test made, so that one it left waiting for confirmation is undone before the next: only one apply may wait at a time. */
  const made: string[] = [];
  const prepare = async (...args: Parameters<UciPlans['prepare']>) => {
    const plan = await plans.prepare(...args);
    made.push(plan.id);
    return plan;
  };
  const sh = async (script: string) => (await target.executor.exec(['sh', '-c', script])).stdout.trim();
  const rule = (name: string, values: Record<string, string> = {}): UciChange => ({
    kind: 'add',
    type: 'rule',
    values: { name, src: 'wan', proto: 'tcp', dest_port: '2222', target: 'ACCEPT', ...values },
  });
  const inFw4 = async (name: string) => (await sh(`nft list table inet fw4 | grep -c ${JSON.stringify(`!fw4: ${name}`)} || true`)) !== '0';
  const inConfig = async (name: string) => (await sh(`grep -c "'${name}'" /etc/config/firewall || true`)) !== '0';
  /** Removes what a failed run left: test rules, through UCI as everything else, and sessions with test changes staged. */
  const removeTestRules = () =>
    sh(`for s in $(uci show firewall | sed -n "s/^firewall\\.\\([^.]*\\)\\.name='hd-test-.*/\\1/p"); do uci delete firewall.$s; done; uci commit firewall; /sbin/fw4 reload >/dev/null 2>&1
      for d in /var/run/rpcd/uci-*; do grep -q hd-test "$d"/firewall 2>/dev/null && ubus call session destroy "{\\"ubus_rpc_session\\":\\"\${d##*/uci-}\\"}"; done; true`);

  beforeAll(async () => {
    target = await hostTarget('root', await mkdtemp(`${tmpdir()}/hopdeck-uci-`));
    await removeTestRules();
  });

  afterEach(async () => {
    for (const id of made.splice(0)) {
      if (plans.get(id)?.state === 'awaiting-confirmation') await plans.rollback(id, target).catch(() => undefined);
    }
  });

  afterAll(async () => {
    await removeTestRules();
  });

  it('stages a change in its own session, lists it as rpcd will write it, and drops it again', async () => {
    const plan = await prepare(target, 'firewall', [rule('hd-test-staged')]);
    expect(plan).toMatchObject({ state: 'planned', validation: { ok: true }, pendingElsewhere: { cli: false, sessions: 0 } });
    expect(plan.staged[0]).toMatchObject({ kind: 'add', option: 'rule', label: 'rule "hd-test-staged"' });
    expect(plan.staged.find((change) => change.option === 'dest_port')).toMatchObject({ kind: 'set', value: '2222' });
    // Staged in rpcd's session only: neither the file nor uci's own changes have it.
    expect(await inConfig('hd-test-staged')).toBe(false);
    expect(await sh('uci changes firewall')).toBe('');
    await plans.discard(plan.id, target);
    expect(await sh('ls /var/run/rpcd/ | grep -c uci- || true')).toBe('0');
  });

  it('applies, sees fw4 take the change, keeps it when confirmed, and removes it the same way', async () => {
    const plan = await prepare(target, 'firewall', [rule('hd-test-kept')]);
    const applied = await plans.apply(plan.id, target);
    expect(applied.state).toBe('awaiting-confirmation');
    expect(applied.ruleset?.after).toContain('!fw4: hd-test-kept');
    expect(applied.ruleset?.before).not.toContain('hd-test-kept');
    expect(await inFw4('hd-test-kept')).toBe(true);
    expect((await plans.confirm(plan.id, target)).state).toBe('confirmed');
    await sleep(10_000);
    // Past the deadline it stays: rpcd let go of its snapshot.
    expect(await inConfig('hd-test-kept')).toBe(true);
    expect(await inFw4('hd-test-kept')).toBe(true);

    const section = openwrtFirewall(await readConfig(target, 'firewall', undefined)).rules.find((candidate) => candidate.name === 'hd-test-kept')!.section;
    const removal = await prepare(target, 'firewall', [{ kind: 'delete', section: section.name }]);
    expect(removal.staged).toEqual([expect.objectContaining({ kind: 'remove', label: 'rule "hd-test-kept"' })]);
    await plans.apply(removal.id, target);
    await plans.confirm(removal.id, target);
    expect(await inConfig('hd-test-kept')).toBe(false);
    expect(await inFw4('hd-test-kept')).toBe(false);
  });

  it('names a new section by its ref until rpcd does, and puts it first among the rules', async () => {
    const config = await readConfig(target, 'firewall', undefined);
    const add: UciChange = { kind: 'add', type: 'rule', ref: 'new-1', values: { name: 'hd-test-first', src: 'wan', proto: 'tcp', dest_port: '2225', target: 'DROP' } };
    const set: UciChange = { kind: 'set', section: 'new-1', values: { target: 'REJECT' } };
    const preview = previewUci(config, [add, set]);
    const rules = preview.sections.filter((section) => section.type === 'rule').map((section) => section.name);
    const order = typeOrder(preview, 'rule', ['new-1', ...rules.filter((name) => name !== 'new-1')]);
    const plan = await prepare(target, 'firewall', [add, set, order]);
    expect(plan.validation).toEqual({ ok: true, message: '' });
    await plans.apply(plan.id, target);
    await plans.confirm(plan.id, target);
    const after = openwrtFirewall(await readConfig(target, 'firewall', undefined));
    expect(after.rules[0]).toMatchObject({ name: 'hd-test-first', target: 'REJECT' });
    // Defaults, zones and the forwarding stay where they were in the file.
    expect((await readConfig(target, 'firewall', undefined)).sections.slice(0, 4).map((section) => section.type)).toEqual(['defaults', 'zone', 'zone', 'forwarding']);
    // fw4 follows UCI's order: the rule comes before the others from wan.
    const input = await sh("nft list chain inet fw4 input_wan | grep -o '!fw4: [A-Za-z-]*' | head -n 1");
    expect(input).toBe('!fw4: hd-test-first');
  });

  it('is rolled back by rpcd when nobody confirms in time', async () => {
    const before = await sh('sha256sum /etc/config/firewall');
    const plan = await prepare(target, 'firewall', [rule('hd-test-unconfirmed')]);
    await plans.apply(plan.id, target);
    expect(await inFw4('hd-test-unconfirmed')).toBe(true);
    await sleep(8000 + 4000);
    expect(await plans.refresh(plan.id, target)).toMatchObject({ state: 'rolled-back', outcome: { reason: 'timeout' } });
    expect(await sh('sha256sum /etc/config/firewall')).toBe(before);
    expect(await inFw4('hd-test-unconfirmed')).toBe(false);
  });

  it('rolls back at once when asked', async () => {
    const plan = await prepare(target, 'firewall', [rule('hd-test-undone')]);
    await plans.apply(plan.id, target);
    expect(await plans.rollback(plan.id, target)).toMatchObject({ state: 'rolled-back', outcome: { reason: 'user' } });
    expect(await inConfig('hd-test-undone')).toBe(false);
    expect(await inFw4('hd-test-undone')).toBe(false);
  });

  // In a container, SSH comes in through podman's port forward, which fw4's zones do not see.
  it.runIf(testHost?.vmid !== undefined)('undoes at once a change that blocks new SSH connections', async () => {
    // hopdeck comes in through the zone the VM's network is in; the connection it has stays, as fw4 lets established ones through first.
    const zone = (await sh(`uci show firewall | grep -q "network='lan'" && echo lan || echo wan`)) || 'lan';
    const plan = await prepare(target, 'firewall', [rule('hd-test-lockout', { src: zone, dest_port: '22', target: 'REJECT' })]);
    expect(await plans.apply(plan.id, target)).toMatchObject({ state: 'rolled-back', outcome: { reason: 'fresh-connection-failed' } });
    expect(await inConfig('hd-test-lockout')).toBe(false);
    expect(await inFw4('hd-test-lockout')).toBe(false);
    await expect(target.freshExecutor!.exec(['true'])).resolves.toMatchObject({ exitCode: 0 });
  });

  it('rolls back at once a change fw4 cannot load, with what nft said', async () => {
    await sh('printf "this is not nftables\\n" > /tmp/hd-test-broken.nft');
    try {
      const plan = await prepare(target, 'firewall', [
        { kind: 'add', type: 'include', values: { type: 'nftables', path: '/tmp/hd-test-broken.nft', position: 'table-post' } },
      ]);
      const applied = await plans.apply(plan.id, target);
      expect(applied).toMatchObject({ state: 'rolled-back', outcome: { reason: 'reload-failed', detail: expect.stringMatching(/syntax error|Error/) } });
      expect(await sh("grep -c hd-test-broken /etc/config/firewall || true")).toBe('0');
      expect(await sh('nft list tables')).toContain('inet fw4');
    } finally {
      await sh('rm -f /tmp/hd-test-broken.nft');
    }
  });

  it('refuses changes made on a configuration that changed since, as names of anonymous sections may now mean others', async () => {
    const hash = await configHash(target, 'firewall');
    await expect(prepare(target, 'firewall', [rule('hd-test-old')], { base: '0'.repeat(64) })).rejects.toMatchObject({ code: 'ruleset-changed' });
    const plan = await prepare(target, 'firewall', [rule('hd-test-old')], { base: hash });
    expect(plan.state).toBe('planned');
    await plans.discard(plan.id, target);
  });

  it('says what rpcd refused, and stages nothing', async () => {
    const plan = await prepare(target, 'firewall', [{ kind: 'set', section: 'hd_test_no_such_section', values: { name: 'x' } }]);
    expect(plan).toMatchObject({ state: 'invalid', validation: { ok: false, message: expect.stringContaining('ubus call uci set') } });
    await plans.discard(plan.id, target);
  });

  it('tells of changes not committed elsewhere, and waits for another apply to be settled', async () => {
    await sh('uci set firewall.@defaults[0].hd_test_pending=1');
    // Another apply waiting for its confirmation, as one from LuCI would.
    const { ubus_rpc_session: session } = (await ubus(target, 'session', 'create', { timeout: 60 })) as { ubus_rpc_session: string };
    try {
      await ubus(target, 'session', 'grant', { ubus_rpc_session: session, scope: 'uci', objects: [['firewall', 'read'], ['firewall', 'write']] });
      await ubus(target, 'uci', 'add', { ubus_rpc_session: session, config: 'firewall', type: 'rule', values: { name: 'hd-test-luci', src: 'wan', target: 'DROP', proto: 'tcp', dest_port: '2224' } });
      await ubus(target, 'uci', 'apply', { ubus_rpc_session: session, rollback: true, timeout: 30 });
      const plan = await prepare(target, 'firewall', [rule('hd-test-other')]);
      expect(plan.pendingElsewhere.cli).toBe(true);
      await expect(plans.apply(plan.id, target)).rejects.toMatchObject({ code: 'uci-apply-pending' } satisfies Partial<HostError>);
      await ubus(target, 'uci', 'rollback', { ubus_rpc_session: session });
      // Settled, the configuration is what it was before that change, not what the plan was made on: it is made again.
      await expect(plans.apply(plan.id, target)).rejects.toMatchObject({ code: 'ruleset-changed' } satisfies Partial<HostError>);
      await plans.discard(plan.id, target);
      const again = await prepare(target, 'firewall', [rule('hd-test-other')]);
      expect((await plans.apply(again.id, target)).state).toBe('awaiting-confirmation');
      await plans.rollback(again.id, target);
    } finally {
      await ubus(target, 'uci', 'rollback', { ubus_rpc_session: session }).catch(() => undefined);
      await ubus(target, 'session', 'destroy', { ubus_rpc_session: session }).catch(() => undefined);
      await sh('uci revert firewall');
    }
  });
});
