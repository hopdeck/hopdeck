// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import { runProcess } from './process.ts';

describe('runProcess', () => {
  it("stops a program that prints without end, before it fills this machine's memory", async () => {
    await expect(runProcess('sh', ['-c', 'yes'], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 })).rejects.toMatchObject({
      code: 'command-failed',
      detail: expect.stringContaining('printed more than 65536 bytes on stdout'),
    });
  });

  it('ends at the timeout even when a program it started keeps the output open', async () => {
    await expect(runProcess('sh', ['-c', 'sleep 30 | cat; echo never'], { timeoutMs: 300 })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('returns what a program prints within the limit', async () => {
    expect(await runProcess('sh', ['-c', 'printf ok; exit 3'], { timeoutMs: 10_000, maxOutputBytes: 64 })).toEqual({ exitCode: 3, stdout: 'ok', stderr: '' });
  });
});
