// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostManager } from './hosts/manager.ts';
import { Sandbox } from './hosts/sandbox.ts';
import { startServer, type RunningServer } from './server.ts';

const USERNS = spawnSync('unshare', ['--user', '--map-root-user', '--net', 'true']).status === 0;

// What goes through to OpenWrt is tested on the OpenWrt test hosts (openwrt/uci-plans.test.ts); here, what the API lets through.
describe.skipIf(!USERNS)('UCI API', { timeout: 30_000 }, () => {
  let configDir: string;
  let sandbox: Sandbox;
  let server: RunningServer;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api${path}`, {
      method,
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as { error: { code: string; message: string } } };
  };
  const plan = (changes: unknown[]) => call('POST', '/hosts/sandbox/uci/firewall/plans', { changes });

  beforeAll(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'hopdeck-uci-api-'));
    sandbox = await Sandbox.start();
    const hosts = await HostManager.open({ configDir, controlDir: configDir, sandbox: { executor: sandbox.executor, directory: sandbox.directory } });
    server = await startServer({ port: 0, token: 't', version: 'test', hosts });
    await call('POST', '/hosts/sandbox/connect');
  });

  afterAll(async () => {
    await server?.close();
    await sandbox?.dispose();
    await rm(configDir, { recursive: true, force: true });
  });

  it('reads and changes only the configurations the panel needs', async () => {
    expect(await call('GET', '/hosts/sandbox/uci/system')).toMatchObject({ status: 400, body: { error: { code: 'invalid-body' } } });
    expect(await call('POST', '/hosts/sandbox/uci/network/plans', { changes: [] })).toMatchObject({ status: 400, body: { error: { code: 'invalid-body' } } });
  });

  it('takes no value UCI cannot hold, and no section or option that is not UCI’s', async () => {
    const refused = [
      { kind: 'set', section: 'cfg01', values: { name: 'two\nlines' } },
      { kind: 'set', section: 'cfg01; rm', values: { name: 'x' } },
      { kind: 'set', section: 'cfg01', values: { 'bad-option': 'x' } },
      { kind: 'unset', section: 'cfg01', options: [] },
      { kind: 'add', type: 'Rule!', values: {} },
      { kind: 'add', type: 'rule', ref: 'mine', values: {} },
      { kind: 'order', sections: ['a', 'b c'] },
      { kind: 'rename', section: 'cfg01' },
    ];
    expect(await call('POST', '/hosts/sandbox/uci/firewall/plans', { changes: [], base: 'not-a-hash' })).toMatchObject({ status: 400 });
    for (const change of refused) {
      expect(await plan([change]), JSON.stringify(change)).toMatchObject({ status: 400, body: { error: { code: 'invalid-body' } } });
    }
  });

  it('says a host that is not OpenWrt has no UCI', async () => {
    expect(await call('GET', '/hosts/sandbox/uci/firewall')).toMatchObject({ status: 409, body: { error: { code: 'platform-read-only' } } });
    const valid = [
      { kind: 'add', type: 'rule', ref: 'new-1', values: { name: 'web', proto: ['tcp', 'udp'] } },
      { kind: 'set', section: 'new-1', values: { dest_port: '80' } },
    ];
    expect(await plan(valid)).toMatchObject({ status: 409, body: { error: { code: 'platform-read-only' } } });
  });

  it('knows no plan it did not make', async () => {
    expect(await call('GET', '/uci-plans/nope')).toMatchObject({ status: 404, body: { error: { code: 'deployment-not-found' } } });
    expect(await call('POST', '/uci-plans/nope/apply')).toMatchObject({ status: 404 });
  });
});
