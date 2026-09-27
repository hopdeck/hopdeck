// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

export interface DiffLine {
  kind: 'same' | 'add' | 'remove';
  text: string;
}

/** Above this many cells the middle part is shown as removed, then added, instead of aligned. */
const MAX_TABLE_CELLS = 4_000_000;

/**
 * Line diff for reviewing a change. Common lines at both ends are matched
 * first (edits are usually local); the rest is aligned by longest common
 * subsequence.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const head = a.slice(0, start).map((text): DiffLine => ({ kind: 'same', text }));
  const tail = a.slice(endA).map((text): DiffLine => ({ kind: 'same', text }));
  return [...head, ...alignMiddle(a.slice(start, endA), b.slice(start, endB)), ...tail];
}

export function hasChanges(diff: readonly DiffLine[]): boolean {
  return diff.some((line) => line.kind !== 'same');
}

function alignMiddle(a: string[], b: string[]): DiffLine[] {
  if (a.length * b.length > MAX_TABLE_CELLS) {
    return [...a.map((text): DiffLine => ({ kind: 'remove', text })), ...b.map((text): DiffLine => ({ kind: 'add', text }))];
  }
  // lcs[i][j]: length of the longest common subsequence of a[i..] and b[j..].
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      result.push({ kind: 'same', text: a[i]! });
      i += 1;
      j += 1;
    } else if (j < b.length && (i === a.length || lcs[i * width + j + 1]! >= lcs[(i + 1) * width + j]!)) {
      result.push({ kind: 'add', text: b[j]! });
      j += 1;
    } else {
      result.push({ kind: 'remove', text: a[i]! });
      i += 1;
    }
  }
  return result;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}
