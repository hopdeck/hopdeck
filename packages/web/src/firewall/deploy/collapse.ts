// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { DiffLine } from '@hopdeck/core';

export type DiffBlock = { kind: 'line'; line: DiffLine } | { kind: 'gap'; count: number };

/** Keeps changed lines and `context` lines around them; longer unchanged runs become gaps. */
export function collapseDiff(diff: readonly DiffLine[], context = 3): DiffBlock[] {
  const near = diff.map((_, index) =>
    diff.slice(Math.max(0, index - context), index + context + 1).some((line) => line.kind !== 'same'),
  );
  const blocks: DiffBlock[] = [];
  diff.forEach((line, index) => {
    if (near[index]) {
      blocks.push({ kind: 'line', line });
      return;
    }
    const last = blocks.at(-1);
    if (last?.kind === 'gap') last.count += 1;
    else blocks.push({ kind: 'gap', count: 1 });
  });
  return blocks;
}
