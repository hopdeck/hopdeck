// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import { checkAccess, createAccessPolicy } from './security.ts';

describe('checkAccess', () => {
  const policy = createAccessPolicy('secret-token', 7400, ['http://127.0.0.1:5173']);
  const valid = { host: '127.0.0.1:7400', authorization: 'Bearer secret-token' };

  it('accepts a request with the right host and token', () => {
    expect(checkAccess(valid, policy, true)).toEqual({ ok: true });
    expect(checkAccess({ ...valid, host: 'localhost:7400', origin: 'http://localhost:7400' }, policy, true)).toEqual({
      ok: true,
    });
    expect(checkAccess({ ...valid, origin: 'http://127.0.0.1:5173' }, policy, true)).toEqual({ ok: true });
  });

  it('rejects DNS rebinding through an unexpected Host', () => {
    expect(checkAccess({ ...valid, host: 'evil.example:7400' }, policy, true)).toMatchObject({ ok: false, status: 403 });
    expect(checkAccess({ ...valid, host: '127.0.0.1:7401' }, policy, true)).toMatchObject({ ok: false, status: 403 });
    expect(checkAccess({ authorization: valid.authorization }, policy, true)).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects requests from other origins', () => {
    for (const origin of ['http://evil.example', 'null', 'http://127.0.0.1:7400.evil.example']) {
      expect(checkAccess({ ...valid, origin }, policy, true)).toMatchObject({ ok: false, status: 403 });
    }
  });

  it('requires the token only where asked', () => {
    expect(checkAccess({ host: valid.host }, policy, true)).toMatchObject({ ok: false, status: 401 });
    expect(checkAccess({ ...valid, authorization: 'Bearer wrong-token!' }, policy, true)).toMatchObject({ status: 401 });
    expect(checkAccess({ ...valid, authorization: 'secret-token' }, policy, true)).toMatchObject({ status: 401 });
    expect(checkAccess({ host: valid.host }, policy, false)).toEqual({ ok: true });
  });
});
