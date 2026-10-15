// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { createHash } from 'node:crypto';
import type { ExecResult } from '@hopdeck/core';
import { HostError } from './errors.ts';
import { runAsRoot, type NftAccess } from './privilege.ts';

/**
 * Where a deployment or a trace keeps its files on the host: nft input, the
 * watchdog script, logs. Root reads and runs these files, so whoever can change
 * them can act as root.
 *
 * Under sudo with a password, the password is what keeps the login user from
 * root. A directory of that user would let any process of theirs swap
 * watchdog.sh or change.nft between hopdeck writing and root using it, root
 * without the password. There the directory belongs to root, and every file
 * gets in through a copy root makes and checks against the SHA-256 hopdeck
 * computed. Everywhere else the user can become root anyway (root login,
 * passwordless sudo) or root never runs their files (sudo for nft only, where
 * the watchdog runs as the user), so the user's own directory is enough.
 */
export interface Staging {
  dir: string;
  /** The directory is root's: reach it through sudo. */
  asRoot: boolean;
}

export interface StagingTarget {
  executor: NftAccess['executor'];
  access: NftAccess;
}

// Left behind when hopdeck stopped before it could clean up; kept a day for a look at the logs.
const MAKE_DIRECTORY =
  'base="${TMPDIR:-/tmp}"; find "$base" -maxdepth 1 -name "hopdeck.*" -user "$(id -u)" -mtime +0 -exec rm -rf {} + 2>/dev/null; umask 077; mktemp -d "$base/hopdeck.XXXXXX"';

export async function makeStaging(target: StagingTarget): Promise<Staging> {
  const asRoot = target.access.privilege.kind === 'sudo-password';
  // root's TMPDIR is not the user's; /tmp is where both look.
  const made = asRoot ? await runAsRoot(target.access, ['env', 'TMPDIR=/tmp', 'sh', '-c', MAKE_DIRECTORY]) : await target.executor.exec(['sh', '-c', MAKE_DIRECTORY]);
  if (made.exitCode !== 0) throw new HostError('command-failed', made.stderr.trim());
  return { dir: made.stdout.trim(), asRoot };
}

/** Runs a command on the staging directory with the rights it needs. */
export function inStaging(target: StagingTarget, staging: Staging, argv: readonly string[]): Promise<ExecResult> {
  return staging.asRoot ? runAsRoot(target.access, argv) : target.executor.exec(argv);
}

export async function stageFile(target: StagingTarget, staging: Staging, name: string, content: string): Promise<void> {
  const path = `${staging.dir}/${name}`;
  if (!staging.asRoot) {
    const written = await target.executor.exec(['sh', '-c', 'umask 077; cat > "$1"', 'sh', path], { stdin: content });
    if (written.exitCode !== 0) throw new HostError('command-failed', written.stderr.trim());
    return;
  }
  await copyAsRoot(target, content, path);
}

/**
 * Shell function for root: `copy SOURCE SHA256 DESTINATION` puts the source in
 * place only when its SHA-256 is the one given, so a file the login user swapped
 * in after hopdeck wrote it fails the check and nothing is written.
 */
export const VERIFIED_COPY = `copy() {
	cp -- "$1" "$3.hopdeck-new" || return 1
	if ! echo "$2  $3.hopdeck-new" | sha256sum -c >/dev/null 2>&1; then
		rm -f "$3.hopdeck-new"
		echo "the file changed while it was copied; nothing was written" >&2
		return 1
	fi
	mv -f "$3.hopdeck-new" "$3"
}`;

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Writes each content to a private temporary file of the login user, for root to copy; see VERIFIED_COPY. */
export async function userTemporaries(target: StagingTarget, contents: readonly string[]): Promise<string[]> {
  const paths: string[] = [];
  try {
    for (const content of contents) {
      const made = await target.executor.exec(['sh', '-c', 'umask 077; f=$(mktemp "${TMPDIR:-/tmp}/hopdeck-copy.XXXXXX") && cat > "$f" && echo "$f"'], {
        stdin: content,
      });
      if (made.exitCode !== 0) throw new HostError('command-failed', made.stderr.trim());
      paths.push(made.stdout.trim());
    }
  } catch (error) {
    await removeTemporaries(target, paths).catch(() => undefined);
    throw error;
  }
  return paths;
}

export async function removeTemporaries(target: StagingTarget, paths: readonly string[]): Promise<void> {
  if (paths.length > 0) await target.executor.exec(['rm', '-f', '--', ...paths]);
}

/**
 * Puts content into a file only root can change: the login user writes a
 * private temporary file, root copies it and checks the copy's SHA-256 before
 * it takes the file's place. A file swapped in between fails the check.
 */
export async function copyAsRoot(target: StagingTarget, content: string, path: string, mode = '600'): Promise<void> {
  const [source] = await userTemporaries(target, [content]);
  const copy = [VERIFIED_COPY, 'set -e', 'umask 077', 'mkdir -p "$(dirname "$2")"', 'copy "$1" "$3" "$2"', 'chmod "$4" "$2"'].join('\n');
  const copied = await runAsRoot(target.access, ['sh', '-c', copy, 'sh', source!, path, sha256(content), mode]);
  await removeTemporaries(target, [source!]);
  if (copied.exitCode !== 0) throw new HostError('command-failed', copied.stderr.trim() || `copying to ${path} failed with code ${copied.exitCode}`);
}

export async function removeStaging(target: StagingTarget, staging: Staging): Promise<void> {
  await inStaging(target, staging, ['rm', '-rf', '--', staging.dir]);
}
