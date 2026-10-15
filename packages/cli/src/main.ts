#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  answerAskpass,
  demoRuleset,
  embedded,
  ensureControlDir,
  generateToken,
  HostManager,
  inExecutable,
  Sandbox,
  PortsTakenError,
  startServerOnFreePort,
  type TakenPort,
  webFilesIn,
  webFilesInExecutable,
} from '@hopdeck/server';
import { sourceUrl } from '@hopdeck/core';
import pkg from '../package.json' with { type: 'json' };

// The Appropriate Legal Notices (AGPL-3.0, section 5d) and where the source is (section 13); copies must keep them.
const NOTICE = `hopdeck  Copyright (C) 2026 Mateusz T (Tenir), https://github.com/Tenirrr
This program comes with ABSOLUTELY NO WARRANTY. It is free software, and you
are welcome to redistribute it under the terms of the GNU AGPL, version 3 or
later: https://www.gnu.org/licenses/agpl-3.0.html
Source code: ${sourceUrl(pkg.version)}
`;

const HELP = `Usage: hopdeck [options]

Starts the hopdeck panel on 127.0.0.1 and prints its URL.

Options:
  -p, --port <port>  port to listen on; without it, the first free one of
                     7400 to 7419
      --sandbox      add a sandbox host: a private network namespace with a
                     demo firewall, needs no root and never touches the real one
      --dev          serve the API only; the UI comes from the Vite dev server
      --licenses     print the licenses of hopdeck and of what it contains
  -v, --version      print the version
  -h, --help         show this help

Environment:
  HOPDECK_PORT          the port, as --port
  HOPDECK_CONFIG_DIR    where hosts.json is kept (default: ~/.config/hopdeck)
  HOPDECK_SSH_CONFIG    an ssh config file to use instead of ~/.ssh/config
  HOPDECK_SSH_DIR       where keys generated in the panel go (default: ~/.ssh)
`;

/** Ports tried in turn when none is asked for. */
const DEFAULT_PORT = 7400;
const PORTS_TRIED = 20;

// The Vite dev server's port, which pnpm dev picks and passes on.
const devUiPort = Number(process.env['HOPDECK_UI_PORT'] ?? 5173);
const DEV_UI_ORIGINS = [`http://127.0.0.1:${devUiPort}`, `http://localhost:${devUiPort}`];

// Run by ssh as SSH_ASKPASS on Windows (see withAskpass()): answer, and nothing else.
if (process.env['HOPDECK_ASKPASS'] === '1') process.exit(answerAskpass(process.argv[2]));

const { values } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    sandbox: { type: 'boolean', default: false },
    dev: { type: 'boolean', default: false },
    licenses: { type: 'boolean', default: false },
    version: { type: 'boolean', short: 'v', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) await print(`${HELP}\n${NOTICE}`);
if (values.version) await print(`${pkg.version}\n`);
if (values.licenses) await print(await licenses());

const asked = values.port ?? process.env['HOPDECK_PORT'];
const port = asked === undefined ? undefined : Number(asked);
if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535)) {
  fail(`invalid port: ${asked}`);
}
// A port asked for is that port; otherwise the first free one from 7400 on.
const ports = port !== undefined ? [port] : Array.from({ length: PORTS_TRIED }, (_, index) => DEFAULT_PORT + index);

const configDir =
  process.env['HOPDECK_CONFIG_DIR'] || join(process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'hopdeck');

let sandbox: Sandbox | undefined;
if (values.sandbox && process.platform === 'win32') {
  // Network namespaces are Linux's; pnpm dev asks for the sandbox everywhere.
  process.stderr.write('hopdeck: the sandbox needs Linux, so there is none on Windows\n');
} else if (values.sandbox) {
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
  sshDir: process.env['HOPDECK_SSH_DIR'] ? resolve(process.env['HOPDECK_SSH_DIR']) : undefined,
  ...(sandbox && { sandbox: { executor: sandbox.executor, directory: sandbox.directory } }),
});

// `pnpm dev` sets HOPDECK_TOKEN so the browser session survives --watch restarts.
const token = process.env['HOPDECK_TOKEN'] || generateToken();
// The token is all it takes to change firewalls as root; a short one can be guessed.
if (token.length < 32) {
  process.stderr.write(`warning: HOPDECK_TOKEN has ${token.length} characters; anyone who can reach 127.0.0.1 might guess it. Leave it unset for a random one.\n`);
}

let started: Awaited<ReturnType<typeof startServerOnFreePort>>;
try {
  started = await startServerOnFreePort(
    {
      token,
      extraOrigins: values.dev ? DEV_UI_ORIGINS : [],
      web: values.dev ? undefined : inExecutable() ? webFilesInExecutable() : webFilesIn(fileURLToPath(new URL('../../web/dist/', import.meta.url))),
      version: pkg.version,
      hosts,
    },
    ports,
  );
} catch (error) {
  await Promise.allSettled([sandbox?.dispose(), hosts.close()]);
  if (!(error instanceof PortsTakenError)) throw error;
  fail(
    port !== undefined
      ? `port ${port} is taken by ${holder(error.taken[0]!)}; ${error.taken[0]!.by === 'hopdeck' ? 'open that one, or stop it first' : 'choose another with --port, or leave --port out and hopdeck finds a free one'}`
      : `ports ${ports[0]} to ${ports.at(-1)} are all taken; choose one with --port`,
  );
}
const { server, taken } = started;

// SIGHUP: the terminal, or on Windows the console window, was closed.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.once(signal, async () => {
    await Promise.allSettled([server.close(), sandbox?.dispose(), hosts.close()]);
    process.exit(0);
  });
}

// The token goes in the fragment, which browsers never send to the server.
const uiOrigin = values.dev ? DEV_UI_ORIGINS[0] : `http://127.0.0.1:${server.port}`;
for (const busy of taken) process.stdout.write(`Port ${busy.port} is taken by ${holder(busy)}.\n`);
process.stdout.write(`${NOTICE}\nhopdeck ${pkg.version} is running at:\n\n  ${uiOrigin}/#token=${token}\n\n`);
if (sshConfig) process.stdout.write(`SSH hosts come from ${sshConfig} (HOPDECK_SSH_CONFIG), not ~/.ssh/config.\n\n`);

/**
 * Prints and exits once all of it is written: into a pipe, exiting at once
 * would cut it off after 64 KiB, and the licenses are longer.
 */
async function print(text: string): Promise<never> {
  const error = await new Promise<NodeJS.ErrnoException | null | undefined>((resolve) => {
    process.stdout.on('error', resolve);
    process.stdout.write(text, resolve);
  });
  // A reader that stops early, as head or less does, closes the pipe: that is no failure.
  if (error && error.code !== 'EPIPE') {
    process.stderr.write(`hopdeck: cannot write the output: ${error.message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

/** AGPL-3.0 for hopdeck, and in the executable, those of Node.js and of the UI's packages. */
async function licenses(): Promise<string> {
  const own = embedded('LICENSE')?.toString('utf8') ?? (await readFile(new URL('../../../LICENSE', import.meta.url), 'utf8'));
  const others = embedded('THIRD-PARTY-LICENSES.md')?.toString('utf8');
  return others === undefined ? own : `${own}\n\n${others}`;
}

/** What holds a taken port, for a message. */
function holder({ port: taken, by }: TakenPort): string {
  return by === 'hopdeck' ? `another hopdeck (http://127.0.0.1:${taken}/)` : 'another program';
}

function fail(message: string): never {
  process.stderr.write(`hopdeck: ${message}\n`);
  process.exit(2);
}
