// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { HostErrorCode } from '@hopdeck/core';
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
  'host-key-mismatch': true,
  'known-hosts-unwritable': true,
  'host-key-in-global-file': true,
  'table-not-editable': true,
  'invalid-definition': true,
  'ruleset-changed': true,
  'rollback-unavailable': true,
  'deployment-state': true,
  'persistence-unavailable': true,
  'include-rejected': true,
  'invalid-filter': true,
  'trace-unavailable': true,
  'platform-read-only': true,
  'wrong-passphrase': true,
  'login-password-rejected': true,
  'password-login-disabled': true,
  'key-exists': true,
  'uci-failed': true,
  'uci-apply-pending': true,
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
