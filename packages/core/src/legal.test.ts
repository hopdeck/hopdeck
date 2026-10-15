// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import { SOURCE_REPOSITORY, sourceUrl } from './legal.ts';

describe('sourceUrl', () => {
  it('points a release at its tag, and a development build at the repository', () => {
    expect(sourceUrl('0.2.0')).toBe(`${SOURCE_REPOSITORY}/tree/v0.2.0`);
    expect(sourceUrl('0.2.0-dev')).toBe(SOURCE_REPOSITORY);
    expect(sourceUrl('')).toBe(SOURCE_REPOSITORY);
  });
});
