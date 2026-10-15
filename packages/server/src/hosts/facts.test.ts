// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { release, userInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { DEBIAN_FACTS } from '../testing/fake-executor.ts';
import { HostError } from './errors.ts';
import { collectFacts, parseFacts } from './facts.ts';
import { LocalExecutor } from './local.ts';

describe('parseFacts', () => {
  it('reads a typical host', () => {
    expect(parseFacts(DEBIAN_FACTS)).toEqual({
      uid: 1000,
      user: 'admin',
      hostname: 'fw1',
      kernel: '6.1.0-18-amd64',
      os: { id: 'debian', version: '12', name: 'Debian GNU/Linux 12 (bookworm)' },
      platform: 'linux',
      systemd: true,
      nft: { path: '/usr/sbin/nft', version: '1.0.6' },
    });
  });

  it('copes with missing os-release and nft', () => {
    const facts = parseFacts('uid=0\nhostname=box\nkernel=5.10.0\nsystemd=no\n');
    expect(facts).toMatchObject({ uid: 0, os: undefined, systemd: false, nft: undefined });
  });

  it('recognises OpenWrt and its derivatives', () => {
    expect(parseFacts('uid=0\nos_id=openwrt\nopenwrt=yes\nsystemd=no\n').platform).toBe('openwrt');
    expect(parseFacts('uid=0\nos_id=immortalwrt\nopenwrt=yes\nsystemd=no\n').platform).toBe('openwrt');
    expect(parseFacts('uid=0\nos_id=debian\nsystemd=yes\n').platform).toBe('linux');
  });

  it('rejects output without a uid', () => {
    expect(() => parseFacts('Welcome to our server!\n')).toThrow(HostError);
  });
});

describe('collectFacts', () => {
  it('runs on this machine', async () => {
    const facts = await collectFacts(new LocalExecutor());
    expect(facts.uid).toBe(process.getuid!());
    expect(facts.user).toBe(userInfo().username);
    expect(facts.kernel).toBe(release());
  });
});
