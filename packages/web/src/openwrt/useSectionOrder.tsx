// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { movedSections, typeOrder } from '@hopdeck/core';
import { useState, type DragEvent } from 'react';
import { ArrowDownIcon, ArrowUpIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import styles from './OpenWrt.module.css';
import type { UciFirewallState } from './useUciFirewall.ts';

/**
 * Rows of the sections of one type in the order fw4 follows them, which is
 * UCI's: dragged by their handle, or moved with the arrows, into another.
 * `names` are the sections in the order shown.
 */
export function useSectionOrder(state: UciFirewallState, type: string, names: readonly string[]) {
  const { t } = useI18n();
  const [dragged, setDragged] = useState<number>();
  const [over, setOver] = useState<{ index: number; after: boolean }>();
  // A dragged section is marked as changed, not the ones it passed.
  const moved = movedSections(state.base?.sections.filter((section) => section.type === type).map((section) => section.name) ?? [], names);

  /** Puts the section at `from` before the one at `to`, or after it. */
  const move = (from: number, to: number, after: boolean) => {
    const order = [...names];
    const [section] = order.splice(from, 1);
    const target = to > from ? to - 1 : to;
    order.splice(after ? target + 1 : target, 0, section!);
    if (order.every((name, index) => name === names[index])) return;
    state.change([typeOrder(state.preview!, type, order)]);
  };

  return {
    moved,
    /** The classes of the row at `index` while a drag goes on. */
    rowClass: (index: number) => [dragged === index ? styles.dragging : '', over?.index === index ? (over.after ? styles.dropAfter : styles.dropBefore) : ''].join(' '),
    /** What the row at `index` does with a section dragged over it. */
    rowEvents: (index: number) => ({
      onDragOver: (event: DragEvent<HTMLTableRowElement>) => {
        if (dragged === undefined) return;
        event.preventDefault();
        const box = event.currentTarget.getBoundingClientRect();
        setOver({ index, after: event.clientY > box.top + box.height / 2 });
      },
      onDragLeave: () => setOver((current) => (current?.index === index ? undefined : current)),
      onDrop: (event: DragEvent<HTMLTableRowElement>) => {
        event.preventDefault();
        if (dragged !== undefined && over !== undefined) move(dragged, over.index, over.after);
        setDragged(undefined);
        setOver(undefined);
      },
    }),
    handle: (index: number) => (
      <span
        className={styles.handle}
        draggable
        title={t('uci.rules.drag')}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move';
          // Firefox starts a drag only with some data.
          event.dataTransfer.setData('text/plain', names[index]!);
          setDragged(index);
        }}
        onDragEnd={() => {
          setDragged(undefined);
          setOver(undefined);
        }}
      >
        ⠿
      </span>
    ),
    arrows: (index: number) => (
      <>
        <button type="button" className="btn btn-ghost btn-sm btn-icon" title={t('editor.up')} aria-label={t('editor.up')} disabled={index === 0} onClick={() => move(index, index - 1, false)}>
          <ArrowUpIcon />
        </button>
        <button type="button" className="btn btn-ghost btn-sm btn-icon" title={t('editor.down')} aria-label={t('editor.down')} disabled={index === names.length - 1} onClick={() => move(index, index + 1, true)}>
          <ArrowDownIcon />
        </button>
      </>
    ),
  };
}
