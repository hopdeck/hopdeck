// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

/** Setting up key login on an SSH host: shapes shared by the server and the UI, and the checks behind them. */

/** Something on the host that keeps the key out. */
export interface KeyBlocker {
  /**
   * An sshd setting as `sshd -T` names it ("pubkeyauthentication",
   * "authenticationmethods", "permitrootlogin", "authorizedkeysfile",
   * "pubkeyacceptedalgorithms"), or "home" for the home directory.
   */
  setting: string;
  /** Its value; for "pubkeyacceptedalgorithms" the key's type, for "home" its mode and path. */
  value: string;
  /**
   * The line that lets keys in, when hopdeck may add it to sshd's
   * configuration: it allows keys and takes nothing away.
   */
  allow?: string;
}

/** What hopdeck found out about the SSH server over the password login. */
export interface KeyLoginCheck {
  /** Which server runs there; dropbear takes keys from authorized_keys, with nothing to switch on. */
  server: 'sshd' | 'dropbear' | 'unknown';
  /** Only for sshd: why its configuration for this login (sshd -T) could not be read, the raw message, e.g. of sudo. */
  reason?: string;
  blockers: KeyBlocker[];
}

/** How setting up key login on a host went. */
export interface KeySetupResult {
  /** The file on the host that holds the public key. */
  file: string;
  /** false: the key was there already. */
  added: boolean;
  /**
   * works: a new connection logged in with the key alone; unverified: the key
   * needs its passphrase, so hopdeck could not try it; refused: the host did
   * not take it, and `check` may say why.
   */
  outcome: 'works' | 'unverified' | 'refused';
  /** ssh's message when the host refused the key. */
  refusal?: string;
  check: KeyLoginCheck;
  /** After letting keys in: the lines hopdeck wrote, and whether sshd took them. */
  allowed?: {
    file: string;
    lines: string[];
    /** false: hopdeck put back what was there, for the reason in `why`. */
    applied: boolean;
    /**
     * no-directory: sshd has no sshd_config.d; invalid: sshd -t rejected the
     * file; unreadable: sshd -T failed; overridden: something else in sshd's
     * configuration wins; reload-failed: sshd would not reload.
     */
    why?: 'no-directory' | 'invalid' | 'unreadable' | 'overridden' | 'reload-failed' | 'unknown';
    /** The raw message; for "overridden", what sshd uses instead. */
    reason?: string;
  };
}

/** Where hopdeck puts the lines that let keys in; early in the order, since sshd takes the first value it reads. */
export const ALLOW_KEYS_FILE = '/etc/ssh/sshd_config.d/00-hopdeck-keys.conf';

export interface KeyLoginFacts {
  /** The account logging in is root. */
  root: boolean;
  /** The key's type as its public line starts, e.g. "ssh-ed25519". */
  keyType: string;
  /** Output of `sshd -T -C …` for this login, when hopdeck could read it. */
  sshd?: string | undefined;
  /** The home directory: its mode as ls prints it ("drwxr-xr-x"), its owner's uid, and the account's uid. */
  home?: { path: string; mode: string; owner: number; uid: number } | undefined;
}

/** Settings out of `sshd -T` output; sshd uses the first value of each, and so does this. */
export function sshdSettings(effective: string): Map<string, string> {
  const settings = new Map<string, string>();
  for (const line of effective.split('\n')) {
    const match = /^([a-z0-9]+) (.*)$/.exec(line.trim());
    if (match !== null && !settings.has(match[1]!)) settings.set(match[1]!, match[2]!.trim());
  }
  return settings;
}

/** What keeps a key out, as far as the facts tell. */
export function keyBlockers(facts: KeyLoginFacts): KeyBlocker[] {
  const blockers: KeyBlocker[] = [];
  const settings = facts.sshd === undefined ? new Map<string, string>() : sshdSettings(facts.sshd);

  if (settings.get('pubkeyauthentication') === 'no') {
    blockers.push({ setting: 'pubkeyauthentication', value: 'no', allow: 'PubkeyAuthentication yes' });
  }
  // Lists of methods, any one of which logs in; the key alone does when one list has nothing else.
  const methods = settings.get('authenticationmethods');
  if (methods !== undefined && methods !== 'any' && !methods.split(/\s+/).some((list) => list.split(',').every((method) => method.startsWith('publickey')))) {
    // One more list, of the key alone; every list there was still works.
    blockers.push({ setting: 'authenticationmethods', value: methods, allow: `AuthenticationMethods ${methods} publickey` });
  }
  const rootLogin = settings.get('permitrootlogin');
  if (facts.root && (rootLogin === 'no' || rootLogin === 'forced-commands-only')) {
    // Whether root may log in at all is the admin's decision, not hopdeck's.
    blockers.push({ setting: 'permitrootlogin', value: rootLogin });
  }
  const files = settings.get('authorizedkeysfile');
  if (files !== undefined && !files.split(/\s+/).some((file) => file === '.ssh/authorized_keys' || file === '%h/.ssh/authorized_keys')) {
    blockers.push({ setting: 'authorizedkeysfile', value: files });
  }
  const algorithms = settings.get('pubkeyacceptedalgorithms') ?? settings.get('pubkeyacceptedkeytypes');
  if (algorithms !== undefined && !acceptsKeyType(algorithms.split(','), facts.keyType)) {
    blockers.push({ setting: 'pubkeyacceptedalgorithms', value: facts.keyType });
  }
  // StrictModes: sshd ignores the keys of an account whose home others may write to.
  const home = facts.home;
  if (home !== undefined && settings.get('strictmodes') !== 'no') {
    const writable = home.mode[5] === 'w' || home.mode[8] === 'w';
    if (writable || (home.owner !== home.uid && home.owner !== 0)) blockers.push({ setting: 'home', value: `${home.mode} ${home.path}` });
  }
  return blockers;
}

/** An RSA key signs with rsa-sha2-256 or -512 as well as ssh-rsa. */
function acceptsKeyType(algorithms: string[], keyType: string): boolean {
  if (keyType === 'ssh-rsa') return algorithms.some((algorithm) => ['ssh-rsa', 'rsa-sha2-256', 'rsa-sha2-512'].includes(algorithm));
  return algorithms.includes(keyType);
}
