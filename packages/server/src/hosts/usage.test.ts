// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { parseUsage, USAGE_COMMAND } from '@hopdeck/core';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { hasAccount, testHost } from '../testing/test-host.ts';
import { SshExecutor } from './ssh.ts';

// Against a test host: dev/test-host/up.sh [SYSTEM] (or dev/vm-host/up.sh), then HOPDECK_TEST_HOST=1 (see testing/test-host.ts).
describe.skipIf(testHost === undefined)('CPU and memory use, and uptime, on the test host', () => {
  it('reads them with the userland there, as the least privileged account', async () => {
    const account = hasAccount('plain') ? 'plain' : 'root';
    const executor = new SshExecutor({ destination: `hopdeck-test-${account}`, controlDir: await mkdtemp(`${tmpdir()}/hopdeck-usage-`), configFile: testHost!.sshConfig });
    const result = await executor.exec(['sh', '-c', USAGE_COMMAND]);
    expect(result.exitCode).toBe(0);
    const usage = parseUsage(result.stdout);
    expect(usage.cpu.threads).toBeGreaterThan(0);
    expect(usage.cpu.total).toBeGreaterThan(usage.cpu.busy);
    expect(usage.memory.used).toBeGreaterThan(0);
    expect(usage.memory.used).toBeLessThan(usage.memory.total);
    expect(usage.uptime).toBeGreaterThan(0);
  });
});
