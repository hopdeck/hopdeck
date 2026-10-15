// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { DeploymentView, HistoryState, HistoryVersionDetail, HostSummary } from '@hopdeck/core';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostManager } from './hosts/manager.ts';
import { Sandbox } from './hosts/sandbox.ts';
import { startServer, type RunningServer } from './server.ts';

const USERNS = spawnSync('unshare', ['--user', '--map-root-user', '--net', 'true']).status === 0;

type Body = {
  host: HostSummary;
  deployment: DeploymentView;
  history: HistoryState;
  version: HistoryVersionDetail;
  error: { code: string; message: string };
};

describe.skipIf(!USERNS)('deployments API', { timeout: 30_000 }, () => {
  let configDir: string;
  let sandbox: Sandbox;
  let server: RunningServer;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api${path}`, {
      method,
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Body };
  };

  beforeAll(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'hopdeck-deploy-api-'));
    sandbox = await Sandbox.start();
    await sandbox.load('table inet mine {\n\tchain input {\n\t\ttype filter hook input priority filter; policy accept;\n\t}\n}\n');
    const hosts = await HostManager.open({ configDir, controlDir: configDir, sandbox: { executor: sandbox.executor, directory: sandbox.directory }, rollbackSeconds: 3 });
    server = await startServer({ port: 0, token: 't', version: 'test', hosts });
    await call('POST', '/hosts/sandbox/connect');
  });

  afterAll(async () => {
    // Whatever beforeAll got to start, even if it failed halfway.
    await server?.close();
    await sandbox?.dispose();
    await rm(configDir, { recursive: true, force: true });
  });

  it('adopts a table: plan, apply, confirm, with a change log', async () => {
    const planned = await call('POST', '/hosts/sandbox/deployments', { changes: [{ kind: 'adopt', family: 'inet', table: 'mine' }] });
    expect(planned.status).toBe(201);
    const { id } = planned.body.deployment;
    expect(planned.body.deployment).toMatchObject({ state: 'planned', safety: { watchdog: 'detached', seconds: 3 } });

    expect((await call('POST', `/deployments/${id}/apply`)).body.deployment.state).toBe('awaiting-confirmation');
    expect((await call('POST', `/deployments/${id}/confirm`)).body.deployment.state).toBe('confirmed');

    const log = (await readFile(join(configDir, 'changes.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(log.map((entry) => entry.event)).toEqual(['applied', 'confirmed']);
    expect(log[0]).toMatchObject({ host: 'sandbox', tables: ['adopt inet mine'], manualOverride: false });
  });

  it('records the kept change in the host\'s history, and a restore names the version it puts back', async () => {
    const { body } = await call('GET', '/hosts/sandbox/history');
    // Nothing was managed before the adoption, so the adoption is the first version.
    expect(body.history.versions.map((version) => [version.id, version.kind])).toEqual([[1, 'change']]);
    expect(body.history.versions[0]).toMatchObject({ changes: [{ family: 'inet', name: 'mine', action: 'adopt' }], author: { login: expect.any(String) } });
    const detail = await call('GET', '/hosts/sandbox/history/1');
    expect(detail.body.version.tables[0]?.text).toContain('comment "managed by hopdeck"');
    expect((await call('GET', '/hosts/sandbox/history/7')).status).toBe(404);

    const definition = detail.body.version.tables[0]!.text.replace('policy accept;', 'policy accept;\n\t\ttcp dport 22 accept');
    const planned = await call('POST', '/hosts/sandbox/deployments', { changes: [{ kind: 'replace', family: 'inet', table: 'mine', definition }], restoredFrom: 1 });
    expect(planned.body.deployment.restoredFrom).toBe(1);
    await call('POST', `/deployments/${planned.body.deployment.id}/apply`);
    const kept = await call('POST', `/deployments/${planned.body.deployment.id}/confirm`);
    expect(kept.body.deployment.recorded).toEqual({ version: 2 });
    expect((await call('GET', '/hosts/sandbox/history')).body.history.versions[0]).toMatchObject({ id: 2, restoredFrom: 1 });
  });

  it('saves settings on the host, within limits', async () => {
    const saved = await call('POST', '/hosts/sandbox/settings', { history: { maxBytes: 3 * 1024 * 1024 } });
    expect(saved.body.history.settings.history.maxBytes).toBe(3 * 1024 * 1024);
    expect((await call('POST', '/hosts/sandbox/settings', { history: { maxBytes: 12 } })).status).toBe(400);
  });

  it('needs Manual override for tables hopdeck does not manage', async () => {
    await call('POST', '/hosts/sandbox/deployments', { changes: [] }).then((r) => expect(r.status).toBe(400));
    const other = { kind: 'replace', family: 'inet', table: 'other', definition: 'table inet other {\n}\n' };
    // Creating a table is fine: hopdeck manages what it creates.
    expect((await call('POST', '/hosts/sandbox/deployments', { changes: [other] })).body.deployment.tables[0]?.action).toBe('create');

    await sandbox.executor.exec(['/usr/sbin/nft', 'add', 'table', 'inet', 'foreign']);
    const foreign = { kind: 'delete', family: 'inet', table: 'foreign' };
    const refused = await call('POST', '/hosts/sandbox/deployments', { changes: [foreign] });
    expect(refused).toMatchObject({ status: 403, body: { error: { code: 'table-not-editable' } } });

    expect((await call('POST', '/hosts/sandbox/manual-override', { enabled: true })).body.host.manualOverride).toBe(true);
    const allowed = await call('POST', '/hosts/sandbox/deployments', { changes: [foreign] });
    expect(allowed.body.deployment).toMatchObject({ state: 'planned', manualOverride: true });
    await call('POST', `/deployments/${allowed.body.deployment.id}/discard`);
  });
});
