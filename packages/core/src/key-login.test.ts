// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import { keyBlockers, sshdSettings } from './key-login.ts';

/** sshd -T output as a default Debian sshd prints it, in part, with `changes` in their place. */
function sshd(changes: Record<string, string> = {}): string {
  const settings: Record<string, string> = {
    port: '22',
    pubkeyauthentication: 'yes',
    authenticationmethods: 'any',
    permitrootlogin: 'prohibit-password',
    strictmodes: 'yes',
    authorizedkeysfile: '.ssh/authorized_keys .ssh/authorized_keys2',
    pubkeyacceptedalgorithms: 'ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-512,rsa-sha2-256',
    ...changes,
  };
  return Object.entries(settings)
    .map(([key, value]) => `${key} ${value}`)
    .join('\n');
}

const home = { path: '/home/admin', mode: 'drwxr-xr-x', owner: 1000, uid: 1000 };

describe('sshdSettings', () => {
  it('takes the first value of a setting, as sshd does', () => {
    expect(sshdSettings('port 22\nport 2222\nsubsystem sftp /usr/lib/sftp-server\n').get('port')).toBe('22');
  });
});

describe('keyBlockers', () => {
  it('finds nothing where keys are allowed, as by default', () => {
    expect(keyBlockers({ root: true, keyType: 'ssh-ed25519', sshd: sshd(), home })).toEqual([]);
    expect(keyBlockers({ root: false, keyType: 'ssh-rsa', sshd: sshd({ authenticationmethods: 'publickey,password publickey' }), home })).toEqual([]);
    expect(keyBlockers({ root: false, keyType: 'ssh-ed25519' })).toEqual([]);
  });

  it('lets keys in without taking anything away: passwords go on working', () => {
    expect(keyBlockers({ root: false, keyType: 'ssh-ed25519', sshd: sshd({ pubkeyauthentication: 'no', authenticationmethods: 'password' }) })).toEqual([
      { setting: 'pubkeyauthentication', value: 'no', allow: 'PubkeyAuthentication yes' },
      { setting: 'authenticationmethods', value: 'password', allow: 'AuthenticationMethods password publickey' },
    ]);
    // A key and a password together: the key alone becomes one more way in.
    expect(keyBlockers({ root: false, keyType: 'ssh-ed25519', sshd: sshd({ authenticationmethods: 'publickey,password' }) })).toEqual([
      { setting: 'authenticationmethods', value: 'publickey,password', allow: 'AuthenticationMethods publickey,password publickey' },
    ]);
  });

  it('only reports what is the admin\'s decision: root login, key files, key types, the home directory', () => {
    const blockers = keyBlockers({
      root: true,
      keyType: 'ssh-rsa',
      sshd: sshd({ permitrootlogin: 'no', authorizedkeysfile: '/etc/ssh/keys/%u', pubkeyacceptedalgorithms: 'ssh-ed25519' }),
      home: { ...home, mode: 'drwxrwxr-x' },
    });
    expect(blockers).toEqual([
      { setting: 'permitrootlogin', value: 'no' },
      { setting: 'authorizedkeysfile', value: '/etc/ssh/keys/%u' },
      { setting: 'pubkeyacceptedalgorithms', value: 'ssh-rsa' },
      { setting: 'home', value: 'drwxrwxr-x /home/admin' },
    ]);
    expect(blockers.every((blocker) => blocker.allow === undefined)).toBe(true);
  });

  it('knows root may log in with a key under prohibit-password, and others whatever root login says', () => {
    expect(keyBlockers({ root: true, keyType: 'ssh-ed25519', sshd: sshd({ permitrootlogin: 'without-password' }) })).toEqual([]);
    expect(keyBlockers({ root: false, keyType: 'ssh-ed25519', sshd: sshd({ permitrootlogin: 'no' }) })).toEqual([]);
  });

  it('checks the home directory as StrictModes does, and not when it is off', () => {
    const someoneElses = { ...home, owner: 1001 };
    expect(keyBlockers({ root: false, keyType: 'ssh-ed25519', sshd: sshd(), home: someoneElses })).toEqual([{ setting: 'home', value: 'drwxr-xr-x /home/admin' }]);
    expect(keyBlockers({ root: false, keyType: 'ssh-ed25519', sshd: sshd({ strictmodes: 'no' }), home: someoneElses })).toEqual([]);
    // Without sshd's configuration, the home directory still counts: StrictModes is on by default.
    expect(keyBlockers({ root: false, keyType: 'ssh-ed25519', home: { ...home, mode: 'drwxrwxrwx' } })).toHaveLength(1);
  });
});
