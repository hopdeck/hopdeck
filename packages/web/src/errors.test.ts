import type { HostErrorCode } from '@nftm/core';
import { describe, expect, it } from 'vitest';
import { errorText } from './errors.ts';

// Every code the server can put into a host status; checked at compile time
// against HostErrorCode, so a new code without a text fails this test.
const HOST_ERROR_CODES = {
  'ssh-host-key': true,
  'ssh-host-key-changed': true,
  'ssh-auth': true,
  'ssh-connect': true,
  timeout: true,
  'spawn-failed': true,
  'command-failed': true,
  'nft-missing': true,
  'no-privileges': true,
  'password-required': true,
  'wrong-password': true,
  'sudo-not-allowed': true,
} satisfies Record<HostErrorCode, true>;

describe('errorText', () => {
  it('has a title for every host error code', () => {
    for (const code of Object.keys(HOST_ERROR_CODES)) expect(errorText(code), code).toBeDefined();
  });

  it('knows nothing about other codes, including Object.prototype keys', () => {
    expect(errorText('something-new')).toBeUndefined();
    expect(errorText('constructor')).toBeUndefined();
  });
});
