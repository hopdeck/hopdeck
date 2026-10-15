// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sandbox } from './sandbox.ts';

const NFT = ['/usr/sbin/nft', '/sbin/nft', '/usr/bin/nft'].find((path) => existsSync(path));
const USERNS = spawnSync('unshare', ['--user', '--map-root-user', '--net', 'true']).status === 0;

describe.skipIf(NFT === undefined || !USERNS)('Sandbox', () => {
  const nft = NFT!;
  let sandbox: Sandbox;
  let other: Sandbox;

  beforeAll(async () => {
    [sandbox, other] = await Promise.all([Sandbox.start(), Sandbox.start()]);
  });

  afterAll(async () => {
    await Promise.all([sandbox.dispose(), other.dispose()]);
  });

  it('is root inside', async () => {
    expect((await sandbox.executor.exec(['id', '-u'])).stdout).toBe('0\n');
  });

  it('keeps its own ruleset between commands, isolated from other sandboxes', async () => {
    const run = sandbox.executor;
    expect((await run.exec([nft, 'add', 'table', 'inet', 'hopdeck_test'])).exitCode).toBe(0);
    await sandbox.nft('add chain inet hopdeck_test input { type filter hook input priority 0; }\n');

    const listed = await run.exec([nft, '-j', 'list', 'ruleset']);
    const kinds = JSON.parse(listed.stdout).nftables.map((item: object) => Object.keys(item)[0]);
    expect(kinds).toEqual(['metainfo', 'table', 'chain']);

    expect((await other.executor.exec([nft, 'list', 'tables'])).stdout).toBe('');
  });

  it('disappears when disposed', async () => {
    const temporary = await Sandbox.start();
    const pid = temporary.pid;
    expect(existsSync(`/proc/${pid}`)).toBe(true);
    await temporary.dispose();
    expect(existsSync(`/proc/${pid}`)).toBe(false);
  });
});
