// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import { bootTime, uptimeText } from './uptime.ts';

describe('uptimeText', () => {
  it('shows the two largest units, rounded down', () => {
    expect(uptimeText(12 * 86_400 + 4 * 3600 + 59 * 60 + 59)).toEqual({ key: 'usage.uptimeDays', vars: { days: 12, hours: 4 } });
    expect(uptimeText(4 * 3600 + 5 * 60 + 30)).toEqual({ key: 'usage.uptimeHours', vars: { hours: 4, minutes: 5 } });
    expect(uptimeText(5 * 60 + 59.9)).toEqual({ key: 'usage.uptimeMinutes', vars: { minutes: 5 } });
    expect(uptimeText(42)).toEqual({ key: 'usage.uptimeMinutes', vars: { minutes: 0 } });
  });
});

describe('bootTime', () => {
  it('is the time of the reading less the uptime', () => {
    expect(bootTime('2026-10-18T09:30:00.000Z', 3600.5).toISOString()).toBe('2026-10-18T08:29:59.500Z');
  });
});
