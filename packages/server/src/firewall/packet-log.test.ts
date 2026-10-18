// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { mkdtemp, rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { failed, FakeExecutor, ok } from '../testing/fake-executor.ts';
import { hasAccount, hostTarget, testHost } from '../testing/test-host.ts';
import { readPacketLog } from './packet-log.ts';

const LINE = 'drop: IN=eth0 OUT= SRC=192.0.2.1 DST=192.0.2.2 LEN=60 TOS=0x00 PREC=0x00 TTL=64 ID=1 DF PROTO=TCP SPT=40000 DPT=22 WINDOW=64240 RES=0x00 SYN URGP=0 ';
const journal = (cursor: string) => JSON.stringify({ __CURSOR: cursor, __REALTIME_TIMESTAMP: '1792060800000000', MESSAGE: LINE });

describe('readPacketLog', () => {
  it('reads the kernel log as root, and on from a cursor', async () => {
    const executor = new FakeExecutor((argv) => ok(`zone +0000\nboot 1\nsource journal\n${journal(argv.at(-1) === '' ? 's=1' : 's=2')}\n`));
    const access = { executor, nftPath: '/usr/sbin/nft', privilege: { kind: 'sudo' as const } };
    const first = await readPacketLog(access, undefined);
    expect(first).toMatchObject({ source: { kind: 'journal' }, complete: true, cursor: 's=1', entries: [{ prefix: 'drop: ', dport: 22 }] });
    expect(first.asUser).toBeUndefined();
    expect(executor.calls[0]!.argv.slice(0, 5)).toEqual(['env', 'LC_ALL=C', 'sudo', '-n', '--']);
    const next = await readPacketLog(access, 's=1');
    expect(next).toMatchObject({ complete: false, cursor: 's=2' });
    expect(executor.calls[1]!.argv.at(-1)).toBe('s=1');
  });

  it('reads with the login user\'s rights where sudo allows nft only, and says so', async () => {
    const executor = new FakeExecutor((argv) =>
      argv[0] === 'env'
        ? failed("Sorry, user admin is not allowed to execute '/bin/sh -c ...' as root on fw1.")
        : { exitCode: 0, stdout: 'zone +0000\nboot 1\nsource journal\n', stderr: 'No journal files were opened due to insufficient permissions.' },
    );
    const read = await readPacketLog({ executor, nftPath: '/usr/sbin/nft', privilege: { kind: 'sudo' } }, undefined);
    expect(read).toMatchObject({ asUser: true, entries: [], stderr: 'No journal files were opened due to insufficient permissions.' });
    expect(executor.calls.map((call) => call.argv[0])).toEqual(['env', 'sh']);
  });

  it('starts again from the newest when the journal no longer has the cursor', async () => {
    const executor = new FakeExecutor((argv) =>
      argv.at(-1) === 's=old' ? { exitCode: 1, stdout: 'zone +0000\nboot 1\nsource journal\n', stderr: 'Failed to seek to cursor: Invalid argument' } : ok(`source journal\n${journal('s=new')}\n`),
    );
    const read = await readPacketLog({ executor, nftPath: '/usr/sbin/nft', privilege: { kind: 'root' } }, 's=old');
    expect(read).toMatchObject({ complete: true, cursor: 's=new', entries: [{ prefix: 'drop: ' }] });
  });
});

// In a container the kernel writes no packets to the host's log, so these
// check that each system's source is found and read; the port forward test
// reads what a VM's kernel logs.
describe.skipIf(testHost === undefined || !hasAccount('root'))('readPacketLog on the test host', { timeout: 60_000 }, () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp('/tmp/hd-plog-');
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('finds the source the system logs to, and reads the lines in it', async () => {
    const target = await hostTarget('root', dir);
    const run = (script: string) => target.executor.exec(['sh', '-c', script]);
    if (testHost!.init === 'systemd') {
      const read = await readPacketLog(target.access, undefined);
      expect(read.source).toEqual({ kind: 'journal' });
      return;
    }
    if (testHost!.platform === 'openwrt') {
      const read = await readPacketLog(target.access, undefined);
      expect(read.source).toEqual({ kind: 'logread' });
      return;
    }
    // Without journald: a syslog file, as an OpenRC system with syslogd has.
    await run(`printf '%s\\n' 'Oct 16 10:00:00 fw1 kernel: [ 12.5] ${LINE}' >> /var/log/kern.log`);
    try {
      const read = await readPacketLog(target.access, undefined);
      expect(read.source).toEqual({ kind: 'file', path: '/var/log/kern.log' });
      expect(read.entries[0]).toMatchObject({ prefix: 'drop: ', src: '192.0.2.1', dport: 22, tcpFlags: ['SYN'] });
    } finally {
      await run('rm -f /var/log/kern.log');
    }
  });

  it.runIf(hasAccount('plain'))('reads as the login user an account that may not use sudo', async () => {
    const read = await readPacketLog((await hostTarget('plain', dir)).access, undefined);
    expect(read.asUser).toBe(true);
  });
});
