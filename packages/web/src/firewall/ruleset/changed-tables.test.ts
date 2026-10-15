// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { tableKey } from '@hopdeck/core';
import { describe, expect, it } from 'vitest';
import { changedTables } from './model.ts';

describe('changedTables', () => {
  it('names tables changed, added or removed on the host', () => {
    const shown = { [tableKey('inet', 'filter')]: 'aaaa', [tableKey('ip', 'nat')]: 'bbbb', [tableKey('inet', 'old')]: 'cccc' };
    const live = { [tableKey('inet', 'filter')]: 'aaab', [tableKey('ip', 'nat')]: 'bbbb', [tableKey('inet', 'new')]: 'dddd' };
    expect(changedTables(shown, live)).toEqual(['inet filter', 'inet new', 'inet old']);
    expect(changedTables(shown, shown)).toEqual([]);
  });
});
