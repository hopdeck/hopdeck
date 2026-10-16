// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

/**
 * An IPv6 address as people write it: the kernel logs all eight groups
 * ("2001:0db8:0000:…:0007"), shortened here to "2001:db8::7" (RFC 5952).
 */
export function shortIPv6(address: string): string {
  const groups = address.split(':');
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return address;
  const short = groups.map((group) => group.replace(/^0+(?=.)/, '').toLowerCase());
  // The longest run of two or more zero groups, the first of equal ones, becomes "::".
  let best = { start: -1, length: 1 };
  for (let start = 0; start < 8; start += 1) {
    let length = 0;
    while (start + length < 8 && short[start + length] === '0') length += 1;
    if (length > best.length) best = { start, length };
  }
  if (best.start === -1) return short.join(':');
  return `${short.slice(0, best.start).join(':')}::${short.slice(best.start + best.length).join(':')}`;
}
