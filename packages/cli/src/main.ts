#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { demoRuleset, ensureControlDir, generateToken, HostManager, Sandbox, startServer } from '@hopdeck/server';
import pkg from '../package.json' with { type: 'json' };

const HELP = `Usage: hopdeck [options]

Starts the hopdeck panel on 127.0.0.1 and prints its URL.

Options:
  -p, --port <port>  port to listen on (default: 7400)
      --sandbox      add a sandbox host: a private network namespace with a
                     demo firewall, needs no root and never touches the real one
      --dev          serve the API only; the UI comes from the Vite dev server
  -h, --help         show this help

Environment:
  HOPDECK_CONFIG_DIR    where hosts.json is kept (default: ~/.config/hopdeck)
  HOPDECK_SSH_CONFIG    an ssh config file to use instead of ~/.ssh/config
`;

const DEV_UI_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];

const { values } = parseArgs({
  options: {
    port: { type: 'string', short: 'p', default: '7400' },
    sandbox: { type: 'boolean', default: false },
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
  fail(`invalid port: ${values.port}`);
}

const configDir =
  process.env['HOPDECK_CONFIG_DIR'] || join(process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'hopdeck');

let sandbox: Sandbox | undefined;
if (values.sandbox) {
  try {
    sandbox = await Sandbox.start();
    await sandbox.load(await demoRuleset());
  } catch (error) {
    fail(`cannot start the sandbox: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const sshConfig = process.env['HOPDECK_SSH_CONFIG'];

const hosts = await HostManager.open({
  configDir,
  controlDir: await ensureControlDir(),
  sshConfigFile: sshConfig ? resolve(sshConfig) : undefined,
  ...(sandbox && { sandbox: sandbox.executor }),
});

// `pnpm dev` sets HOPDECK_TOKEN so the browser session survives --watch restarts.
const token = process.env['HOPDECK_TOKEN'] || generateToken();
// The token is all it takes to change firewalls as root; a short one can be guessed.
if (token.length < 32) {
  process.stderr.write(`warning: HOPDECK_TOKEN has ${token.length} characters; anyone who can reach 127.0.0.1 might guess it. Leave it unset for a random one.\n`);
}

const server = await startServer({
  port,
  token,
  extraOrigins: values.dev ? DEV_UI_ORIGINS : [],
  webRoot: values.dev ? undefined : fileURLToPath(new URL('../../web/dist/', import.meta.url)),
  version: pkg.version,
  hosts,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await Promise.allSettled([server.close(), sandbox?.dispose()]);
    process.exit(0);
  });
}

// The token goes in the fragment, which browsers never send to the server.
const uiOrigin = values.dev ? DEV_UI_ORIGINS[0] : `http://127.0.0.1:${server.port}`;
process.stdout.write(`hopdeck ${pkg.version} is running at:\n\n  ${uiOrigin}/#token=${token}\n\n`);

function fail(message: string): never {
  process.stderr.write(`hopdeck: ${message}\n`);
  process.exit(2);
}
