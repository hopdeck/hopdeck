import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
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
      else sendJson(res, 500, { error: 'internal error' });
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
  if (!access.ok) return sendJson(res, access.status, { error: access.reason });

  if (isApi) {
    if (req.method === 'GET' && path === '/api/health') {
      return sendJson(res, 200, { ok: true, version: options.version });
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  if (options.webRoot !== undefined && (req.method === 'GET' || req.method === 'HEAD')) {
    return serveStatic(res, path, options.webRoot);
  }
  sendJson(res, 404, { error: 'not found' });
}

/** Serves a file of the built UI, falling back to index.html for client-side routes. */
async function serveStatic(res: ServerResponse, path: string, webRoot: string) {
  const root = resolve(webRoot);
  let file: string;
  try {
    file = resolve(root, `.${decodeURIComponent(path)}`);
  } catch {
    return sendJson(res, 400, { error: 'malformed path' });
  }
  if (file !== root && !file.startsWith(root + sep)) return sendJson(res, 404, { error: 'not found' });

  let target = file;
  if (!(await isFile(target))) {
    target = join(root, 'index.html');
    if (extname(file) !== '' || !(await isFile(target))) return sendJson(res, 404, { error: 'not found' });
  }

  const body = await readFile(target);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (stats) => stats.isFile(),
    () => false,
  );
}
