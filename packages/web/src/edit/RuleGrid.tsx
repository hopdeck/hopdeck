import type { RuleForm } from '@hopdeck/core';
import { Fragment, type ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/locales.ts';
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

/** The rules of a chain as a table: what each rule matches, column by column, and what it does. */
export function RuleGrid({ rows, actions, onOpen, showRates = false, showHandles = false }: RuleGridProps) {
  const { t } = useI18n();
  const cells = rows.map((row): Cells | undefined => row.form && { ...ruleColumns(row.form), comment: row.form.comment ?? '' });
  const columns = COLUMNS.filter((column) => cells.some((cell) => cell !== undefined && cell[column.id] !== ''));
  const showCounters = rows.some((row) => row.counter !== undefined);

  return (
    <div className={styles.gridScroll}>
      <table className={styles.grid}>
        <thead>
          <tr>
            <th className={styles.index}>#</th>
            <th>{t('editor.col.action')}</th>
            {columns.map((column) => (
              <th key={column.id}>{t(column.label)}</th>
            ))}
            {showRates && <th className={styles.numeric}>{t('editor.col.rate')}</th>}
            {showCounters && <th className={styles.numeric}>{t('editor.col.counter')}</th>}
            {showHandles && <th className={styles.numeric}>{t('editor.col.handle')}</th>}
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
              <tr key={row.key} className={state} onDoubleClick={onOpen && (() => onOpen(index))}>
                <td className={styles.index}>{index + 1}</td>
                {cell === undefined ? (
                  <td colSpan={1 + columns.length} className={styles.textRule}>
                    <span className={styles.textBadge} title={t('editor.textRuleTitle')}>
                      {t('editor.textRule')}
                    </span>
                    <NftCode text={row.text} />
                  </td>
                ) : (
                  <>
                    <td>
                      <span className={`${styles.action} ${styles[`action-${cell.actionTone}`]}`}>{cell.action}</span>
                    </td>
                    {columns.map((column) => (
                      <td key={column.id} className={column.id === 'comment' ? styles.comment : `${styles.value}${column.mono ? ' mono' : ''}`}>
                        {column.id === 'comment' ? cell.comment : <Items text={cell[column.id]} />}
                      </td>
                    ))}
                  </>
                )}
                {showRates && <td className={`${styles.numeric} ${styles.rate}`}>{row.rate}</td>}
                {showCounters && <td className={`${styles.numeric} ${styles.counter}`}>{row.counter}</td>}
                {showHandles && <td className={`${styles.numeric} ${styles.handle}`}>{row.handle !== undefined && `#${row.handle}`}</td>}
                {actions !== undefined && <td className={styles.rowActions}>{actions(index)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
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
