// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { dropLogPrefix, dropLogRule, parseSetBlock, renderRule, type Family } from '@hopdeck/core';
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowDownIcon, ArrowUpIcon, CopyIcon, EditIcon, PlusIcon, TrashIcon } from '../../components/icons.tsx';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import styles from './Editor.module.css';
import { ChainDialog } from './ChainDialog.tsx';
import { SetDialog } from './SetDialog.tsx';
import { RuleDialog, type RuleEdit } from './RuleDialog.tsx';
import { RuleGrid } from './RuleGrid.tsx';
import { addedChain, newRowKey, type ChainState, type RuleRow, type SetState } from './table-model.ts';

interface VisualEditorProps {
  family: Family;
  /** The table's name, for the prefix of the rule that logs what a chain drops. */
  table: string;
  chains: ChainState[];
  sets: SetState[];
  counters: readonly string[];
  /** Live counter values of a rule, by handle. */
  counterOf(handle: number): string | undefined;
  /** Rows nft reported errors for. */
  errorRows: ReadonlySet<string>;
  onChange(chains: ChainState[]): void;
  onSetsChange(sets: SetState[]): void;
}

/** The rules of each chain as a grid, MikroTik style. */
export function VisualEditor({ family, table, chains, sets, counters, counterOf, errorRows, onChange, onSetsChange }: VisualEditorProps) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<{ chain: number; row: number | 'new' } | undefined>();
  const [addingChain, setAddingChain] = useState(false);
  const [addingSet, setAddingSet] = useState(false);
  const [editingSet, setEditingSet] = useState<SetState>();
  // A rule just added at the end of its chain, to bring into view: it may land below the screen.
  const [reveal, setReveal] = useState<string>();

  useEffect(() => {
    if (reveal === undefined) return;
    setReveal(undefined);
    const row = document.querySelector(`[data-row="${CSS.escape(reveal)}"]`);
    if (row === null) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    row.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    if (!reduceMotion) row.animate([{ backgroundColor: 'var(--accent-soft)' }, { backgroundColor: 'transparent' }], { duration: 1800 });
  }, [reveal]);
  const names = chains.map((state) => state.chain.name);
  const setInfos = sets.flatMap((state) => {
    const { kind, name, lines } = state.block;
    if (kind !== 'set' && kind !== 'map') return [];
    const parsed = parseSetBlock(lines.map((line) => line.replace(/^\t/, '')).join('\n'));
    return [{ kind: kind as 'set' | 'map', name, declaration: parsed?.declaration ?? [] }];
  });
  // jump and goto lead to regular chains only.
  const targets = chains.filter((state) => state.base === undefined).map((state) => state.chain.name);

  const setRows = (index: number, rows: RuleRow[]) => onChange(chains.map((state, at) => (at === index ? { ...state, rows } : state)));
  /** Puts last in the chain the rule that counts and logs what its policy drops; see dropLogRule(). */
  const logDrops = (index: number) => {
    const state = chains[index]!;
    const form = dropLogRule(dropLogPrefix(family, table, state.chain.name));
    const key = newRowKey();
    setRows(index, [...state.rows, { key, handle: undefined, text: renderRule(form, family), form, status: 'new' }]);
    setReveal(key);
  };
  const logsDrops = (state: ChainState) => {
    const prefix = dropLogPrefix(family, table, state.chain.name);
    return state.rows.some((row) => row.form?.log?.prefix === prefix || row.text.includes(`log prefix "${prefix}"`));
  };
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
      const key = newRowKey();
      rows.push({ key, handle: undefined, text: rule.text, form, status: 'new' });
      setReveal(key);
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
      <section className={`card ${styles.chain}`}>
        <header className={styles.chainHeader}>
          <h3 className={styles.chainName}>{t('ruleset.setsAndMaps')}</h3>
          <span className={styles.spacer} />
          <button type="button" className="btn btn-sm" onClick={() => setAddingSet(true)}>
            <PlusIcon />
            {t('set.add')}
          </button>
        </header>
        {sets.length === 0 ? (
          <p className={styles.empty}>{t('editor.noSets')}</p>
        ) : (
          <ul className={styles.setList}>
            {sets.map((state) => {
              const parsed = parseSetBlock(state.block.lines.map((line) => line.replace(/^\t/, '')).join('\n'));
              const key = `${state.block.kind} ${state.block.name}`;
              return (
                <li key={key} className={styles.setRow}>
                  <span className={styles.tag}>{state.block.kind}</span>
                  <span className={`${styles.chainName} mono`}>{state.block.name}</span>
                  <span className={styles.regular}>
                    {[...(parsed?.declaration ?? []), t('counts.elements', { count: parsed?.elements.length ?? 0 })].join(' · ')}
                  </span>
                  {state.isNew && <span className={styles.newBadge}>{t('editor.newChain')}</span>}
                  {state.edited && !state.isNew && <span className={styles.editedBadge}>{t('editor.edited')}</span>}
                  <span className={styles.spacer} />
                  <button type="button" className="btn btn-ghost btn-sm btn-icon" title={t('editor.editSet')} aria-label={t('editor.editSet')}
                    onClick={() => setEditingSet(state)}>
                    <EditIcon />
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm btn-icon btn-danger" title={t('editor.deleteSet')} aria-label={t('editor.deleteSet')}
                    onClick={() => onSetsChange(sets.filter((other) => other !== state))}>
                    <TrashIcon />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className={`${styles.note} ${styles.setsNote}`}>{t('editor.setsNote')}</p>
      </section>

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
            {state.base !== undefined && state.policy === 'drop' && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={logsDrops(state)}
                title={t(logsDrops(state) ? 'editor.logDropsDone' : 'editor.logDropsHint')}
                onClick={() => logDrops(chainIndex)}
              >
                {t('editor.logDrops')}
              </button>
            )}
            <button type="button" className="btn btn-sm" onClick={() => setEditing({ chain: chainIndex, row: 'new' })}>
              <PlusIcon />
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
            <RuleGrid
              rows={state.rows.map((row) => ({
                key: row.key,
                text: row.text,
                form: row.form,
                status: row.status,
                error: errorRows.has(row.key),
                counter: row.handle !== undefined && row.status === 'same' ? counterOf(row.handle) : undefined,
              }))}
              onOpen={(row) => setEditing({ chain: chainIndex, row })}
              actions={(index) => (
                <span className={styles.rowButtons}>
                  <IconButton label={t('editor.up')} disabled={index === 0} onClick={() => move(chainIndex, index, index - 1)}>
                    <ArrowUpIcon />
                  </IconButton>
                  <IconButton label={t('editor.down')} disabled={index === state.rows.length - 1} onClick={() => move(chainIndex, index, index + 1)}>
                    <ArrowDownIcon />
                  </IconButton>
                  <IconButton label={t('editor.edit')} onClick={() => setEditing({ chain: chainIndex, row: index })}>
                    <EditIcon />
                  </IconButton>
                  <IconButton label={t('editor.duplicate')}
                    onClick={() => {
                      const rows = [...state.rows];
                      rows.splice(index + 1, 0, { ...rows[index]!, key: newRowKey(), handle: undefined, status: 'new' });
                      setRows(chainIndex, rows);
                    }}>
                    <CopyIcon />
                  </IconButton>
                  <IconButton label={t('editor.delete')} danger onClick={() => setRows(chainIndex, state.rows.filter((_, at) => at !== index))}>
                    <TrashIcon />
                  </IconButton>
                </span>
              )}
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

      <SetDialog
        open={addingSet || editingSet !== undefined}
        initial={editingSet?.block}
        existing={sets.map((state) => state.block.name)}
        onSave={(block) => {
          if (editingSet === undefined) {
            onSetsChange([...sets, { block, isNew: true }]);
          } else if (block.lines.join('\n') !== editingSet.block.lines.join('\n')) {
            onSetsChange(sets.map((state) => (state === editingSet ? { ...state, block, edited: true } : state)));
          }
          setAddingSet(false);
          setEditingSet(undefined);
        }}
        onClose={() => {
          setAddingSet(false);
          setEditingSet(undefined);
        }}
      />

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
        sets={setInfos}
        onSave={save}
        onClose={() => setEditing(undefined)}
      />
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
