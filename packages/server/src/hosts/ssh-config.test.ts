// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addIdentityToConfig } from './ssh-config.ts';

describe('addIdentityToConfig', () => {
  let dir: string;
  let key: string;
  const now = new Date('2026-10-01T12:00:00Z');
  const named = (config: string, destination: string) =>
    execFileSync('ssh', ['-F', config, '-G', '--', destination], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.startsWith('identityfile '));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hopdeck-config-'));
    key = join(dir, 'id_ed25519_hopdeck');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('adds a Host block at the end, keeps the file as it was, and ssh offers the key', async () => {
    const config = join(dir, 'config');
    const before = 'Host serwer1\n    HostName 198.51.100.7\n    IdentityFile ~/.ssh/old\n    IdentitiesOnly yes\n';
    await writeFile(config, before, { mode: 0o600 });
    const added = await addIdentityToConfig({ configFile: config, destination: 'serwer1', identityFile: key, now });
    expect(added).toEqual({
      file: config,
      backup: `${config}.hopdeck-backup`,
      block: `# Added by hopdeck on 2026-10-01: the key for serwer1.\nHost serwer1\n    IdentityFile ${key}\n`,
    });
    expect(await readFile(config, 'utf8')).toBe(`${before}\n${added.block}`);
    expect(await readFile(`${config}.hopdeck-backup`, 'utf8')).toBe(before);
    // IdentityFile adds up: the old key stays, the new one comes along.
    expect(named(config, 'serwer1')).toEqual(expect.arrayContaining([`identityfile ${key}`, expect.stringContaining('/.ssh/old')]));
  });

  it('makes a config that is not there yet, private, and matches the host without the user', async () => {
    const config = join(dir, 'new', 'config');
    const added = await addIdentityToConfig({ configFile: config, destination: 'root@10.0.0.1', identityFile: key, now });
    expect(added.backup).toBeUndefined();
    expect((await stat(config)).mode & 0o777).toBe(0o600);
    expect(named(config, 'root@10.0.0.1')).toContain(`identityfile ${key}`);
  });

  it('puts the file back when ssh does not take it', async () => {
    const config = join(dir, 'config');
    const broken = 'Host serwer1\n    NoSuchOption yes\n';
    await writeFile(config, broken);
    await expect(addIdentityToConfig({ configFile: config, destination: 'serwer1', identityFile: key, now })).rejects.toThrow(/is as it was/);
    expect(await readFile(config, 'utf8')).toBe(broken);
  });
});
