import { elementParts, elementProblem, splitList, type Family, type SetBlock, type TableChange } from '@nftm/core';
import { useEffect, useRef, useState } from 'react';
import { CloseIcon, TrashIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import styles from './Editor.module.css';
import { Choice, Field } from './fields.tsx';

interface ElementsDialogProps {
  family: Family;
  table: string;
  /** The set or map as nft lists it; undefined keeps the dialog closed. */
  set: SetBlock | undefined;
  /** Regular chains of the table, for verdict maps. */
  chains: readonly string[];
  onReview(change: Extract<TableChange, { kind: 'elements' }>): void;
  onClose(): void;
}

const TIMEOUTS = ['1m', '10m', '1h', '1d', '7d'];
const VERDICTS = ['accept', 'drop', 'return', 'continue'];
/** Beyond this many matching elements, the list asks for a narrower search. */
const SHOWN = 300;

/** Elements of one set or map, added and removed in place, like a MikroTik address list. */
export function ElementsDialog({ family, table, set, chains, onReview, onClose }: ElementsDialogProps) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [remove, setRemove] = useState<string[]>([]);
  const [add, setAdd] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [entry, setEntry] = useState('');
  const [value, setValue] = useState<string | undefined>();
  const [timeout, setElementTimeout] = useState<string | undefined>();
  const [comment, setComment] = useState('');

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (set !== undefined && !element.open) {
      setRemove([]);
      setAdd([]);
      setSearch('');
      setEntry('');
      setValue(undefined);
      setElementTimeout(undefined);
      setComment('');
      element.showModal();
    } else if (set === undefined && element.open) {
      element.close();
    }
  }, [set]);

  const map = set?.kind === 'map';
  const type = set?.declaration.find((line) => line.startsWith('type ')) ?? '';
  const verdictMap = map && type.endsWith(': verdict');
  const timeouts = set?.declaration.some((line) => /^timeout /.test(line) || /^flags .*\btimeout\b/.test(line)) ?? false;
  const defaultTimeout = set?.declaration.find((line) => line.startsWith('timeout '))?.slice('timeout '.length);
  const existing = set?.elements.map((element) => ({ element, parts: elementParts(element, map) })) ?? [];
  const keys = new Set(existing.map((item) => item.parts.key));
  const query = search.trim().toLowerCase();
  const matching = existing.filter((item) => query === '' || item.element.toLowerCase().includes(query));
  const showCounters = existing.some((item) => item.parts.counter !== undefined);

  // What the add row would add: one element per comma-separated value.
  const suffix = `${timeout ? ` timeout ${timeout.trim()}` : ''}${comment ? ` comment "${comment}"` : ''}${map && value ? ` : ${value.trim()}` : ''}`;
  const typed = splitList(entry).map((key) => `${key}${suffix}`);
  const entryProblem =
    entry.trim() === ''
      ? undefined
      : comment.includes('"')
        ? t('elements.problem.quote')
        : map && !value?.trim()
          ? t('elements.problem.value')
          : (typed.map((element) => elementProblem(element)).find(Boolean)?.replace(/^/, t('elements.problem.invalid')) ??
            (typed.some((element) => keys.has(elementParts(element, map).key) && !remove.includes(elementParts(element, map).key))
              ? t('elements.problem.exists')
              : undefined));

  function addTyped() {
    if (entry.trim() === '' || entryProblem !== undefined) return;
    setAdd((current) => [...current, ...typed.filter((element) => !current.includes(element))]);
    setEntry('');
    setComment('');
  }

  const toggle = (key: string) => setRemove((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
  const pending = add.length + remove.length;

  return (
    <dialog ref={dialog} className={`${styles.dialog} ${styles.wideDialog}`} onClose={onClose} aria-labelledby="elements-title">
      {set !== undefined && (
        <div className={styles.dialogBody}>
          <div>
            <h2 id="elements-title" className={styles.dialogTitle}>
              {t(map ? 'elements.titleMap' : 'elements.titleSet', { name: set.name })}
            </h2>
            <p className={`${styles.note} mono`}>
              {family} {table} · {set.declaration.join(' · ')}
            </p>
          </div>

          <div className={styles.addRow}>
            <Field label={t('elements.add')} group>
              <span className={styles.inline}>
                <input
                  className="input mono"
                  value={entry}
                  placeholder={map ? '22, 80' : '192.168.1.10, 10.0.0.0/24'}
                  aria-label={t('elements.add')}
                  spellCheck={false}
                  onChange={(event) => setEntry(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addTyped();
                    }
                  }}
                />
              </span>
            </Field>
            {map && (
              <Field label={t('elements.value')} group>
                {verdictMap ? (
                  <Choice label={t('elements.value')} value={value} options={[...VERDICTS, ...chains.flatMap((chain) => [`jump ${chain}`, `goto ${chain}`])]} empty="—" onChange={setValue} />
                ) : (
                  <input className="input mono" value={value ?? ''} aria-label={t('elements.value')} onChange={(event) => setValue(event.target.value || undefined)} />
                )}
              </Field>
            )}
            {timeouts && (
              <Field label={t('elements.timeout')} group>
                <Choice
                  label={t('elements.timeout')}
                  value={timeout}
                  options={TIMEOUTS}
                  empty={defaultTimeout === undefined ? t('elements.timeoutNone') : t('elements.timeoutDefault', { timeout: defaultTimeout })}
                  onChange={setElementTimeout}
                />
              </Field>
            )}
            <Field label={t('elements.comment')}>
              <input className="input" value={comment} maxLength={128} onChange={(event) => setComment(event.target.value)} />
            </Field>
            <div className={styles.addActions}>
              {entryProblem !== undefined && <span className={styles.problemText}>{entryProblem}</span>}
              <button type="button" className="btn" disabled={entry.trim() === '' || entryProblem !== undefined} onClick={addTyped}>
                {t('elements.addButton', { count: Math.max(typed.length, 1) })}
              </button>
            </div>
          </div>

          {existing.length > 10 && (
            <input className="input" type="search" value={search} placeholder={t('elements.search')} aria-label={t('elements.search')}
              onChange={(event) => setSearch(event.target.value)} />
          )}

          {existing.length === 0 && add.length === 0 ? (
            <p className={styles.note}>{t('elements.empty')}</p>
          ) : (
            <div className={styles.gridScroll}>
              <table className={styles.grid}>
                <thead>
                  <tr>
                    <th>{t(map ? 'elements.col.key' : 'elements.col.element')}</th>
                    {map && <th>{t('elements.value')}</th>}
                    {timeouts && <th>{t('elements.timeout')}</th>}
                    {timeouts && <th>{t('elements.col.expires')}</th>}
                    <th>{t('elements.comment')}</th>
                    {showCounters && <th>{t('editor.col.counter')}</th>}
                    <th className={styles.rowActions}>
                      <span className="visually-hidden">{t('editor.col.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {add.map((element) => {
                    const parts = elementParts(element, map);
                    return (
                      <tr key={`add ${element}`} className={styles.rowNew}>
                        <td className="mono">{parts.key}</td>
                        {map && <td className="mono">{parts.value}</td>}
                        {timeouts && <td className="mono">{parts.timeout ?? defaultTimeout ?? ''}</td>}
                        {timeouts && <td />}
                        <td className={styles.comment}>{parts.comment}</td>
                        {showCounters && <td />}
                        <td className={styles.rowActions}>
                          <button type="button" className="btn btn-ghost btn-sm btn-icon" title={t('elements.undo')} aria-label={t('elements.undo')}
                            onClick={() => setAdd((current) => current.filter((item) => item !== element))}>
                            <CloseIcon />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {matching.slice(0, SHOWN).map(({ element, parts }) => {
                    const removed = remove.includes(parts.key);
                    return (
                      <tr key={element} className={removed ? styles.rowRemoved : undefined}>
                        <td className="mono">{parts.key}</td>
                        {map && <td className="mono">{parts.value}</td>}
                        {timeouts && <td className="mono">{parts.timeout ?? ''}</td>}
                        {timeouts && <td className="mono">{parts.expires?.replace(/(?<=\D)\d+ms$/, '') ?? ''}</td>}
                        <td className={styles.comment}>{parts.comment}</td>
                        {showCounters && (
                          <td className={styles.counter}>{parts.counter && `${parts.counter.packets} / ${parts.counter.bytes} B`}</td>
                        )}
                        <td className={styles.rowActions}>
                          <button type="button" className={`btn btn-ghost btn-sm btn-icon${removed ? '' : ' btn-danger'}`}
                            title={t(removed ? 'elements.undo' : 'elements.remove')} aria-label={t(removed ? 'elements.undo' : 'elements.remove')}
                            onClick={() => toggle(parts.key)}>
                            {removed ? <CloseIcon /> : <TrashIcon />}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {matching.length > SHOWN && <p className={styles.note}>{t('elements.more', { shown: SHOWN, total: matching.length })}</p>}
        </div>
      )}
      <div className={styles.dialogFooter}>
        <span className={styles.note}>{pending > 0 && t('elements.pending', { add: add.length, remove: remove.length })}</span>
        <span className={styles.spacer} />
        <button type="button" className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending === 0 || set === undefined}
          onClick={() => set && onReview({ kind: 'elements', family, table, set: set.name, setKind: set.kind, add, remove })}
        >
          {t('editor.review')}
        </button>
      </div>
    </dialog>
  );
}
