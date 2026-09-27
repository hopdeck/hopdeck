// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname } from 'node:path';
import { handleApi } from './api.ts';
import type { HostManager } from './hosts/manager.ts';
import { ApiError, sendError } from './http.ts';
import { checkAccess, createAccessPolicy, SECURITY_HEADERS, type AccessPolicy } from './security.ts';
import type { WebFiles } from './web-files.ts';

export interface ServerOptions {
  /** 0 picks a free port. */
  port: number;
  token: string;
  /** Extra accepted Origins, e.g. the Vite dev server. */
  extraOrigins?: readonly string[];
  /** The built web UI; without it only the API is served (dev mode). */
  web?: WebFiles;
  version: string;
  hosts: HostManager;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Starts the panel backend. It listens on 127.0.0.1 only, never on other interfaces. */
/** A port that was taken, and whether another hopdeck holds it. */
export interface TakenPort {
  port: number;
  by: 'hopdeck' | 'other';
}

/** Thrown when every port asked for is taken. */
export class PortsTakenError extends Error {
  override name = 'PortsTakenError';
  readonly taken: readonly TakenPort[];

  constructor(taken: readonly TakenPort[]) {
    super(`every port is taken: ${taken.map(({ port, by }) => `${port} (${by === 'hopdeck' ? 'another hopdeck' : 'another program'})`).join(', ')}`);
    this.taken = taken;
  }
}

/**
 * Serves on the first of `ports` that is free, and says which ones before it
 * were taken, and by what.
 */
export async function startServerOnFreePort(
  options: Omit<ServerOptions, 'port'>,
  ports: readonly number[],
): Promise<{ server: RunningServer; taken: TakenPort[] }> {
  const taken: TakenPort[] = [];
  for (const port of ports) {
    try {
      return { server: await startServer({ ...options, port }), taken };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      taken.push({ port, by: await whoListens(port) });
    }
  }
  throw new PortsTakenError(taken);
}

/** Whether what listens on a local port is hopdeck: it answers with hopdeck's own security headers. */
export async function whoListens(port: number): Promise<TakenPort['by']> {
  try {
    const answer = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    await answer.body?.cancel();
    return answer.headers.get('content-security-policy') === SECURITY_HEADERS['Content-Security-Policy'] ? 'hopdeck' : 'other';
  } catch {
    return 'other';
  }
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  let policy: AccessPolicy | undefined;
  const server = createServer((req, res) => {
    handle(req, res, policy!, options).catch((error: unknown) => {
      console.error(error);
      if (res.headersSent) res.destroy();
      else sendError(res, new ApiError(500, 'internal-error', error instanceof Error ? error.message : String(error)));
    });
  });

  let port = 0;
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      policy = createAccessPolicy(options.token, port, options.extraOrigins);
      resolveListen();
    });
  });

  return {
    port,
    close: () =>
      new Promise((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, policy: AccessPolicy, options: ServerOptions) {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  const isApi = path === '/api' || path.startsWith('/api/');
  const access = checkAccess(req.headers, policy, isApi);
  if (!access.ok) {
    return sendError(res, new ApiError(access.status, access.status === 401 ? 'unauthorized' : 'forbidden', access.reason));
  }

  if (isApi) return handleApi(req, res, path, { hosts: options.hosts, version: options.version });

  if (options.web !== undefined && (req.method === 'GET' || req.method === 'HEAD')) {
    return serveStatic(res, path, options.web);
  }
  sendError(res, new ApiError(404, 'not-found'));
}

/** Serves a file of the built UI, falling back to index.html for client-side routes. */
async function serveStatic(res: ServerResponse, path: string, web: WebFiles) {
  let segments: string[];
  try {
    segments = decodeURIComponent(path).split('/').filter((segment) => segment !== '' && segment !== '.');
  } catch {
    return sendError(res, new ApiError(400, 'malformed-path'));
  }
  // The UI has no use for "..": such a path is someone looking around.
  if (segments.some((segment) => segment === '..' || segment.includes('\\') || segment.includes('\0'))) {
    return sendError(res, new ApiError(404, 'not-found'));
  }
  const relative = segments.join('/');

  let target = relative === '' ? 'index.html' : relative;
  let body = await web.read(target);
  if (body === undefined && extname(target) === '') {
    target = 'index.html';
    body = await web.read(target);
  }
  if (body === undefined) return sendError(res, new ApiError(404, 'not-found'));

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}
