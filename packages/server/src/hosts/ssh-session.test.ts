// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionExecutor } from './ssh-session.ts';

/**
 * An ssh that runs the "remote" command here, counts its starts, and on
 * request refuses the login, prints what login scripts might, or prints one
 * line without end, as a hostile host could.
 */
const FAKE_SSH = `#!/bin/sh
echo start >> "$FAKE_DIR/starts"
while [ "$1" != "--" ]; do shift; done
shift 2
case "\${FAKE_MODE:-}" in
deny) echo 'admin@fw1: Permission denied (publickey).' >&2; exit 255 ;;
chatty) echo 'Welcome to fw1'; echo 'R 1 0 0' ;;
endless) head -c 1000000 /dev/zero | tr '\\0' x; sleep 5; exit 0 ;;
esac
exec sh -c "$1"
`;

// base64 where the host has it, hex where it does not (OpenWrt).
describe.each(['base64', 'hex'])('SessionExecutor, output in %s', (encoding) => {
  let dir: string;
  let ssh: string;
  const executor = (options: { env?: Record<string, string>; timeoutMs?: number; idleMs?: number } = {}) =>
    new SessionExecutor({
      destination: 'fw1',
      sshPath: ssh,
      env: { FAKE_DIR: dir, ...(encoding === 'hex' && { HOPDECK_SESSION_HEX: '1' }), ...options.env },
      timeoutMs: options.timeoutMs,
      idleMs: options.idleMs,
    });
  const starts = async () => (await readFile(join(dir, 'starts'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hopdeck-session-'));
    ssh = join(dir, 'ssh');
    await writeFile(ssh, FAKE_SSH);
    await chmod(ssh, 0o755);
  });

  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('runs many commands in one session, each with its own output, errors and exit code', async () => {
    const session = executor();
    const before = await starts();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => session.exec(['sh', '-c', `echo out ${index}; echo err ${index} >&2; exit ${index % 3}`])),
    );
    results.forEach((result, index) => expect(result).toEqual({ exitCode: index % 3, stdout: `out ${index}\n`, stderr: `err ${index}\n` }));
    expect(await starts()).toBe(before + 1);
    session.close();
  });

  it('carries any text both ways as it is', async () => {
    const session = executor();
    const texts = ['', '\n', 'no line break', 'one\n', 'two\nlines', '.\n|.\n.|\n', '\r\nwindows\r\n', 'zażółć 🔥\n', '\n\n\nblank lines\n\n'];
    for (const text of texts) {
      expect((await session.exec(['cat'], { stdin: text })).stdout).toBe(text);
      expect((await session.exec(['printf', '%s', text])).stdout).toBe(text);
    }
    const long = `${'x'.repeat(3_000_000)}\n`;
    expect((await session.exec(['cat'], { stdin: long })).stdout).toBe(long);
    session.close();
  });

  it('carries NUL bytes in what commands print, as hopdeck uses them to separate files', async () => {
    const session = executor();
    expect(await session.exec(['sh', '-c', "printf 'a\\0b\\0' ; printf 'e\\0' >&2"])).toEqual({ exitCode: 0, stdout: 'a\0b\0', stderr: 'e\0' });
    session.close();
  });

  it('runs commands in the home directory, and never writes their input to disk', async () => {
    const session = executor();
    expect((await session.exec(['pwd'])).stdout).toBe(`${homedir()}\n`);
    // A sudo password goes this way: through a pipe, while the command runs.
    const seen = await session.exec(['sh', '-c', 'read -r secret; ls "$D"; echo "got $secret"'], { stdin: 'the password\n' });
    expect(seen.stdout).toContain('got the password');
    expect(seen.stdout.split('\n')).not.toContain('in');
    session.close();
  });

  it('leaves commands the umask of the login, so the files they make are as without a session', async () => {
    const session = executor();
    const login = execFileSync('sh', ['-c', 'umask'], { encoding: 'utf8' });
    expect((await session.exec(['sh', '-c', 'umask'])).stdout).toBe(login);
    expect((await session.exec(['sh', '-c', 'stat -c %a "$D"'])).stdout).toBe('700\n');
    session.close();
  });

  it('ignores what login scripts print before the session begins', async () => {
    const session = executor({ env: { FAKE_MODE: 'chatty' } });
    expect((await session.exec(['echo', 'fine'])).stdout).toBe('fine\n');
    session.close();
  });

  it('ends the session when the host prints a line without end, before this machine runs out of memory', async () => {
    await expect(executor({ env: { FAKE_MODE: 'endless' } }).exec(['true'])).rejects.toMatchObject({
      code: 'command-failed',
      detail: expect.stringContaining('a line of more than 65536 bytes'),
    });
  });

  it('says so when the host refuses the login, as SshExecutor does', async () => {
    await expect(executor({ env: { FAKE_MODE: 'deny' } }).exec(['true'])).rejects.toMatchObject({
      code: 'ssh-auth',
      detail: expect.stringContaining('Permission denied'),
    });
  });

  it('ends a session whose command hangs, and starts a new one for the next', async () => {
    const session = executor({ timeoutMs: 500 });
    const before = await starts();
    await expect(session.exec(['sleep', '5'])).rejects.toMatchObject({ code: 'timeout' });
    expect((await session.exec(['echo', 'again'])).stdout).toBe('again\n');
    expect(await starts()).toBe(before + 2);
    session.close();
  });

  it('ends an idle session, and starts a new one when needed', async () => {
    const session = executor({ idleMs: 100 });
    const before = await starts();
    await session.exec(['true']);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await session.exec(['true']);
    expect(await starts()).toBe(before + 2);
    session.close();
  });

  it('refuses a NUL byte, which awk cannot carry', async () => {
    await expect(executor().exec(['cat'], { stdin: 'a\0b' })).rejects.toMatchObject({ code: 'command-failed' });
  });
});
