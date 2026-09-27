// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

/**
 * Builds hopdeck as one executable file: a Node.js single executable
 * application with the server bundled into one script and the web UI as its
 * assets. Nothing needs to be installed to run it, not even Node.js.
 *
 *   pnpm build:sea [--target linux-x64] [--target linux-arm64] [--archive] [--check-all] [--qemu]
 *
 * Without --target it builds for this machine. Each target gets
 * dist/hopdeck-VERSION-TARGET/ with the executable, the licenses, the README
 * and a SHA-256 sum; --archive also packs it into
 * dist/hopdeck-VERSION-TARGET.tar.xz and lists every archive's sum in
 * dist/SHA256SUMS. Each executable is started and asked for its UI and API,
 * which for another architecture needs an emulator: binfmt with QEMU, or with
 * --qemu, qemu-ARCH-static with the target's libraries from
 * /usr/ARCH-linux-gnu (Debian's and Ubuntu's cross packages). Where none runs
 * it, the check is skipped, unless --check-all makes that an error.
 *
 * The Node.js releases it is built from are downloaded once from nodejs.org
 * into .dev/sea, and used only if their SHA-256 is the one below: no package
 * from npm goes into the build.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'vite';
import pkg from '../package.json' with { type: 'json' };

/**
 * Node.js 26 builds the executable itself (--build-sea), also for another
 * architecture, and runs an ES module as its entry; 24 needs a tool from npm
 * to inject the script. The sums are those of SHASUMS256.txt for the release.
 */
const NODE = {
  version: 'v26.10.0',
  sha256: {
    'linux-x64': 'ca70e9e349de048b9522abb3adc05b3bd6f43c5ffd3ec57916c7da292f59f022',
    'linux-arm64': '7a6353f63eb3d04765004b4adf172616243e4522434635cb1d26288658b04ab5',
  } as Record<string, string>,
};

const { values } = parseArgs({
  options: {
    target: { type: 'string', multiple: true },
    archive: { type: 'boolean', default: false },
    'check-all': { type: 'boolean', default: false },
    qemu: { type: 'boolean', default: false },
  },
});

const repo = join(import.meta.dirname, '../../..');
const work = join(repo, '.dev/sea');
const dist = join(repo, 'dist');
const host = `${process.platform}-${process.arch}`;
const targets = values.target ?? [host];
for (const target of targets) {
  if (NODE.sha256[target] === undefined) throw new Error(`no Node.js for ${target} is pinned; hopdeck builds for ${Object.keys(NODE.sha256).join(', ')}`);
}

function step(text: string): void {
  process.stdout.write(`\n== ${text}\n`);
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function run(command: string, args: string[], cwd = repo): void {
  const done = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (done.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${done.status ?? done.signal}`);
}

/** An official Node.js release for a target, downloaded and checked once. */
async function officialNode(target: string): Promise<{ binary: string; license: string }> {
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
    if (actual !== NODE.sha256[target]) throw new Error(`${url} has SHA-256 ${actual}, not the pinned ${NODE.sha256[target]}; nothing was used`);
    await mkdir(work, { recursive: true });
    const file = join(work, `${base}.tar.xz`);
    await writeFile(file, archive);
    run('tar', ['-xJf', file, '-C', work]);
    await rm(file);
  }
  return { binary, license: join(dir, 'LICENSE') };
}

/** Every file under a directory, as paths relative to it. */
async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

/** QEMU's names for Node.js's architectures. */
const QEMU_ARCH: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' };

/** How to start an executable for a target: itself, or under QEMU with --qemu. */
function launcher(target: string, executable: string): { command: string; prefix: string[] } {
  if (target === host || !values.qemu) return { command: executable, prefix: [] };
  const arch = QEMU_ARCH[target.split('-')[1]!]!;
  return { command: `qemu-${arch}-static`, prefix: ['-L', `/usr/${arch}-linux-gnu`, executable] };
}

/** Whether this machine runs the executable: natively, or through an emulator. */
function runnable(target: string, executable: string): boolean {
  const { command, prefix } = launcher(target, executable);
  const tried = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8' });
  return tried.error === undefined && tried.status === 0;
}

/** Starts the executable as a user would, and asks it for its UI, its API and its licenses. */
async function check(target: string, executable: string, licenses: string): Promise<void> {
  const { command, prefix } = launcher(target, executable);
  const version = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8' });
  if (version.stdout.trim() !== pkg.version) throw new Error(`--version printed ${JSON.stringify(version.stdout)}: ${version.stderr}`);
  // All of them, also into a pipe.
  const printed = spawnSync(command, [...prefix, '--licenses'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (printed.stdout !== licenses) throw new Error(`--licenses printed ${printed.stdout.length} characters, not the ${licenses.length} it holds`);

  const config = await mkdtemp(join(tmpdir(), 'hopdeck-sea-'));
  const token = 'sea-check-0123456789abcdef0123456789';
  // Apart from anything of the user's: its own configuration and runtime directory, no ssh-agent.
  const { SSH_AUTH_SOCK: _agent, ...env } = process.env;
  const child = spawn(command, [...prefix, '--port', '0'], {
    env: { ...env, HOPDECK_CONFIG_DIR: config, XDG_RUNTIME_DIR: config, HOPDECK_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let printed = '';
    // Under an emulator it takes a while.
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no URL within 60 s:\n${printed}`)), 60_000);
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

step(`Node.js ${NODE.version}: this machine's, to build with, and for ${targets.join(', ')}`);
// --build-sea runs on this machine; the executable is made from the target's Node.js.
const builder = await officialNode(host);
const nodes = new Map<string, Awaited<ReturnType<typeof officialNode>>>();
for (const target of targets) nodes.set(target, await officialNode(target));

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
const webAssets: Record<string, string> = {};
for (const file of await files(webDist)) {
  if (!file.startsWith('.vite/')) webAssets[`web/${file}`] = join(webDist, file);
}

const unchecked: string[] = [];
for (const target of targets) {
  const node = nodes.get(target)!;
  const name = `hopdeck-${pkg.version}-${target}`;
  const out = join(dist, name);
  const scratch = join(work, target);
  await mkdir(scratch, { recursive: true });

  step(`${name}: the licenses`);
  // The Node.js licenses of both architectures are the same text; this one is the target's.
  const licenses = [
    `# Licenses of what hopdeck ${pkg.version} contains\n`,
    'hopdeck itself: GNU General Public License, version 3 or later (LICENSE).\n',
    `## Node.js ${NODE.version}, which runs it\n`,
    await readFile(node.license, 'utf8'),
    '\n## The packages bundled into the web UI\n',
    // Its own title goes, its headings go one level down.
    (await readFile(join(webDist, '.vite/license.md'), 'utf8')).replace(/^# .*\n/, '').replace(/^## /gm, '### '),
  ].join('\n');
  await writeFile(join(scratch, 'THIRD-PARTY-LICENSES.md'), licenses);

  step(`${name}: the executable`);
  const assets: Record<string, string> = {
    'sandbox-demo.nft': join(repo, 'packages/server/src/hosts/sandbox-demo.nft'),
    'LICENSE': join(repo, 'LICENSE'),
    'THIRD-PARTY-LICENSES.md': join(scratch, 'THIRD-PARTY-LICENSES.md'),
    ...webAssets,
  };
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const executable = join(out, 'hopdeck');
  const config = join(scratch, 'sea.json');
  const seaConfig = {
    main: join(bundle, 'hopdeck.mjs'),
    mainFormat: 'module',
    output: executable,
    executable: node.binary,
    disableExperimentalSEAWarning: true,
    assets,
  };
  await writeFile(config, JSON.stringify(seaConfig, null, 2));
  run(builder.binary, ['--build-sea', config]);
  await chmod(executable, 0o755);
  for (const file of ['LICENSE', 'README.md']) await copyFile(join(repo, file), join(out, file));
  await copyFile(join(scratch, 'THIRD-PARTY-LICENSES.md'), join(out, 'THIRD-PARTY-LICENSES.md'));
  await writeFile(join(out, 'hopdeck.sha256'), `${sha256(await readFile(executable))}  hopdeck\n`);

  step(`${name}: checking it`);
  if (target === host || runnable(target, executable)) {
    await check(target, executable, `${await readFile(join(repo, 'LICENSE'), 'utf8')}\n\n${licenses}`);
    process.stdout.write(`${relative(repo, executable)} works.\n`);
  } else if (values['check-all']) {
    throw new Error(`this machine cannot run ${target} executables (no emulator), and --check-all asks for every one`);
  } else {
    unchecked.push(target);
    process.stdout.write(`not checked: this machine cannot run ${target} executables (QEMU would, see --qemu).\n`);
  }

  if (values.archive) {
    // The same input gives the same archive: fixed order, owner and times.
    const time = spawnSync('git', ['log', '-1', '--format=%ct'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    run('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', `--mtime=@${time}`, '-cJf', `${name}.tar.xz`, name], dist);
  }
}

if (values.archive) {
  step('Sums');
  // This version's, for any target, also one built by an earlier run; "0.1.0-dev" is not "0.1.0".
  const names = new Set(Object.keys(NODE.sha256).map((target) => `hopdeck-${pkg.version}-${target}.tar.xz`));
  const archives = (await readdir(dist)).filter((file) => names.has(file)).sort();
  const sums = await Promise.all(archives.map(async (file) => `${sha256(await readFile(join(dist, file)))}  ${file}\n`));
  await writeFile(join(dist, 'SHA256SUMS'), sums.join(''));
  process.stdout.write(sums.join(''));
}

process.stdout.write(`\nBuilt for ${targets.join(', ')} in ${relative(repo, dist)}/.${unchecked.length > 0 ? ` Not checked here: ${unchecked.join(', ')}.` : ''}\n`);
