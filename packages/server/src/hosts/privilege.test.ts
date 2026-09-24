import type { Privilege } from '@nftm/core';
import { describe, expect, it } from 'vitest';
import { DEBIAN_FACTS, FakeExecutor, failed, ok } from '../testing/fake-executor.ts';
import { HostError } from './errors.ts';
import { parseFacts } from './facts.ts';
import { detectPrivilege, runNft } from './privilege.ts';

const facts = parseFacts(DEBIAN_FACTS);
const NFT = '/usr/sbin/nft';

describe('detectPrivilege', () => {
  it('needs no sudo for root', async () => {
    const executor = new FakeExecutor(() => new Error('must not run'));
    expect(await detectPrivilege(executor, { ...facts, uid: 0 })).toEqual({ kind: 'root' });
  });

  it('probes sudo with nft itself, in the C locale', async () => {
    const executor = new FakeExecutor(() => ok('nftables v1.0.6'));
    expect(await detectPrivilege(executor, facts)).toEqual({ kind: 'sudo' });
    expect(executor.calls[0]?.argv).toEqual(['env', 'LC_ALL=C', 'sudo', '-n', '--', NFT, '--version']);
  });

  it('tells a password prompt from a refusal', async () => {
    const asking = new FakeExecutor(() => failed('sudo: a password is required\n'));
    expect(await detectPrivilege(asking, facts)).toEqual({ kind: 'sudo-password' });

    const refusing = new FakeExecutor(() => failed('admin is not in the sudoers file.\n'));
    expect(await detectPrivilege(refusing, facts)).toEqual({ kind: 'none', detail: 'admin is not in the sudoers file.' });

    const noNft = new FakeExecutor(() => new Error('must not run'));
    expect((await detectPrivilege(noNft, { ...facts, nft: undefined })).kind).toBe('none');
  });
});

describe('runNft', () => {
  const run = (privilege: Privilege, password?: string, script = () => ok()) => {
    const executor = new FakeExecutor(script);
    const result = runNft({ executor, nftPath: NFT, privilege, password }, ['-j', 'list', 'ruleset']);
    return { executor, result };
  };

  it('prefixes nft according to the privilege', async () => {
    const root = run({ kind: 'root' });
    await root.result;
    expect(root.executor.calls[0]?.argv).toEqual([NFT, '-j', 'list', 'ruleset']);

    const sudo = run({ kind: 'sudo' });
    await sudo.result;
    expect(sudo.executor.calls[0]?.argv).toEqual(['env', 'LC_ALL=C', 'sudo', '-n', '--', NFT, '-j', 'list', 'ruleset']);
  });

  it('sends the sudo password as the only input', async () => {
    const withPassword = run({ kind: 'sudo-password' }, 'secret');
    await withPassword.result;
    expect(withPassword.executor.calls[0]).toEqual({
      argv: ['env', 'LC_ALL=C', 'sudo', '-S', '-p', '', '--', NFT, '-j', 'list', 'ruleset'],
      stdin: 'secret\n',
    });

    const executor = new FakeExecutor(() => ok());
    const access = { executor, nftPath: NFT, privilege: { kind: 'sudo-password' } as const, password: 'secret' };
    await expect(runNft(access, ['-f', '-'], { stdin: 'flush ruleset' })).rejects.toThrow(/upload a file/);
  });

  it('reports a missing or wrong password and missing privileges', async () => {
    await expect(run({ kind: 'sudo-password' }).result).rejects.toMatchObject({ code: 'password-required' });
    const wrong = run({ kind: 'sudo-password' }, 'nope', () => failed('Sorry, try again.\nsudo: 1 incorrect password attempt\n'));
    await expect(wrong.result).rejects.toMatchObject({ code: 'wrong-password' });
    await expect(run({ kind: 'none', detail: 'x' }).result).rejects.toBeInstanceOf(HostError);
  });
});
