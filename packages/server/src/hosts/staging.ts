import { createHash } from 'node:crypto';
import type { ExecResult } from '@nftm/core';
import { HostError } from './errors.ts';
import { runAsRoot, type NftAccess } from './privilege.ts';

/**
 * Where a deployment or a trace keeps its files on the host: nft input, the
 * watchdog script, logs. Root reads and runs these files, so whoever can change
 * them can act as root.
 *
 * Under sudo with a password, the password is what keeps the login user from
 * root. A directory of that user would let any process of theirs swap
 * watchdog.sh or change.nft between nftm writing and root using it, root
 * without the password. There the directory belongs to root, and every file
 * gets in through a copy root makes and checks against the SHA-256 nftm
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

// Left behind when nftm stopped before it could clean up; kept a day for a look at the logs.
const MAKE_DIRECTORY =
  'base="${TMPDIR:-/tmp}"; find "$base" -maxdepth 1 -name "nftm.*" -user "$(id -u)" -mtime +0 -exec rm -rf {} + 2>/dev/null; umask 077; mktemp -d "$base/nftm.XXXXXX"';

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
 * Puts content into a file only root can change: the login user writes a
 * private temporary file, root copies it and checks the copy's SHA-256 before
 * it takes the file's place. A file swapped in between fails the check.
 */
export async function copyAsRoot(target: StagingTarget, content: string, path: string, mode = '600'): Promise<void> {
  const temporary = await target.executor.exec(['sh', '-c', 'umask 077; f=$(mktemp "${TMPDIR:-/tmp}/nftm-copy.XXXXXX") && cat > "$f" && echo "$f"'], { stdin: content });
  if (temporary.exitCode !== 0) throw new HostError('command-failed', temporary.stderr.trim());
  const source = temporary.stdout.trim();
  const sha256 = createHash('sha256').update(content).digest('hex');
  const copy = [
    'set -e',
    'umask 077',
    'mkdir -p "$(dirname "$2")"',
    'cp -- "$1" "$2.nftm-new"',
    'if ! echo "$3  $2.nftm-new" | sha256sum -c >/dev/null 2>&1; then rm -f "$2.nftm-new"; echo "the file changed while it was copied; nothing was written" >&2; exit 1; fi',
    'chmod "$4" "$2.nftm-new"',
    'mv -f "$2.nftm-new" "$2"',
  ].join('\n');
  const copied = await runAsRoot(target.access, ['sh', '-c', copy, 'sh', source, path, sha256, mode]);
  await target.executor.exec(['rm', '-f', '--', source]);
  if (copied.exitCode !== 0) throw new HostError('command-failed', copied.stderr.trim() || `copying to ${path} failed with code ${copied.exitCode}`);
}

export async function removeStaging(target: StagingTarget, staging: Staging): Promise<void> {
  await inStaging(target, staging, ['rm', '-rf', '--', staging.dir]);
}
