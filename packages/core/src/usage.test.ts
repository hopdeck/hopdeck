// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import { cpuPercent, parseUsage } from './usage.ts';

const sample = (user: number, idle: number) => `cpu  ${user} 0 0 ${idle} 0 0 0 0 0 0
cpu0 0 0 0 0 0 0 0 0 0 0
cpu1 0 0 0 0 0 0 0 0 0 0
cpu2 0 0 0 0 0 0 0 0 0 0
cpu3 0 0 0 0 0 0 0 0 0 0
MemTotal:        4000000 kB
MemAvailable:    3000000 kB
`;

describe('parseUsage and cpuPercent', () => {
  it('counts 100% per fully busy thread, like top', () => {
    const before = parseUsage(sample(1000, 1000)).cpu;
    // Of 400 ticks across 4 threads, 150 busy: one thread and a half.
    expect(cpuPercent(before, parseUsage(sample(1150, 1250)).cpu)).toBe(150);
    expect(cpuPercent(before, parseUsage(sample(1400, 1000)).cpu)).toBe(400);
    expect(cpuPercent(before, before)).toBe(0);
  });

  it('reads memory in use as free does: total less what is available', () => {
    expect(parseUsage(sample(0, 0)).memory).toEqual({ total: 4_096_000_000, used: 1_024_000_000 });
    expect(parseUsage(sample(0, 0)).cpu.threads).toBe(4);
  });

  it('says what is missing', () => {
    expect(() => parseUsage('MemTotal: 1 kB\n')).toThrow(/no "cpu" line/);
  });
});
