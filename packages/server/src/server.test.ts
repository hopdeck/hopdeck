// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostManager } from './hosts/manager.ts';
import { PortsTakenError, startServer, startServerOnFreePort, whoListens, type RunningServer } from './server.ts';
import { webFilesIn } from './web-files.ts';

describe('startServer', () => {
  let webRoot: string;
  let server: RunningServer;
  let base: string;
  const auth = { Authorization: 'Bearer test-token' };

  beforeAll(async () => {
    webRoot = await mkdtemp(join(tmpdir(), 'hopdeck-web-'));
    await mkdir(join(webRoot, 'assets'));
    await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>hopdeck</title>');
    await writeFile(join(webRoot, 'assets', 'app.js'), 'console.log(1)');
    const hosts = await HostManager.open({ configDir: join(webRoot, 'config'), controlDir: webRoot });
    server = await startServer({ port: 0, token: 'test-token', web: webFilesIn(webRoot), version: '0.0.0-test', hosts });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
    await rm(webRoot, { recursive: true, force: true });
  });

  it('serves the API only with the token', async () => {
    const ok = await fetch(`${base}/api/health`, { headers: auth });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, version: '0.0.0-test' });
    expect(ok.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");

    expect((await fetch(`${base}/api/health`)).status).toBe(401);
    expect((await fetch(`${base}/api/nope`, { headers: auth })).status).toBe(404);
  });

  it('serves the UI and falls back to index.html for routes', async () => {
    const script = await fetch(`${base}/assets/app.js`);
    expect(script.headers.get('content-type')).toContain('text/javascript');
    expect(await script.text()).toBe('console.log(1)');

    for (const path of ['/', '/hosts/fw1']) {
      const page = await fetch(`${base}${path}`);
      expect(page.headers.get('content-type')).toContain('text/html');
    }
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
  });

  it('does not serve files outside the web root', async () => {
    expect((await fetch(`${base}/..%2f..%2f..%2fetc%2fpasswd`)).status).toBe(404);
    expect((await fetch(`${base}/%E0%A4%A`)).status).toBe(400);
  });
});

describe('startServerOnFreePort', () => {
  let dir: string;
  let hosts: HostManager;
  const opened: { close(): Promise<void> | void }[] = [];

  /** A port some other program listens on. */
  async function otherProgram(): Promise<number> {
    const other: Server = createServer((_req, res) => res.end('not hopdeck'));
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    opened.push({ close: () => new Promise<void>((resolve) => other.close(() => resolve())) });
    return (other.address() as AddressInfo).port;
  }

  /** A port free a moment ago. */
  async function freePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hopdeck-ports-'));
    hosts = await HostManager.open({ configDir: join(dir, 'config'), controlDir: dir });
  });

  afterAll(async () => {
    for (const server of opened) await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const options = () => ({ token: 'test-token', version: '0.0.0-test', hosts });

  it('takes the first free port, and says what held the ones before it', async () => {
    const byOther = await otherProgram();
    const first = await startServerOnFreePort(options(), [0]);
    opened.push(first.server);
    const free = await freePort();

    const started = await startServerOnFreePort(options(), [byOther, first.server.port, free]);
    opened.push(started.server);
    expect(started.server.port).toBe(free);
    expect(started.taken).toEqual([
      { port: byOther, by: 'other' },
      { port: first.server.port, by: 'hopdeck' },
    ]);
  });

  it('fails with the ports and their holders when all are taken', async () => {
    const byOther = await otherProgram();
    await expect(startServerOnFreePort(options(), [byOther])).rejects.toThrow(PortsTakenError);
    await expect(startServerOnFreePort(options(), [byOther])).rejects.toMatchObject({ taken: [{ port: byOther, by: 'other' }] });
    expect(await whoListens(await freePort())).toBe('other');
  });
});
