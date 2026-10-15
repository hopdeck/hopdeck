// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { useCallback, useSyncExternalStore } from 'react';

/** Column widths in pixels, by column id; a column without one fits its content. */
export type ColumnWidths = Readonly<Record<string, number>>;

export const MIN_COLUMN_WIDTH = 32;
export const MAX_COLUMN_WIDTH = 1200;

interface Store {
  widths: ColumnWidths;
  listeners: Set<() => void>;
}

const stores = new Map<string, Store>();

function store(key: string): Store {
  let found = stores.get(key);
  if (found === undefined) {
    found = { widths: read(key), listeners: new Set() };
    stores.set(key, found);
  }
  return found;
}

/** The viewer's widths; storage can be missing or refuse, and then every column fits its content. */
function read(key: string): ColumnWidths {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (typeof data !== 'object' || data === null) return {};
    return Object.fromEntries(Object.entries(data).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] >= MIN_COLUMN_WIDTH));
  } catch {
    return {};
  }
}

export function clampWidth(width: number): number {
  return Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width)));
}

/**
 * Widths shared by every table with the same key, e.g. all rule tables, and
 * remembered in this browser. `setWidth(id, undefined)` lets the column fit its
 * content again; `save` false keeps a width out of storage while it is dragged.
 */
export function useColumnWidths(key: string): [ColumnWidths, (id: string, width: number | undefined, save?: boolean) => void] {
  const current = store(key);
  const widths = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        current.listeners.add(listener);
        return () => current.listeners.delete(listener);
      },
      [current],
    ),
    () => current.widths,
  );
  const setWidth = useCallback(
    (id: string, width: number | undefined, save = true) => {
      const next = { ...current.widths };
      if (width === undefined) delete next[id];
      else next[id] = clampWidth(width);
      current.widths = next;
      for (const listener of current.listeners) listener();
      if (!save) return;
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Not remembered, but still in effect until the page is reloaded.
      }
    },
    [current, key],
  );
  return [widths, setWidth];
}
