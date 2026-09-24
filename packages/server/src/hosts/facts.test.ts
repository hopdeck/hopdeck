import { release } from 'node:os';
import { describe, expect, it } from 'vitest';
import { DEBIAN_FACTS } from '../testing/fake-executor.ts';
import { HostError } from './errors.ts';
import { collectFacts, parseFacts } from './facts.ts';
import { LocalExecutor } from './local.ts';

describe('parseFacts', () => {
  it('reads a typical host', () => {
    expect(parseFacts(DEBIAN_FACTS)).toEqual({
      uid: 1000,
      hostname: 'fw1',
      kernel: '6.1.0-18-amd64',
      os: { id: 'debian', version: '12', name: 'Debian GNU/Linux 12 (bookworm)' },
      systemd: true,
      nft: { path: '/usr/sbin/nft', version: '1.0.6' },
    });
  });

  it('copes with missing os-release and nft', () => {
    const facts = parseFacts('uid=0\nhostname=box\nkernel=5.10.0\nsystemd=no\n');
    expect(facts).toMatchObject({ uid: 0, os: undefined, systemd: false, nft: undefined });
  });

  it('rejects output without a uid', () => {
    expect(() => parseFacts('Welcome to our server!\n')).toThrow(HostError);
  });
});

describe('collectFacts', () => {
  it('runs on this machine', async () => {
    const facts = await collectFacts(new LocalExecutor());
    expect(facts.uid).toBe(process.getuid!());
    expect(facts.kernel).toBe(release());
  });
});
