import type { Family } from '@nftm/core';
import { Fragment, useState, type ReactNode } from 'react';
import { ArrowDownIcon, ArrowUpIcon, CopyIcon, EditIcon, PlusIcon, TrashIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/locales.ts';
import { NftCode } from '../ruleset/NftCode.tsx';
import styles from './Editor.module.css';
import { ChainDialog } from './ChainDialog.tsx';
import { RuleDialog, type RuleEdit } from './RuleDialog.tsx';
import { ruleColumns, type RuleColumns } from './rule-summary.ts';
import { addedChain, newRowKey, type ChainState, type RuleRow } from './table-model.ts';

interface VisualEditorProps {
  family: Family;
  chains: ChainState[];
  counters: readonly string[];
  /** Live counter values of a rule, by handle. */
  counterOf(handle: number): string | undefined;
  /** Rows nft reported errors for. */
  errorRows: ReadonlySet<string>;
  onChange(chains: ChainState[]): void;
}

type Column = Exclude<keyof RuleColumns, 'action' | 'actionTone'> | 'comment';

/** Grid columns after the action; one shows only when a rule of the chain uses it. */
const COLUMNS: readonly { id: Column; label: MessageKey; mono: boolean }[] = [
  { id: 'protocol', label: 'editor.col.protocol', mono: true },
  { id: 'source', label: 'editor.col.source', mono: true },
  { id: 'destination', label: 'editor.col.destination', mono: true },
  { id: 'sourcePort', label: 'editor.col.sourcePort', mono: true },
  { id: 'destinationPort', label: 'editor.col.destinationPort', mono: true },
  { id: 'input', label: 'editor.col.input', mono: true },
  { id: 'output', label: 'editor.col.output', mono: true },
  { id: 'state', label: 'editor.col.state', mono: false },
  { id: 'extra', label: 'editor.col.extra', mono: false },
  { id: 'comment', label: 'editor.col.comment', mono: false },
];

type Cells = RuleColumns & { comment: string };

/** The rules of each chain as a grid, MikroTik style. */
export function VisualEditor({ family, chains, counters, counterOf, errorRows, onChange }: VisualEditorProps) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<{ chain: number; row: number | 'new' } | undefined>();
  const [addingChain, setAddingChain] = useState(false);
  const names = chains.map((state) => state.chain.name);
  // jump and goto lead to regular chains only.
  const targets = chains.filter((state) => state.base === undefined).map((state) => state.chain.name);

  const setRows = (index: number, rows: RuleRow[]) => onChange(chains.map((state, at) => (at === index ? { ...state, rows } : state)));
  const move = (index: number, from: number, to: number) => {
    const rows = [...chains[index]!.rows];
    const [row] = rows.splice(from, 1);
    rows.splice(to, 0, row!);
    setRows(index, rows);
  };

  function save(rule: RuleEdit) {
    if (editing === undefined) return;
    const rows = [...chains[editing.chain]!.rows];
    const form = 'form' in rule ? rule.form : undefined;
    if (editing.row === 'new') {
      rows.push({ key: newRowKey(), handle: undefined, text: rule.text, form, status: 'new' });
    } else {
      const row = rows[editing.row]!;
      if (row.text !== rule.text || row.form === undefined !== (form === undefined)) {
        rows[editing.row] = { ...row, text: rule.text, form, status: row.status === 'new' ? 'new' : 'edited' };
      }
    }
    setRows(editing.chain, rows);
    setEditing(undefined);
  }

  const editingRow = editing === undefined ? undefined : editing.row === 'new' ? 'new' : chains[editing.chain]!.rows[editing.row];

  return (
    <div className={styles.visual}>
      {chains.map((state, chainIndex) => (
        <section key={state.chain.name} className={`card ${styles.chain}`}>
          <header className={styles.chainHeader}>
            <h3 className={`${styles.chainName} mono`}>{state.chain.name}</h3>
            {state.base !== undefined ? (
              <span className={styles.tags}>
                {state.base.type !== undefined && <span className={styles.tag}>{state.base.type}</span>}
                <span className={styles.tag}>hook {state.base.hook}</span>
                {state.base.priority !== undefined && <span className={styles.tag}>priority {state.base.priority}</span>}
              </span>
            ) : (
              <span className={styles.regular}>{t('chain.regular')}</span>
            )}
            {state.isNew && <span className={styles.newBadge}>{t('editor.newChain')}</span>}
            <span className={styles.spacer} />
            {state.policy !== undefined && (
              <label className={styles.policy}>
                policy
                <select className={`select select-compact ${state.policy === 'drop' ? styles.policyDrop : styles.policyAccept}`} value={state.policy}
                  onChange={(event) => onChange(chains.map((other, at) => (at === chainIndex ? { ...other, policy: event.target.value as 'accept' | 'drop' } : other)))}>
                  <option value="accept">accept</option>
                  <option value="drop">drop</option>
                </select>
              </label>
            )}
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing({ chain: chainIndex, row: 'new' })}>
              {t('editor.addRule')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm btn-icon btn-danger" title={t('editor.deleteChain')} aria-label={t('editor.deleteChain')}
              onClick={() => onChange(chains.filter((_, at) => at !== chainIndex))}>
              <TrashIcon />
            </button>
          </header>

          {state.rows.length === 0 ? (
            <p className={styles.empty}>{t(state.policy !== undefined ? 'chain.noRulesBase' : 'chain.noRulesRegular')}</p>
          ) : (
            <Grid
              rows={state.rows}
              counterOf={counterOf}
              errorRows={errorRows}
              onEdit={(row) => setEditing({ chain: chainIndex, row })}
              onMove={(from, to) => move(chainIndex, from, to)}
              onCopy={(row) => {
                const rows = [...state.rows];
                rows.splice(row + 1, 0, { ...rows[row]!, key: newRowKey(), handle: undefined, status: 'new' });
                setRows(chainIndex, rows);
              }}
              onDelete={(row) => setRows(chainIndex, state.rows.filter((_, at) => at !== row))}
            />
          )}
        </section>
      ))}

      {chains.length === 0 && <p className={`card ${styles.empty}`}>{t('editor.noChains')}</p>}
      <div>
        <button type="button" className="btn" onClick={() => setAddingChain(true)}>
          <PlusIcon />
          {t('chain.add')}
        </button>
      </div>

      <ChainDialog
        open={addingChain}
        family={family}
        existing={names}
        onAdd={(name, base) => {
          onChange([...chains, addedChain(name, base)]);
          setAddingChain(false);
        }}
        onClose={() => setAddingChain(false)}
      />

      <RuleDialog
        rule={editingRow === undefined ? undefined : editingRow === 'new' ? 'new' : editingRow.form !== undefined ? { form: editingRow.form, text: editingRow.text } : { text: editingRow.text }}
        family={family}
        chain={editing === undefined ? '' : names[editing.chain]!}
        chains={targets.filter((name) => editing === undefined || name !== names[editing.chain])}
        counters={counters}
        onSave={save}
        onClose={() => setEditing(undefined)}
      />
    </div>
  );
}

interface GridProps {
  rows: readonly RuleRow[];
  counterOf(handle: number): string | undefined;
  errorRows: ReadonlySet<string>;
  onEdit(row: number): void;
  onMove(from: number, to: number): void;
  onCopy(row: number): void;
  onDelete(row: number): void;
}

function Grid({ rows, counterOf, errorRows, onEdit, onMove, onCopy, onDelete }: GridProps) {
  const { t } = useI18n();
  const cells = rows.map((row): Cells | undefined => row.form && { ...ruleColumns(row.form), comment: row.form.comment ?? '' });
  const counters = rows.map((row) => (row.handle !== undefined && row.status === 'same' ? counterOf(row.handle) : undefined));
  const columns = COLUMNS.filter((column) => cells.some((cell) => cell !== undefined && cell[column.id] !== ''));
  const showCounters = counters.some((counter) => counter !== undefined);

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
            {showCounters && <th>{t('editor.col.counter')}</th>}
            <th className={styles.rowActions}>
              <span className="visually-hidden">{t('editor.col.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const cell = cells[index];
            const status = row.status === 'new' ? styles.rowNew : row.status === 'edited' ? styles.rowEdited : undefined;
            return (
              <tr key={row.key} className={errorRows.has(row.key) ? styles.rowError : status} onDoubleClick={() => onEdit(index)}>
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
                {showCounters && <td className={styles.counter}>{counters[index]}</td>}
                <td className={styles.rowActions}>
                  <span className={styles.rowButtons}>
                    <IconButton label={t('editor.up')} disabled={index === 0} onClick={() => onMove(index, index - 1)}>
                      <ArrowUpIcon />
                    </IconButton>
                    <IconButton label={t('editor.down')} disabled={index === rows.length - 1} onClick={() => onMove(index, index + 1)}>
                      <ArrowDownIcon />
                    </IconButton>
                    <IconButton label={t('editor.edit')} onClick={() => onEdit(index)}>
                      <EditIcon />
                    </IconButton>
                    <IconButton label={t('editor.duplicate')} onClick={() => onCopy(index)}>
                      <CopyIcon />
                    </IconButton>
                    <IconButton label={t('editor.delete')} danger onClick={() => onDelete(index)}>
                      <TrashIcon />
                    </IconButton>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function IconButton({ label, danger = false, disabled, onClick, children }: { label: string; danger?: boolean; disabled?: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button type="button" className={`btn btn-ghost btn-sm btn-icon${danger ? ' btn-danger' : ''}`} title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      {children}
    </button>
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
