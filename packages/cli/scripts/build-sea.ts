// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

/**
 * Builds hopdeck as one executable file: a Node.js single executable
 * application with the server bundled into one script and the web UI as its
 * assets. Nothing needs to be installed to run it, not even Node.js.
 *
 *   pnpm build:sea
 *
 * The result is dist/hopdeck-VERSION-linux-ARCH/ with the executable, the
 * licenses and a SHA-256 sum, for this machine's architecture. The Node.js it
 * is built on is downloaded once from nodejs.org into .dev/sea, and used only
 * if its SHA-256 is the one below: no package from npm goes into the build.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { build } from 'vite';
import pkg from '../package.json' with { type: 'json' };

/**
 * Node.js 26 builds the executable itself (--build-sea) and runs an ES module
 * as its entry; 24 needs a tool from npm to inject the script. The sums are
 * those of SHASUMS256.txt for this release.
 */
const NODE = {
  version: 'v26.10.0',
  sha256: {
    'linux-x64': 'ca70e9e349de048b9522abb3adc05b3bd6f43c5ffd3ec57916c7da292f59f022',
    'linux-arm64': '7a6353f63eb3d04765004b4adf172616243e4522434635cb1d26288658b04ab5',
  } as Record<string, string>,
};

const repo = join(import.meta.dirname, '../../..');
const work = join(repo, '.dev/sea');
const target = `${process.platform}-${process.arch}`;
const name = `hopdeck-${pkg.version}-${target}`;
const out = join(repo, 'dist', name);

function step(text: string): void {
  process.stdout.write(`\n== ${text}\n`);
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The official Node.js for this machine, downloaded and checked once. */
async function officialNode(): Promise<{ binary: string; license: string }> {
  const expected = NODE.sha256[target];
  if (expected === undefined) throw new Error(`no Node.js for ${target} is pinned; hopdeck builds for ${Object.keys(NODE.sha256).join(', ')}`);
  const base = `node-${NODE.version}-${target}`;
  const dir = join(work, base);
  const binary = join(dir, 'bin/node');
  if (!existsSync(binary)) {
    const url = `https://nodejs.org/dist/${NODE.version}/${base}.tar.xz`;
    process.stdout.write(`downloading ${url}\n`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
    const archive = Buffer.from(await response.arrayBuffer());
    const actual = sha256(archive);
    if (actual !== expected) throw new Error(`${url} has SHA-256 ${actual}, not the pinned ${expected}; nothing was used`);
    await mkdir(work, { recursive: true });
    const file = join(work, `${base}.tar.xz`);
    await writeFile(file, archive);
    run('tar', ['-xJf', file, '-C', work]);
    await rm(file);
  }
  return { binary, license: join(dir, 'LICENSE') };
}

function run(command: string, args: string[], cwd = repo): void {
  const done = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (done.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${done.status ?? done.signal}`);
}

/** Every file under a directory, as paths relative to it. */
async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

/** Starts the executable as a user would, and asks it for its UI and its API. */
async function check(executable: string): Promise<void> {
  const version = spawnSync(executable, ['--version'], { encoding: 'utf8' });
  if (version.stdout.trim() !== pkg.version) throw new Error(`--version printed ${JSON.stringify(version.stdout)}: ${version.stderr}`);

  const config = await mkdtemp(join(tmpdir(), 'hopdeck-sea-'));
  const token = 'sea-check-0123456789abcdef0123456789';
  // Apart from anything of the user's: its own configuration and runtime directory, no ssh-agent.
  const { SSH_AUTH_SOCK: _agent, ...env } = process.env;
  const child = spawn(executable, ['--port', '0'], {
    env: { ...env, HOPDECK_CONFIG_DIR: config, XDG_RUNTIME_DIR: config, HOPDECK_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let printed = '';
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no URL within 15 s:\n${printed}`)), 15_000);
      child.stdout.on('data', (chunk: Buffer) => {
        printed += chunk.toString();
        const url = /(http:\/\/127\.0\.0\.1:\d+)\//.exec(printed);
        if (url !== null) {
          clearTimeout(timer);
          resolve(url[1]!);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => (printed += chunk.toString()));
      child.on('exit', (code) => reject(new Error(`exited with ${code}:\n${printed}`)));
    });
    const page = await fetch(`${origin}/`);
    const html = await page.text();
    if (!page.ok || !html.includes('<div id="root">')) throw new Error(`/ answered ${page.status}: ${html.slice(0, 200)}`);
    const script = /src="\/(assets\/[^"]+\.js)"/.exec(html)?.[1];
    if (script === undefined || !(await fetch(`${origin}/${script}`)).ok) throw new Error(`the UI's script ${script} is missing`);
    const api = await fetch(`${origin}/api/hosts`, { headers: { authorization: `Bearer ${token}` } });
    if (!api.ok) throw new Error(`/api/hosts answered ${api.status}: ${await api.text()}`);
  } finally {
    child.kill();
    await rm(config, { recursive: true, force: true });
  }
}

step(`Node.js ${NODE.version} for ${target}`);
const node = await officialNode();

step('The web UI');
const web = join(repo, 'packages/web');
// The UI's own configuration, and the licenses of what it bundles.
await build({ root: web, logLevel: 'warn', build: { license: { fileName: '.vite/license.md' } } });
const webDist = join(web, 'dist');

step('The server, bundled into one script');
const bundle = join(work, 'bundle');
await build({
  configFile: false,
  root: repo,
  logLevel: 'warn',
  build: {
    ssr: join(repo, 'packages/cli/src/main.ts'),
    outDir: bundle,
    emptyOutDir: true,
    target: 'esnext',
    minify: false,
    rolldownOptions: { output: { format: 'es', entryFileNames: 'hopdeck.mjs', codeSplitting: false } },
  },
  // Everything goes in, only Node.js's own modules stay outside.
  ssr: { noExternal: true, target: 'node' },
});

step('The licenses');
const licenses = [
  `# Licenses of what hopdeck ${pkg.version} contains\n`,
  'hopdeck itself: GNU General Public License, version 3 or later (LICENSE).\n',
  `## Node.js ${NODE.version}, which runs it\n`,
  await readFile(node.license, 'utf8'),
  '\n## The packages bundled into the web UI\n',
  // Its own title goes, its headings go one level down.
  (await readFile(join(webDist, '.vite/license.md'), 'utf8')).replace(/^# .*\n/, '').replace(/^## /gm, '### '),
].join('\n');
await writeFile(join(work, 'THIRD-PARTY-LICENSES.md'), licenses);

step('The executable');
const assets: Record<string, string> = {
  'sandbox-demo.nft': join(repo, 'packages/server/src/hosts/sandbox-demo.nft'),
  'LICENSE': join(repo, 'LICENSE'),
  'THIRD-PARTY-LICENSES.md': join(work, 'THIRD-PARTY-LICENSES.md'),
};
for (const file of await files(webDist)) {
  if (!file.startsWith('.vite/')) assets[`web/${file}`] = join(webDist, file);
}
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const executable = join(out, 'hopdeck');
const config = join(work, 'sea.json');
await writeFile(
  config,
  JSON.stringify(
    { main: join(bundle, 'hopdeck.mjs'), mainFormat: 'module', output: executable, disableExperimentalSEAWarning: true, assets },
    null,
    2,
  ),
);
run(node.binary, ['--build-sea', config]);
await chmod(executable, 0o755);
await copyFile(join(repo, 'LICENSE'), join(out, 'LICENSE'));
await copyFile(join(work, 'THIRD-PARTY-LICENSES.md'), join(out, 'THIRD-PARTY-LICENSES.md'));

step('Checking it');
await check(executable);
const sum = `${sha256(await readFile(executable))}  hopdeck\n`;
await writeFile(join(out, 'hopdeck.sha256'), sum);
process.stdout.write(`\n${relative(repo, executable)} works.\nSHA-256: ${sum}`);
process.stdout.write(`Size: ${((await readFile(executable)).length / 1024 / 1024).toFixed(0)} MiB, ${Object.keys(assets).length} assets; ${dirname(relative(repo, executable))} is ready to pack.\n`);
