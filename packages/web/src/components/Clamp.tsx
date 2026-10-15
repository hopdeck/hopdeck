// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider.tsx';
import styles from './Clamp.module.css';

/** How many lines a clamped block shows. */
export const CLAMP_LINES = 4;

/**
 * Content cut to a few lines, with a button that shows the rest: a rule that
 * matches hundreds of addresses would otherwise fill the screen. `count` is
 * the number of items, for the button.
 */
export function Clamp({ count, children }: { count?: number | undefined; children: ReactNode }) {
  const { t } = useI18n();
  const content = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);

  // The content's own height, whatever is cut: measured again when the column's width changes.
  useLayoutEffect(() => {
    const element = content.current;
    if (element === null) return;
    const measure = () => {
      const style = getComputedStyle(element);
      // "normal" is about 1.2 times the font size.
      const line = style.lineHeight === 'normal' ? parseFloat(style.fontSize) * 1.2 : parseFloat(style.lineHeight);
      // Cutting that hides a single line saves nothing.
      setLong(Number.isFinite(line) && element.offsetHeight > (CLAMP_LINES + 1) * line + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [children]);

  const cut = long && !open;
  return (
    <>
      <div className={cut ? styles.cut : undefined} style={cut ? { ['--clamp-lines' as string]: CLAMP_LINES } : undefined}>
        <div ref={content}>{children}</div>
      </div>
      {long && (
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          // The row opens its editor on a double click; the button is not the row.
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {open ? t('clamp.less') : count === undefined ? t('clamp.more') : t('clamp.moreItems', { count })}
        </button>
      )}
    </>
  );
}
