import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { handleApi } from './api.ts';
import type { HostManager } from './hosts/manager.ts';
import { ApiError, sendError } from './http.ts';
import { checkAccess, createAccessPolicy, SECURITY_HEADERS, type AccessPolicy } from './security.ts';

export interface ServerOptions {
  /** 0 picks a free port. */
  port: number;
  token: string;
  /** Extra accepted Origins, e.g. the Vite dev server. */
  extraOrigins?: readonly string[];
  /** Directory with the built web UI; without it only the API is served (dev mode). */
  webRoot?: string;
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

  if (options.webRoot !== undefined && (req.method === 'GET' || req.method === 'HEAD')) {
    return serveStatic(res, path, options.webRoot);
  }
  sendError(res, new ApiError(404, 'not-found'));
}

/** Serves a file of the built UI, falling back to index.html for client-side routes. */
async function serveStatic(res: ServerResponse, path: string, webRoot: string) {
  const root = resolve(webRoot);
  let file: string;
  try {
    file = resolve(root, `.${decodeURIComponent(path)}`);
  } catch {
    return sendError(res, new ApiError(400, 'malformed-path'));
  }
  if (file !== root && !file.startsWith(root + sep)) return sendError(res, new ApiError(404, 'not-found'));

  let target = file;
  if (!(await isFile(target))) {
    target = join(root, 'index.html');
    if (extname(file) !== '' || !(await isFile(target))) return sendError(res, new ApiError(404, 'not-found'));
  }

  const body = await readFile(target);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (stats) => stats.isFile(),
    () => false,
  );
}
