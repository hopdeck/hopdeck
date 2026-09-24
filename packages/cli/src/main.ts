#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { generateToken, startServer } from '@nftm/server';
import pkg from '../package.json' with { type: 'json' };

const HELP = `Usage: nftm [options]

Starts the nftm panel on 127.0.0.1 and prints its URL.

Options:
  -p, --port <port>  port to listen on (default: 7400)
      --dev          serve the API only; the UI comes from the Vite dev server
  -h, --help         show this help
`;

const DEV_UI_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];

const { values } = parseArgs({
  options: {
    port: { type: 'string', short: 'p', default: '7400' },
    dev: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`nftm: invalid port: ${values.port}\n`);
  process.exit(2);
}

// `pnpm dev` sets NFTM_TOKEN so the browser session survives --watch restarts.
const token = process.env['NFTM_TOKEN'] || generateToken();

const server = await startServer({
  port,
  token,
  extraOrigins: values.dev ? DEV_UI_ORIGINS : [],
  webRoot: values.dev ? undefined : fileURLToPath(new URL('../../web/dist/', import.meta.url)),
  version: pkg.version,
});

// The token goes in the fragment, which browsers never send to the server.
const uiOrigin = values.dev ? DEV_UI_ORIGINS[0] : `http://127.0.0.1:${server.port}`;
process.stdout.write(`nftm ${pkg.version} is running at:\n\n  ${uiOrigin}/#token=${token}\n\n`);
