import type { ExecOptions, ExecResult, Executor, HostFacts, Privilege } from '@nftm/core';
import { HostError } from './errors.ts';

// sudo's messages are localized; nftm parses them, so it asks for English.
const SUDO = ['env', 'LC_ALL=C', 'sudo'];

// "tenir is not in the sudoers file.", "Sorry, user tenir is not allowed to
// execute '/usr/sbin/nft --version' as root on fw1.", "Sorry, user tenir may
// not run sudo on fw1."
const SUDO_REFUSED = /is not in the sudoers file|is not allowed to execute|may not run sudo/;
const WRONG_PASSWORD = /incorrect password|Sorry, try again|no password was provided/;

/**
 * Tries nft itself rather than `sudo true`: a sudoers rule may allow nft without
 * a password while everything else needs one.
 *
 * sudo asks for the password before it checks sudoers, so a user who may not use
 * sudo at all first looks like `sudo-password`; runNft() reports the refusal once
 * the password is known.
 */
export async function detectPrivilege(executor: Executor, facts: HostFacts): Promise<Privilege> {
  if (facts.uid === 0) return { kind: 'root' };
  if (facts.nft === undefined) return { kind: 'none', reason: 'nft-missing', detail: 'nft not found' };

  let probe: ExecResult;
  try {
    probe = await executor.exec([...SUDO, '-n', '--', facts.nft.path, '--version']);
  } catch (error) {
    if (error instanceof HostError && error.code === 'spawn-failed') {
      return { kind: 'none', reason: 'sudo-missing', detail: error.detail };
    }
    throw error;
  }
  if (probe.exitCode === 0) return { kind: 'sudo' };
  if (/a password is required/.test(probe.stderr)) return { kind: 'sudo-password' };

  const detail = probe.stderr.trim() || `sudo exited with ${probe.exitCode}`;
  if (SUDO_REFUSED.test(probe.stderr)) return { kind: 'none', reason: 'sudo-not-allowed', detail };
  // 127: the shell or env could not find sudo.
  if (probe.exitCode === 127) return { kind: 'none', reason: 'sudo-missing', detail };
  return { kind: 'none', reason: 'other', detail };
}

export interface NftAccess {
  executor: Executor;
  nftPath: string;
  privilege: Privilege;
  /** Only for `sudo-password`; kept in memory, never written anywhere. */
  password?: string | undefined;
}

/**
 * Runs nft as root on the host, using whatever privilege the host offers.
 * Failures of sudo itself throw a HostError, so a non-zero result is nft's own.
 */
export async function runNft(access: NftAccess, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
  const { executor, nftPath, privilege, password } = access;
  switch (privilege.kind) {
    case 'root':
      return executor.exec([nftPath, ...args], options);
    case 'sudo':
      return checkSudo(await executor.exec([...SUDO, '-n', '--', nftPath, ...args], options));
    case 'sudo-password': {
      if (password === undefined) throw new HostError('password-required');
      // The password is the first line of stdin. Mixed with a ruleset, it could
      // end up in an nft error message, so rulesets go through files instead.
      if (options.stdin !== undefined) throw new Error('nft input cannot be piped under sudo -S; upload a file');
      const result = await executor.exec([...SUDO, '-S', '-p', '', '--', nftPath, ...args], { stdin: `${password}\n` });
      if (result.exitCode !== 0 && WRONG_PASSWORD.test(result.stderr)) {
        throw new HostError('wrong-password', result.stderr.trim());
      }
      return checkSudo(result);
    }
    case 'none':
      throw new HostError('no-privileges', privilege.detail);
  }
}

function checkSudo(result: ExecResult): ExecResult {
  if (result.exitCode !== 0 && SUDO_REFUSED.test(result.stderr)) {
    throw new HostError('sudo-not-allowed', result.stderr.trim());
  }
  return result;
}
