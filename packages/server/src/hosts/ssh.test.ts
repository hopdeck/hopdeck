import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SshExecutor } from './ssh.ts';

// Stands in for ssh: records its arguments, then runs the remote command with
// sh, the way the remote login shell would.
const FAKE_SSH = `#!/bin/sh
printf '%s\\n' "$@" > "$0.args"
while [ "$1" != "--" ]; do shift; done
shift 2
exec sh -c "$1"
`;

describe('SshExecutor', () => {
  let dir: string;
  let sshPath: string;
  let ssh: SshExecutor;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nftm-ssh-'));
    sshPath = join(dir, 'ssh');
    await writeFile(sshPath, FAKE_SSH);
    await chmod(sshPath, 0o755);
    ssh = new SshExecutor({ destination: 'admin@fw1', controlDir: join(dir, 'control'), sshPath });
  });

  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('runs non-interactive ssh over a shared connection', async () => {
    await ssh.exec(['true']);
    const args = (await readFile(`${sshPath}.args`, 'utf8')).trimEnd().split('\n');
    expect(args).toEqual(expect.arrayContaining(['BatchMode=yes', 'ControlMaster=auto']));
    expect(args.find((arg) => arg.startsWith('ControlPath='))).toMatch(new RegExp(`^ControlPath=${join(dir, 'control')}/[0-9a-f]{32}$`));
    expect(args.slice(-3)).toEqual(['--', 'admin@fw1', 'true']);
  });

  it('delivers every argument to the remote program unchanged', async () => {
    const args = ['a b', "it's", '$(id)', 'new\nline', ''];
    const result = await ssh.exec(['printf', '[%s]', ...args]);
    expect(result.stdout).toBe('[a b][it\'s][$(id)][new\nline][]');
  });

  it('forwards standard input and exit codes', async () => {
    expect((await ssh.exec(['cat'], { stdin: 'flush ruleset\n' })).stdout).toBe('flush ruleset\n');
    expect((await ssh.exec(['sh', '-c', 'exit 7'])).exitCode).toBe(7);
  });

  it('gives every destination its own shared connection', async () => {
    const controlPath = async (destination: string, configFile?: string) => {
      await new SshExecutor({ destination, controlDir: dir, sshPath, configFile }).exec(['true']);
      return (await readFile(`${sshPath}.args`, 'utf8')).split('\n').find((arg) => arg.startsWith('ControlPath='));
    };
    // Two aliases of one server must not share a connection: the second would skip its host key check.
    expect(await controlPath('fw-a')).not.toBe(await controlPath('fw-b'));
    expect(await controlPath('fw-a')).toBe(await controlPath('fw-a'));
    expect(await controlPath('fw-a', '/other/config')).not.toBe(await controlPath('fw-a'));
  });

  it('uses another ssh config file when asked', async () => {
    const custom = new SshExecutor({ destination: 'fw1', controlDir: dir, sshPath, configFile: '/etc/nftm/ssh config' });
    await custom.exec(['true']);
    const args = (await readFile(`${sshPath}.args`, 'utf8')).trimEnd().split('\n');
    expect(args.slice(0, 2)).toEqual(['-F', '/etc/nftm/ssh config']);
  });

  it('refuses destinations that ssh would read as options', () => {
    for (const destination of ['-oProxyCommand=touch /tmp/pwned', '', 'a b']) {
      expect(() => new SshExecutor({ destination, controlDir: dir, sshPath })).toThrow(/invalid SSH destination/);
    }
    expect(() => new SshExecutor({ destination: 'fw1', controlDir: '/tmp/a%b', sshPath })).toThrow(/control directory/);
  });
});
