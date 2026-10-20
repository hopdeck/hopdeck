// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { platform, type HostFacts } from '@hopdeck/core';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DeployTarget } from '../firewall/deploy.ts';
import { collectFacts } from '../hosts/facts.ts';
import { detectPrivilege } from '../hosts/privilege.ts';
import { SessionExecutor, sshSessionsWanted } from '../hosts/ssh-session.ts';
import { SshExecutor } from '../hosts/ssh.ts';

export type Account = 'root' | 'admin' | 'nopass' | 'plain';

/** A test host started by dev/test-host/up.sh (a container) or dev/vm-host/up.sh (a VM), as its host.json describes it. */
export interface TestHost {
  /** debian11, debian12, debian13, alma9, alma10, alpine or openwrt; openwrt24 too as a VM. */
  system: string;
  /** Where its sshd listens: 127.0.0.1 for a container, the VM's own address for dev/vm-host. */
  address: string;
  port: number;
  /** What starts the services there. */
  init: 'systemd' | 'openrc' | 'procd';
  platform: 'linux' | 'openwrt';
  accounts: Account[];
  /** Whether the accounts with a password may log in with it, for the key setup; a VM takes keys only. */
  passwords: boolean;
  /** A VM of dev/vm-host, with a kernel of its own that logs packets and forwards them; a container has neither. */
  vmid?: number;
  /** The router of dev/vm-host/router.sh: the client behind it, reached as hopdeck-test-client. */
  client?: { address: string; vmid: number };
  dir: string;
  sshConfig: string;
  /** The test key, the same for every system. */
  key: string;
}

const repo = resolve(import.meta.dirname, '../../../..');

/**
 * The host the host tests run against: HOPDECK_TEST_HOST=1 turns them on, and
 * HOPDECK_TEST_HOST_DIR picks the system (default .dev/test-host/debian13).
 * Undefined, and those tests skipped, without HOPDECK_TEST_HOST.
 */
export const testHost: TestHost | undefined = load();

function load(): TestHost | undefined {
  if (!process.env['HOPDECK_TEST_HOST']) return undefined;
  const dir = resolve(process.env['HOPDECK_TEST_HOST_DIR'] ?? join(repo, '.dev/test-host/debian13'));
  const file = join(dir, 'host.json');
  // Asked for host tests, so no host is an error, not a reason to skip them quietly.
  if (!existsSync(file)) throw new Error(`HOPDECK_TEST_HOST is set, but ${file} is missing; start the host with dev/test-host/up.sh or dev/vm-host/up.sh`);
  const described = JSON.parse(readFileSync(file, 'utf8')) as Omit<TestHost, 'dir' | 'sshConfig' | 'key' | 'address' | 'passwords'> & Partial<Pick<TestHost, 'address' | 'passwords'>>;
  return {
    ...described,
    address: described.address ?? '127.0.0.1',
    passwords: described.passwords ?? true,
    dir,
    sshConfig: join(dir, 'ssh_config'),
    key: join(repo, '.dev/test-host/id_ed25519'),
  };
}

export function hasAccount(account: Account): boolean {
  return testHost?.accounts.includes(account) ?? false;
}

/**
 * A deployment target for an account of the test host, built the way the
 * panel builds one: from the host's facts and the privilege it detects.
 */
export async function hostTarget(account: Account, controlDir: string): Promise<DeployTarget & { facts: HostFacts }> {
  const host = testHost!;
  const destination = `hopdeck-test-${account}`;
  // HOPDECK_SSH_SESSIONS=1 runs the same tests through the sessions hopdeck uses on Windows.
  const executor = sshSessionsWanted()
    ? new SessionExecutor({ destination, configFile: host.sshConfig })
    : new SshExecutor({ destination, controlDir, configFile: host.sshConfig });
  const facts = await collectFacts(executor);
  const privilege = await detectPrivilege(executor, facts);
  return {
    hostId: destination,
    name: destination,
    kind: 'ssh',
    executor,
    access: { executor, nftPath: facts.nft!.path, privilege, ...(privilege.kind === 'sudo-password' && { password: 'hopdeck-test' }) },
    platform: platform(facts.platform),
    systemd: facts.systemd,
    manualOverride: false,
    freshExecutor: new SshExecutor({ destination, controlDir, configFile: host.sshConfig, shareConnection: false }),
    facts,
  };
}
