import type { HostFacts, HostStatus, HostSummary } from '@hopdeck/core';
import { describe, expect, it } from 'vitest';
import { hostStatus } from './status.ts';

const facts: HostFacts = {
  uid: 1000,
  user: 'admin',
  hostname: 'fw1',
  kernel: '6.1.0',
  os: undefined,
  systemd: true,
  nft: { path: '/usr/sbin/nft', version: '1.0.6' },
};

const host = (status: HostStatus): HostSummary => ({ id: 'h', kind: 'ssh', name: 'fw1', destination: 'fw1', status, manualOverride: false });
const connected = (privilege: Extract<HostStatus, { state: 'connected' }>['privilege'], passwordStored = false) =>
  host({ state: 'connected', facts, privilege, passwordStored });

describe('hostStatus', () => {
  it('shows progress while connecting', () => {
    expect(hostStatus(host({ state: 'new' }), true)).toEqual({ tone: 'busy', label: 'status.connecting' });
    expect(hostStatus(host({ state: 'new' }), false).tone).toBe('neutral');
  });

  it('is green only when nft can run as root', () => {
    expect(hostStatus(connected({ kind: 'root' }), false).tone).toBe('ok');
    expect(hostStatus(connected({ kind: 'sudo' }), false).tone).toBe('ok');
    expect(hostStatus(connected({ kind: 'sudo-password' }), false)).toEqual({ tone: 'warn', label: 'status.locked' });
    expect(hostStatus(connected({ kind: 'sudo-password' }, true), false).tone).toBe('ok');
    expect(hostStatus(connected({ kind: 'none', reason: 'sudo-not-allowed', detail: '' }), false).tone).toBe('warn');
  });

  it('is red on errors and without nftables', () => {
    const failed = host({ state: 'error', error: { code: 'ssh-auth', detail: '' } });
    expect(hostStatus(failed, false).tone).toBe('danger');
    const noNft = host({ state: 'connected', facts: { ...facts, nft: undefined }, privilege: { kind: 'root' }, passwordStored: false });
    expect(hostStatus(noNft, false)).toEqual({ tone: 'danger', label: 'status.nftMissing' });
  });
});
