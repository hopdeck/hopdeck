// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { HostError } from './errors.ts';
import { runProcess } from './process.ts';

export interface AddIdentityOptions {
  /** ~/.ssh/config, or the file HOPDECK_SSH_CONFIG names. */
  configFile: string;
  /** The host as hopdeck reaches it, e.g. "serwer1" or "root@10.0.0.1". */
  destination: string;
  identityFile: string;
  now?: Date;
}

/**
 * Names a key for a host in the user's ssh config, so that ssh offers it
 * there, in a terminal too. A Host block goes at the end: IdentityFile adds
 * up across all blocks that match, so it counts whatever comes before it,
 * and nothing in the file changes. The file as it was is kept as
 * CONFIG.hopdeck-backup; if ssh -G does not then name the key for the host,
 * it is put back.
 */
export async function addIdentityToConfig(options: AddIdentityOptions): Promise<{ file: string; backup?: string; block: string }> {
  const { configFile, destination, identityFile } = options;
  // ssh matches Host patterns against the host, without the user.
  const host = destination.slice(destination.lastIndexOf('@') + 1);
  if (!/^[A-Za-z0-9._:[\]%-]+$/.test(host)) throw new HostError('command-failed', `hopdeck adds no Host block for ${JSON.stringify(host)}`);

  const date = (options.now ?? new Date()).toISOString().slice(0, 10);
  const block = `# Added by hopdeck on ${date}: the key for ${host}.\nHost ${host}\n    IdentityFile ${configPath(identityFile)}\n`;

  let before: string | undefined;
  try {
    before = await readFile(configFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const backup = before === undefined ? undefined : `${configFile}.hopdeck-backup`;
  await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });
  if (backup !== undefined) await copyFile(configFile, backup);
  const separator = before === undefined || before === '' ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  await writeFile(configFile, `${before ?? ''}${separator}${block}`, { mode: 0o600 });

  const shown = await runProcess('ssh', ['-F', configFile, '-G', '--', destination], { timeoutMs: 10_000 });
  const named = shown.stdout
    .split('\n')
    .some((line) => line.startsWith('identityfile ') && samePath(expand(line.slice('identityfile '.length).trim()), identityFile));
  if (shown.exitCode !== 0 || !named) {
    if (before === undefined) await rm(configFile, { force: true });
    else await writeFile(configFile, before);
    throw new HostError(
      'command-failed',
      `after the change ssh -G did not name ${identityFile} for ${destination}, so ${configFile} is as it was: ${shown.stderr.trim() || 'no IdentityFile line for it'}`,
    );
  }
  return { file: configFile, ...(backup !== undefined && { backup }), block };
}

/** A path as ssh config takes it: ~/... under the home directory, quoted when it has spaces. */
function configPath(path: string): string {
  const home = homedir();
  const shown = path.startsWith(home + sep) ? `~/${relative(home, path).split(sep).join('/')}` : path;
  return /\s/.test(shown) ? `"${shown}"` : shown;
}

function expand(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/** Windows' ssh may print a path with "/" for "\\", and Windows' paths ignore case. */
function samePath(a: string, b: string): boolean {
  const normal = (path: string) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
  return normal(a) === normal(b);
}
