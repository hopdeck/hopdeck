// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import { FakeExecutor, ok } from '../testing/fake-executor.ts';
import { HostError } from './errors.ts';
import { LoginGuard } from './login-guard.ts';

describe('LoginGuard', () => {
  it('does not log in again once the host refused, until reset', async () => {
    let refuse = true;
    const inner = new FakeExecutor(() => (refuse ? new HostError('ssh-auth', 'root@fw1: Permission denied (publickey).') : ok('up')));
    const guard = new LoginGuard(inner);
    await expect(guard.exec(['uptime'])).rejects.toMatchObject({ code: 'ssh-auth' });
    await expect(guard.exec(['uptime'])).rejects.toMatchObject({ code: 'ssh-auth', detail: expect.stringMatching(/Permission denied[\s\S]*until you reconnect/) });
    expect(inner.calls).toHaveLength(1);

    refuse = false;
    guard.reset();
    expect((await guard.exec(['uptime'])).stdout).toBe('up');
    expect(inner.calls).toHaveLength(2);
  });

  it('lets other failures through and tries again after them: a network can come back', async () => {
    let calls = 0;
    const guard = new LoginGuard(new FakeExecutor(() => (calls++ === 0 ? new HostError('ssh-connect', 'Connection timed out') : ok())));
    await expect(guard.exec(['true'])).rejects.toMatchObject({ code: 'ssh-connect' });
    await expect(guard.exec(['true'])).resolves.toMatchObject({ exitCode: 0 });
  });
});
