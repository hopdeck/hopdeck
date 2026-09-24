import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HostSummary } from '@nftm/core';
import { HostManager } from './hosts/manager.ts';
import { startServer, type RunningServer } from './server.ts';
import { DEBIAN_FACTS, FakeExecutor, ok } from './testing/fake-executor.ts';

type Body = { hosts: HostSummary[]; host: HostSummary; error: { code: string } };
const body = async (response: Response) => (await response.json()) as Body;

describe('hosts API', () => {
  let configDir: string;
  let server: RunningServer;
  let api: (path: string, init?: RequestInit) => Promise<Response>;

  beforeAll(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'nftm-api-'));
    const hosts = await HostManager.open({
      configDir,
      controlDir: configDir,
      createSshExecutor: () => new FakeExecutor((argv) => (argv[0] === 'sh' ? ok(DEBIAN_FACTS) : ok())),
    });
    server = await startServer({ port: 0, token: 't', version: 'test', hosts });
    api = (path, init = {}) =>
      fetch(`http://127.0.0.1:${server.port}/api${path}`, {
        ...init,
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json', ...init.headers },
      });
  });

  afterAll(async () => {
    await server.close();
    await rm(configDir, { recursive: true, force: true });
  });

  it('lists, adds, connects and removes hosts', async () => {
    const list = await api('/hosts');
    expect((await body(list)).hosts.map((host) => host.id)).toEqual(['local']);

    const created = await api('/hosts', { method: 'POST', body: JSON.stringify({ destination: 'admin@fw1' }) });
    expect(created.status).toBe(201);
    const { host } = await body(created);

    const connected = await api(`/hosts/${host.id}/connect`, { method: 'POST' });
    expect((await body(connected)).host.status).toMatchObject({
      state: 'connected',
      facts: { os: { id: 'debian' } },
      privilege: { kind: 'sudo' },
    });

    expect((await api(`/hosts/${host.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api(`/hosts/${host.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('answers errors with a code the UI can translate', async () => {
    const invalid = await api('/hosts', { method: 'POST', body: JSON.stringify({ destination: '-oX' }) });
    expect(invalid.status).toBe(400);
    expect(await body(invalid)).toMatchObject({ error: { code: 'invalid-host' } });

    const missing = await api('/hosts', { method: 'POST', body: '{}' });
    expect(await body(missing)).toMatchObject({ error: { code: 'invalid-body' } });

    const form = await api('/hosts', { method: 'POST', body: 'destination=x', headers: { 'Content-Type': 'text/plain' } });
    expect(form.status).toBe(415);

    expect((await api('/hosts', { method: 'PUT' })).status).toBe(405);
    expect((await api('/hosts/nope/connect', { method: 'POST' })).status).toBe(404);
  });
});
