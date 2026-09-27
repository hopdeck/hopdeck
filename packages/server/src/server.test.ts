// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostManager } from './hosts/manager.ts';
import { startServer, type RunningServer } from './server.ts';

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
    server = await startServer({ port: 0, token: 'test-token', webRoot, version: '0.0.0-test', hosts });
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
