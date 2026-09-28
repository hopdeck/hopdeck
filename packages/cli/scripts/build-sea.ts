// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

/**
 * Builds hopdeck as one executable file: a Node.js single executable
 * application with the server bundled into one script and the web UI as its
 * assets. Nothing needs to be installed to run it, not even Node.js.
 *
 *   pnpm build:sea [--target TARGET]... [--archive] [--check-all] [--qemu]
 *
 * TARGET is linux-x64, linux-arm64, win-x64 or win-arm64; without --target it
 * builds for this machine. Each target gets dist/hopdeck-VERSION-TARGET/ with
 * the executable, the licenses, the README and a SHA-256 sum; --archive also
 * packs it, into a .tar.xz for Linux and a .zip for Windows, and lists every
 * archive's sum in dist/SHA256SUMS. Each executable is started and asked for
 * its UI, API and licenses, which for another architecture needs an
 * emulator: binfmt with QEMU, or with --qemu, qemu-ARCH-static with the
 * target's libraries from /usr/ARCH-linux-gnu (Debian's and Ubuntu's cross
 * packages). A Windows executable is checked on Windows only. Where nothing
 * runs it, the check is skipped, unless --check-all makes that an error.
 *
 * Windows executables are built on Linux or Windows, Linux ones on Linux. The
 * Node.js releases they are made from are downloaded once from nodejs.org
 * into .dev/sea, and used only if their SHA-256 is the one below: no package
 * from npm goes into the build.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { crc32, deflateRawSync } from 'node:zlib';
import { build } from 'vite';
import pkg from '../package.json' with { type: 'json' };

/**
 * Node.js 26 builds the executable itself (--build-sea), also for another
 * system or architecture, and runs an ES module as its entry; 24 needs a tool
 * from npm to inject the script. Per target, the file on nodejs.org and its
 * SHA-256 from the release's SHASUMS256.txt.
 */
const NODE = {
  version: 'v26.10.0',
  targets: {
    'linux-x64': { file: 'node-v26.10.0-linux-x64.tar.xz', sha256: 'ca70e9e349de048b9522abb3adc05b3bd6f43c5ffd3ec57916c7da292f59f022' },
    'linux-arm64': { file: 'node-v26.10.0-linux-arm64.tar.xz', sha256: '7a6353f63eb3d04765004b4adf172616243e4522434635cb1d26288658b04ab5' },
    'win-x64': { file: 'win-x64/node.exe', sha256: 'cea6ac365f9bb9586dafd2084d996e092e7d3e7d07ab52d1f76bf53d1fca9bc4' },
    'win-arm64': { file: 'win-arm64/node.exe', sha256: '63f374ed30ab433fece49304f1a20a1a96137058dd0b10d69169c104dd15b997' },
  } as Record<string, { file: string; sha256: string }>,
  /** On Windows, Node.js's license comes from this archive: a bare node.exe has none. */
  windowsZip: { file: 'node-v26.10.0-win-x64.zip', sha256: '9fef7eca6743a6b910989cd8e78712376b394fcb9b6e1e9c44a0799a287f90c5' },
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
const host = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const targets = values.target ?? [host];
for (const target of targets) {
  if (NODE.targets[target] === undefined) throw new Error(`no Node.js for ${target} is pinned; hopdeck builds for ${Object.keys(NODE.targets).join(', ')}`);
  if (isWindows(host) && !isWindows(target)) throw new Error(`${target} is built on Linux; Windows builds Windows executables only`);
}

function isWindows(target: string): boolean {
  return target.startsWith('win-');
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

/** A file of the Node.js release, downloaded once, and kept only if its SHA-256 is the pinned one. */
async function download({ file, sha256: expected }: { file: string; sha256: string }): Promise<string> {
  const local = join(work, file.includes('/') ? `node-${NODE.version}-${file.split('/')[0]}.exe` : file);
  if (existsSync(local)) return local;
  const url = `https://nodejs.org/dist/${NODE.version}/${file}`;
  process.stdout.write(`downloading ${url}\n`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  const data = Buffer.from(await response.arrayBuffer());
  const actual = sha256(data);
  if (actual !== expected) throw new Error(`${url} has SHA-256 ${actual}, not the pinned ${expected}; nothing was used`);
  await mkdir(work, { recursive: true });
  await writeFile(local, data);
  return local;
}

/** The Node.js binary for a target: from the release's archive on Linux, the bare node.exe for Windows. */
async function officialNode(target: string): Promise<string> {
  const pinned = NODE.targets[target]!;
  if (isWindows(target)) return download(pinned);
  const dir = join(work, basename(pinned.file, '.tar.xz'));
  const binary = join(dir, 'bin/node');
  if (!existsSync(binary)) {
    const archive = await download(pinned);
    run('tar', ['-xJf', archive, '-C', work]);
    await rm(archive);
  }
  return binary;
}

/** Node.js's license: the same text in every release of a version; from this machine's. */
async function nodeLicense(): Promise<string> {
  if (!isWindows(host)) {
    await officialNode(host);
    return join(work, basename(NODE.targets[host]!.file, '.tar.xz'), 'LICENSE');
  }
  const license = join(work, basename(NODE.windowsZip.file, '.zip'), 'LICENSE');
  if (!existsSync(license)) run('tar', ['-xf', await download(NODE.windowsZip), '-C', work, `${basename(NODE.windowsZip.file, '.zip')}/LICENSE`]);
  return license;
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
  if (target === host || !values.qemu || isWindows(target)) return { command: executable, prefix: [] };
  const arch = QEMU_ARCH[target.split('-')[1]!]!;
  return { command: `qemu-${arch}-static`, prefix: ['-L', `/usr/${arch}-linux-gnu`, executable] };
}

/** Whether this machine runs the executable: natively, or through an emulator. */
function runnable(target: string, executable: string): boolean {
  if (isWindows(target) !== isWindows(host)) return false;
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

/**
 * A zip of files, as Windows opens it without extra tools: deflated, with the
 * given time for all, so that the same input gives the same bytes. Below
 * 4 GiB, so without zip64.
 */
function zip(entries: { name: string; data: Buffer; executable?: boolean }[], time: Date): Buffer {
  const dosTime = (time.getUTCHours() << 11) | (time.getUTCMinutes() << 5) | (time.getUTCSeconds() >> 1);
  const dosDate = ((time.getUTCFullYear() - 1980) << 9) | ((time.getUTCMonth() + 1) << 5) | time.getUTCDate();
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const packed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, 2.0: the mode below counts
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.executable ? 0o100755 : 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const listing = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(listing.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, listing, end]);
}

/** The archive a target's directory is packed into. */
function archiveName(target: string): string {
  return `hopdeck-${pkg.version}-${target}${isWindows(target) ? '.zip' : '.tar.xz'}`;
}

step(`Node.js ${NODE.version}: this machine's, to build with, and for ${targets.join(', ')}`);
// --build-sea runs on this machine; the executable is made from the target's Node.js.
const builder = await officialNode(host);
const nodes = new Map<string, string>();
for (const target of targets) nodes.set(target, await officialNode(target));
const license = await nodeLicense();

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
  if (!file.startsWith('.vite/')) webAssets[`web/${file.split('\\').join('/')}`] = join(webDist, file);
}

const licenses = [
  `# Licenses of what hopdeck ${pkg.version} contains\n`,
  'hopdeck itself: GNU General Public License, version 3 or later (LICENSE).\n',
  `## Node.js ${NODE.version}, which runs it\n`,
  await readFile(license, 'utf8'),
  '\n## The packages bundled into the web UI\n',
  // Its own title goes, its headings go one level down.
  (await readFile(join(webDist, '.vite/license.md'), 'utf8')).replace(/^# .*\n/, '').replace(/^## /gm, '### '),
].join('\n');
await writeFile(join(work, 'THIRD-PARTY-LICENSES.md'), licenses);
// The same input gives the same archive: fixed order, owner and times.
const time = Number(spawnSync('git', ['log', '-1', '--format=%ct'], { cwd: repo, encoding: 'utf8' }).stdout.trim());

const unchecked: string[] = [];
for (const target of targets) {
  const name = `hopdeck-${pkg.version}-${target}`;
  const out = join(dist, name);
  const scratch = join(work, target);
  await mkdir(scratch, { recursive: true });

  step(`${name}: the executable`);
  const assets: Record<string, string> = {
    'sandbox-demo.nft': join(repo, 'packages/server/src/hosts/sandbox-demo.nft'),
    'LICENSE': join(repo, 'LICENSE'),
    'THIRD-PARTY-LICENSES.md': join(work, 'THIRD-PARTY-LICENSES.md'),
    ...webAssets,
  };
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const program = isWindows(target) ? 'hopdeck.exe' : 'hopdeck';
  const executable = join(out, program);
  const config = join(scratch, 'sea.json');
  const seaConfig = {
    main: join(bundle, 'hopdeck.mjs'),
    mainFormat: 'module',
    output: executable,
    executable: nodes.get(target)!,
    disableExperimentalSEAWarning: true,
    assets,
  };
  await writeFile(config, JSON.stringify(seaConfig, null, 2));
  run(builder, ['--build-sea', config]);
  await chmod(executable, 0o755);
  for (const file of ['LICENSE', 'README.md']) await copyFile(join(repo, file), join(out, file));
  await copyFile(join(work, 'THIRD-PARTY-LICENSES.md'), join(out, 'THIRD-PARTY-LICENSES.md'));
  await writeFile(join(out, `${program}.sha256`), `${sha256(await readFile(executable))}  ${program}\n`);

  step(`${name}: checking it`);
  if (target === host || runnable(target, executable)) {
    await check(target, executable, `${await readFile(join(repo, 'LICENSE'), 'utf8')}\n\n${licenses}`);
    process.stdout.write(`${relative(repo, executable)} works.\n`);
  } else if (values['check-all']) {
    throw new Error(`this machine cannot run ${target} executables, and --check-all asks for every one`);
  } else {
    unchecked.push(target);
    process.stdout.write(`not checked: this machine cannot run ${target} executables (${isWindows(target) ? 'Windows' : 'QEMU, see --qemu,'} would).\n`);
  }

  if (values.archive) {
    if (isWindows(target)) {
      const entries = [];
      for (const file of (await readdir(out)).sort()) {
        entries.push({ name: `${name}/${file}`, data: await readFile(join(out, file)), executable: file === program });
      }
      await writeFile(join(dist, archiveName(target)), zip(entries, new Date(time * 1000)));
    } else {
      run('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', `--mtime=@${time}`, '-cJf', archiveName(target), name], dist);
    }
  }
}

if (values.archive) {
  step('Sums');
  // This version's, for any target, also one built by an earlier run; "0.1.0-dev" is not "0.1.0".
  const names = new Set(Object.keys(NODE.targets).map(archiveName));
  const archives = (await readdir(dist)).filter((file) => names.has(file)).sort();
  const sums = await Promise.all(archives.map(async (file) => `${sha256(await readFile(join(dist, file)))}  ${file}\n`));
  await writeFile(join(dist, 'SHA256SUMS'), sums.join(''));
  process.stdout.write(sums.join(''));
}

process.stdout.write(`\nBuilt for ${targets.join(', ')} in ${relative(repo, dist)}/.${unchecked.length > 0 ? ` Not checked here: ${unchecked.join(', ')}.` : ''}\n`);
