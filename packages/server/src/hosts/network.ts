// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { NETWORK_COMMAND, parseNetwork, parseRoute, ROUTE_COMMAND, type Executor, type HostNetwork, type HostRoute } from '@hopdeck/core';
import { HostError } from './errors.ts';
import { journal } from './journal.ts';
import { runAsRoot, type NftAccess } from './privilege.ts';
import { copyAsRoot } from './staging.ts';

/** The host's interfaces, addresses and whether it forwards. No root needed. */
export async function readNetwork(executor: Executor): Promise<HostNetwork> {
  const result = await executor.exec(['sh', '-c', NETWORK_COMMAND]);
  if (!result.stdout.includes('--- addr')) throw new HostError('command-failed', result.stderr.trim() || `reading the interfaces failed with code ${result.exitCode}`);
  return parseNetwork(result.stdout);
}

/** Where the host sends packets for `to`, or why it cannot. */
export async function readRoute(executor: Executor, to: string): Promise<HostRoute & { problem?: string }> {
  const result = await executor.exec(['sh', '-c', ROUTE_COMMAND, 'sh', to]);
  if (result.exitCode !== 0) return { problem: result.stderr.trim() || `ip route get exited with code ${result.exitCode}` };
  return parseRoute(result.stdout);
}

/** Where hopdeck keeps forwarding on across reboots. */
export const FORWARDING_FILE = '/etc/sysctl.d/90-hopdeck-forwarding.conf';

const KEYS = { ip: 'net.ipv4.ip_forward', ip6: 'net.ipv6.conf.all.forwarding' } as const;

/**
 * Turns on forwarding for IPv4 or IPv6 now, as root, and with `persist` at
 * boot too, in FORWARDING_FILE, keeping what hopdeck put there before. This
 * is no nftables change: no rollback covers it, and the system log notes it.
 */
export async function enableForwarding(target: { executor: Executor; access: NftAccess }, version: 'ip' | 'ip6', persist: boolean): Promise<HostNetwork> {
  const key = KEYS[version];
  const set = await runAsRoot(target.access, ['sh', '-c', 'echo 1 > "$1"', 'sh', `/proc/sys/${key.replaceAll('.', '/')}`]);
  if (set.exitCode !== 0) throw new HostError('command-failed', set.stderr.trim() || `setting ${key} failed with code ${set.exitCode}`);
  if (persist) {
    const current = await runAsRoot(target.access, ['sh', '-c', 'cat "$1" 2>/dev/null || :', 'sh', FORWARDING_FILE]);
    const settings = new Set(current.stdout.split('\n').map((line) => line.trim()).filter((line) => /^net\.[\w.]+ = 1$/.test(line)));
    settings.add(`${key} = 1`);
    const content = `# Written by hopdeck: this host forwards packets between its interfaces, as port forwards need.\n${[...settings].sort().join('\n')}\n`;
    await copyAsRoot(target, content, FORWARDING_FILE, '644');
  }
  await journal(target.executor, `turned on ${key}${persist ? `, at boot too (${FORWARDING_FILE})` : ', until the next boot'}`);
  return readNetwork(target.executor);
}
