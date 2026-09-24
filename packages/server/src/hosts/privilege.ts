import type { ExecOptions, ExecResult, Executor } from '@nftm/core';
import { HostError } from './errors.ts';
import type { HostFacts } from './facts.ts';

/** How nft gets root on a host. */
export type Privilege =
  | { kind: 'root' }
  | { kind: 'sudo' }
  | { kind: 'sudo-password' }
  | { kind: 'none'; detail: string };

// sudo's messages are localized; nftm parses them, so it asks for English.
const SUDO = ['env', 'LC_ALL=C', 'sudo'];

/**
 * Tries nft itself rather than `sudo true`: a sudoers rule may allow nft without
 * a password while everything else needs one.
 */
export async function detectPrivilege(executor: Executor, facts: HostFacts): Promise<Privilege> {
  if (facts.uid === 0) return { kind: 'root' };
  if (facts.nft === undefined) return { kind: 'none', detail: 'nft not found' };

  let probe: ExecResult;
  try {
    probe = await executor.exec([...SUDO, '-n', '--', facts.nft.path, '--version']);
  } catch (error) {
    if (error instanceof HostError && error.code === 'spawn-failed') return { kind: 'none', detail: 'sudo not found' };
    throw error;
  }
  if (probe.exitCode === 0) return { kind: 'sudo' };
  if (/a password is required/.test(probe.stderr)) return { kind: 'sudo-password' };
  return { kind: 'none', detail: probe.stderr.trim() || `sudo exited with ${probe.exitCode}` };
}

export interface NftAccess {
  executor: Executor;
  nftPath: string;
  privilege: Privilege;
  /** Only for `sudo-password`; kept in memory, never written anywhere. */
  password?: string | undefined;
}

/** Runs nft as root on the host, using whatever privilege the host offers. */
export async function runNft(access: NftAccess, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
  const { executor, nftPath, privilege, password } = access;
  switch (privilege.kind) {
    case 'root':
      return executor.exec([nftPath, ...args], options);
    case 'sudo':
      return executor.exec([...SUDO, '-n', '--', nftPath, ...args], options);
    case 'sudo-password': {
      if (password === undefined) throw new HostError('password-required');
      // The password is the first line of stdin. Mixed with a ruleset, it could
      // end up in an nft error message, so rulesets go through files instead.
      if (options.stdin !== undefined) throw new Error('nft input cannot be piped under sudo -S; upload a file');
      const result = await executor.exec([...SUDO, '-S', '-p', '', '--', nftPath, ...args], { stdin: `${password}\n` });
      if (result.exitCode !== 0 && /incorrect password|Sorry, try again|no password was provided/.test(result.stderr)) {
        throw new HostError('wrong-password');
      }
      return result;
    }
    case 'none':
      throw new HostError('no-privileges', privilege.detail);
  }
}
