// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { RuleForm } from '@hopdeck/core';
import { Fragment, type ReactNode } from 'react';
import { Clamp } from '../../components/Clamp.tsx';
import { ColumnHeader, Fit } from '../../components/ColumnHeader.tsx';
import { useColumnWidths } from '../../components/column-widths.ts';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import type { MessageKey } from '../../i18n/locales.ts';
import { NftCode } from '../ruleset/NftCode.tsx';
import styles from './Editor.module.css';
import { ruleColumns, type RuleColumns } from './rule-summary.ts';

/** One rule of the grid. */
export interface GridRow {
  key: string;
  /** The rule as nft text; shown whole when the form cannot hold it. */
  text: string;
  form: RuleForm | undefined;
  /** In the editor: added or changed since the table was read. */
  status?: 'same' | 'new' | 'edited';
  /** nft complained about this rule. */
  error?: boolean;
  /** Counter values as text, e.g. "12 / 3 KiB". */
  counter?: string | undefined;
  /** Traffic since the previous look; the row is highlighted. */
  rate?: string | undefined;
  handle?: number | undefined;
}

interface RuleGridProps {
  rows: readonly GridRow[];
  /** Buttons at the end of each row, for editing. */
  actions?: (index: number) => ReactNode;
  /** A double click on a row. */
  onOpen?: (index: number) => void;
  /** Live data is on: keep a column for traffic, even while there is none. */
  showRates?: boolean;
  showHandles?: boolean;
}

type Column = Exclude<keyof RuleColumns, 'action' | 'actionTone'> | 'comment';

/** Columns after the action; one shows only when a rule of the chain uses it. */
const COLUMNS: readonly { id: Column; label: MessageKey; mono: boolean }[] = [
  { id: 'protocol', label: 'editor.col.protocol', mono: true },
  { id: 'source', label: 'editor.col.source', mono: true },
  { id: 'destination', label: 'editor.col.destination', mono: true },
  { id: 'sourcePort', label: 'editor.col.sourcePort', mono: true },
  { id: 'destinationPort', label: 'editor.col.destinationPort', mono: true },
  { id: 'input', label: 'editor.col.input', mono: true },
  { id: 'output', label: 'editor.col.output', mono: true },
  { id: 'state', label: 'editor.col.state', mono: false },
  { id: 'packet', label: 'editor.col.packet', mono: true },
  { id: 'limits', label: 'editor.col.limits', mono: true },
  { id: 'extra', label: 'editor.col.extra', mono: false },
  { id: 'comment', label: 'editor.col.comment', mono: false },
];

type Cells = RuleColumns & { comment: string };

/** Where the widths the viewer gives columns are kept; shared by every rule table, in the editor too. */
const WIDTHS_KEY = 'hopdeck.ruleColumns';

/** The rules of a chain as a table: what each rule matches, column by column, and what it does. */
export function RuleGrid({ rows, actions, onOpen, showRates = false, showHandles = false }: RuleGridProps) {
  const { t } = useI18n();
  const [widths, setWidth] = useColumnWidths(WIDTHS_KEY);
  const header = (id: string, label: string, className?: string) => (
    <ColumnHeader
      key={id}
      label={label}
      width={widths[id]}
      onResize={(width, save) => setWidth(id, width, save)}
      className={`${className ?? ''}${widths[id] === undefined ? '' : ` ${styles.sized}`}`}
    >
      {label}
    </ColumnHeader>
  );
  const sized = (id: string, className: string) => (widths[id] === undefined ? className : `${className} ${styles.sized}`);
  const cells = rows.map((row): Cells | undefined => row.form && { ...ruleColumns(row.form), comment: row.form.comment ?? '' });
  const columns = COLUMNS.filter((column) => cells.some((cell) => cell !== undefined && cell[column.id] !== ''));
  const showCounters = rows.some((row) => row.counter !== undefined);
  const shown = ['action', ...columns.map((column) => column.id), ...(showRates ? ['rate'] : []), ...(showCounters ? ['counter'] : []), ...(showHandles ? ['handle'] : [])];
  // Space left over would otherwise widen the columns the viewer sized.
  const natural = shown.every((id) => widths[id] !== undefined);

  return (
    <div className={styles.gridScroll}>
      <table className={natural ? `${styles.grid} ${styles.natural}` : styles.grid}>
        <thead>
          <tr>
            <th className={styles.index}>#</th>
            {header('action', t('editor.col.action'))}
            {columns.map((column) => header(column.id, t(column.label)))}
            {showRates && header('rate', t('editor.col.rate'), styles.numeric)}
            {showCounters && header('counter', t('editor.col.counter'), styles.numeric)}
            {showHandles && header('handle', t('editor.col.handle'), styles.numeric)}
            {actions !== undefined && (
              <th className={styles.rowActions}>
                <span className="visually-hidden">{t('editor.col.actions')}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const cell = cells[index];
            const state = row.error
              ? styles.rowError
              : row.status === 'new'
                ? styles.rowNew
                : row.status === 'edited'
                  ? styles.rowEdited
                  : row.rate !== undefined
                    ? styles.rowBusy
                    : undefined;
            return (
              <tr key={row.key} data-row={row.key} className={state} onDoubleClick={onOpen && (() => onOpen(index))}>
                <td className={styles.index}>{index + 1}</td>
                {cell === undefined ? (
                  <td colSpan={1 + columns.length} className={styles.textRule}>
                    <span className={styles.textBadge} title={t('editor.textRuleTitle')}>
                      {t('editor.textRule')}
                    </span>
                    <Clamp>
                      <NftCode text={row.text} />
                    </Clamp>
                  </td>
                ) : (
                  <>
                    <td className={sized('action', '')}>
                      <Fit width={widths['action']}>
                        <span className={`${styles.action} ${styles[`action-${cell.actionTone}`]}`}>{cell.action}</span>
                      </Fit>
                    </td>
                    {columns.map((column) => (
                      <td
                        key={column.id}
                        className={sized(column.id, column.id === 'comment' ? styles.comment! : `${styles.value}${column.mono ? ' mono' : ''}`)}
                      >
                        <Fit width={widths[column.id]}>
                          {column.id === 'comment' ? (
                            <Clamp>{cell.comment}</Clamp>
                          ) : (
                            <Clamp count={itemCount(cell[column.id])}>
                              <Items text={cell[column.id]} />
                            </Clamp>
                          )}
                        </Fit>
                      </td>
                    ))}
                  </>
                )}
                {showRates && (
                  <td className={sized('rate', `${styles.numeric} ${styles.rate}`)}>
                    <Fit width={widths['rate']}>{row.rate}</Fit>
                  </td>
                )}
                {showCounters && (
                  <td className={sized('counter', `${styles.numeric} ${styles.counter}`)}>
                    <Fit width={widths['counter']}>{row.counter}</Fit>
                  </td>
                )}
                {showHandles && (
                  <td className={sized('handle', `${styles.numeric} ${styles.handle}`)}>
                    <Fit width={widths['handle']}>{row.handle !== undefined && `#${row.handle}`}</Fit>
                  </td>
                )}
                {actions !== undefined && <td className={styles.rowActions}>{actions(index)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** How many items a list has, when it is a list: the button that shows a cut one says so. */
function itemCount(text: string): number | undefined {
  const count = text.split(', ').length;
  return count > 1 ? count : undefined;
}

/** A comma-separated list that wraps only between its items, never inside one. */
function Items({ text }: { text: string }) {
  const items = text.split(', ');
  return items.map((item, index) => (
    <Fragment key={index}>
      {index > 0 && ' '}
      <span className={styles.item}>{index < items.length - 1 ? `${item},` : item}</span>
    </Fragment>
  ));
}
