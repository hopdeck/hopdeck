// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { DiffLine } from '@hopdeck/core';
import { describe, expect, it } from 'vitest';
import { collapseDiff } from './collapse.ts';

const same = (text: string): DiffLine => ({ kind: 'same', text });

describe('collapseDiff', () => {
  it('keeps context around changes and folds the rest', () => {
    const diff = [...'abcdefgh'.split('').map(same), { kind: 'add' as const, text: 'X' }, ...'ijklmnop'.split('').map(same)];
    expect(collapseDiff(diff, 2).map((block) => (block.kind === 'gap' ? `…${block.count}` : block.line.text))).toEqual([
      '…6', 'g', 'h', 'X', 'i', 'j', '…6',
    ]);
  });

  it('folds everything when nothing changed', () => {
    expect(collapseDiff(['a', 'b'].map(same))).toEqual([{ kind: 'gap', count: 2 }]);
  });
});
