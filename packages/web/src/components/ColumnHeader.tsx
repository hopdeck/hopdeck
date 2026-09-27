import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { clampWidth, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from './column-widths.ts';
import styles from './ColumnHeader.module.css';

interface ColumnHeaderProps {
  /** The column's name, for the resize handle. */
  label: string;
  /** Set by the viewer; undefined fits the content. */
  width: number | undefined;
  /** `save` is false while the edge is being dragged. */
  onResize(width: number | undefined, save: boolean): void;
  className?: string | undefined;
  children: ReactNode;
}

/**
 * A header cell whose right edge changes the column's width: drag it, or focus
 * it and use the arrow keys (Shift for bigger steps). A double click, or
 * Delete, lets the column fit its content again.
 */
export function ColumnHeader({ label, width, onResize, className, children }: ColumnHeaderProps) {
  const { t } = useI18n();
  const cell = useRef<HTMLTableCellElement>(null);
  const drag = useRef<{ x: number; from: number; to: number } | undefined>(undefined);

  // The width of the column's content now: the one set, or what the table made of it.
  function measure(): number {
    if (width !== undefined) return width;
    const th = cell.current!;
    const style = getComputedStyle(th);
    return th.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
  }

  function start(event: PointerEvent<HTMLSpanElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const from = measure();
    drag.current = { x: event.clientX, from, to: from };
  }

  function move(event: PointerEvent<HTMLSpanElement>) {
    const current = drag.current;
    if (current === undefined) return;
    const to = clampWidth(current.from + event.clientX - current.x);
    if (to === current.to) return;
    current.to = to;
    onResize(to, false);
  }

  function end() {
    const current = drag.current;
    drag.current = undefined;
    // A click without a move leaves a fitted column as it is.
    if (current !== undefined && (current.to !== current.from || width !== undefined)) onResize(current.to, true);
  }

  function key(event: KeyboardEvent<HTMLSpanElement>) {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      onResize(clampWidth(measure() + (event.key === 'ArrowRight' ? step : -step)), true);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      onResize(undefined, true);
    }
  }

  return (
    <th ref={cell} className={`${styles.header}${className === undefined ? '' : ` ${className}`}`}>
      {width === undefined ? (
        children
      ) : (
        <div className={styles.label} style={{ width }}>
          {children}
        </div>
      )}
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label={t('table.resize', { column: label })}
        aria-valuemin={MIN_COLUMN_WIDTH}
        aria-valuemax={MAX_COLUMN_WIDTH}
        {...(width === undefined ? { 'aria-valuetext': t('table.fitted') } : { 'aria-valuenow': width, 'aria-valuetext': `${width} px` })}
        tabIndex={0}
        title={t('table.resizeHint')}
        className={styles.handle}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => onResize(undefined, true)}
        onKeyDown={key}
      />
    </th>
  );
}

/** The content of a body cell in a column with a set width: it wraps within it. */
export function Fit({ width, children }: { width: number | undefined; children: ReactNode }) {
  return width === undefined ? (
    children
  ) : (
    <div className={styles.fit} style={{ width }}>
      {children}
    </div>
  );
}
