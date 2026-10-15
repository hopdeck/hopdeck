// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

/**
 * pnpm dev: the API (with --watch) and the Vite dev server, each on the first
 * free port from 7400 and 5173, and each told the other's. A panel already
 * running, say the released one on 7400, no longer stops it from starting.
 * HOPDECK_PORT and HOPDECK_UI_PORT, when set, are used as they are.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

async function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function freePort(from: number): Promise<number> {
  for (let port = from; port < from + 20; port += 1) {
    if (await isFree(port)) return port;
    process.stdout.write(`Port ${port} is taken.\n`);
  }
  throw new Error(`ports ${from} to ${from + 19} are all taken`);
}

const api = process.env['HOPDECK_PORT'] ?? String(await freePort(7400));
const ui = process.env['HOPDECK_UI_PORT'] ?? String(await freePort(5173));
const child = spawn('pnpm', ['-r', '--parallel', 'dev'], {
  stdio: 'inherit',
  // The same token across --watch restarts keeps the browser's session.
  env: { ...process.env, HOPDECK_TOKEN: process.env['HOPDECK_TOKEN'] || randomUUID(), HOPDECK_PORT: api, HOPDECK_UI_PORT: ui },
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal === null ? 0 : 1)));
