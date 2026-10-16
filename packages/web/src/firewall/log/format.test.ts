// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import { shortIPv6 } from './format.ts';

describe('shortIPv6', () => {
  it('writes the eight groups the kernel logs as RFC 5952 does', () => {
    expect(shortIPv6('2001:0db8:0000:0000:0000:0000:0000:0007')).toBe('2001:db8::7');
    expect(shortIPv6('fe80:0000:0000:0000:5054:00ff:fe12:3456')).toBe('fe80::5054:ff:fe12:3456');
    expect(shortIPv6('0000:0000:0000:0000:0000:0000:0000:0001')).toBe('::1');
    expect(shortIPv6('0000:0000:0000:0000:0000:0000:0000:0000')).toBe('::');
    // A single zero group stays; of two equal runs, the first goes.
    expect(shortIPv6('2001:0db8:0000:0001:0000:0000:0001:0001')).toBe('2001:db8:0:1::1:1');
    expect(shortIPv6('2001:0000:0000:0001:0000:0000:0001:0001')).toBe('2001::1:0:0:1:1');
  });

  it('leaves IPv4 and anything else as it is', () => {
    expect(shortIPv6('192.0.2.1')).toBe('192.0.2.1');
    expect(shortIPv6('2001:db8::1')).toBe('2001:db8::1');
  });
});
