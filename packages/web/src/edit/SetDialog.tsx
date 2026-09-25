import { elementProblem, newSetBlock, splitList, type EditableBlock, type SetSpec } from '@nftm/core';
import { useEffect, useRef, useState } from 'react';
import { Segmented } from '../components/Segmented.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/locales.ts';
import { NftCode } from '../ruleset/NftCode.tsx';
import styles from './Editor.module.css';
import { Choice, Field } from './fields.tsx';

interface SetDialogProps {
  open: boolean;
  /** Names of the sets and maps the table has; they share one namespace. */
  existing: readonly string[];
  onAdd(block: EditableBlock): void;
  onClose(): void;
}

const KEY_TYPES = ['ipv4_addr', 'ipv6_addr', 'inet_service', 'ifname', 'ether_addr', 'inet_proto', 'mark', 'ipv4_addr . inet_service'];
const VALUE_TYPES = ['verdict', 'ipv4_addr', 'ipv6_addr', 'inet_service', 'mark', 'ipv4_addr . inet_service'];
const TIMEOUTS = ['1m', '10m', '1h', '1d', '7d'];
const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Declares a named set or map: its types, flags and first elements. */
export function SetDialog({ open, existing, onAdd, onClose }: SetDialogProps) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [opening, setOpening] = useState(0);
  const [kind, setKind] = useState<'set' | 'map'>('set');
  const [name, setName] = useState('');
  const [type, setType] = useState<string | undefined>('ipv4_addr');
  const [value, setValue] = useState<string | undefined>('verdict');
  const [interval, setIntervalFlag] = useState(false);
  const [timeouts, setTimeouts] = useState(false);
  const [timeout, setDefaultTimeout] = useState<string | undefined>();
  const [counter, setCounter] = useState(false);
  const [elements, setElements] = useState('');

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      setOpening((count) => count + 1);
      setKind('set');
      setName('');
      setType('ipv4_addr');
      setValue('verdict');
      setIntervalFlag(false);
      setTimeouts(false);
      setDefaultTimeout(undefined);
      setCounter(false);
      setElements('');
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  const list = splitList(elements);
  const spec: SetSpec = {
    kind,
    name,
    type: type?.trim() || 'ipv4_addr',
    ...(kind === 'map' && { value: value?.trim() || 'verdict' }),
    flags: [...(interval ? ['interval'] : []), ...(timeouts ? ['timeout'] : [])],
    ...(timeouts && timeout !== undefined && { timeout: timeout.trim() }),
    counter,
    elements: list,
  };
  const found: MessageKey[] = [];
  if (!NAME.test(name)) found.push('chain.problem.name');
  if (existing.includes(name)) found.push('set.problem.taken');
  const elementProblems = list.map((element) => elementProblem(element)).filter((problem) => problem !== undefined);
  const block = newSetBlock({ ...spec, name: name || '…' });
  const preview = block.lines.map((line) => line.slice(1)).join('\n');

  return (
    <dialog ref={dialog} className={styles.dialog} onClose={onClose} aria-labelledby="set-title">
      <div key={opening} className={styles.dialogBody}>
        <h2 id="set-title" className={styles.dialogTitle}>
          {t('set.add')}
        </h2>
        <div className={styles.fields}>
          <Field label={t('set.kind')} group>
            <Segmented<'set' | 'map'>
              label={t('set.kind')}
              value={kind}
              onChange={setKind}
              options={[
                { value: 'set', label: t('set.kindSet') },
                { value: 'map', label: t('set.kindMap') },
              ]}
            />
          </Field>
          <p className={styles.note}>{t(kind === 'set' ? 'set.kindSetHint' : 'set.kindMapHint')}</p>
          <Field label={t('chain.name')}>
            <input className="input mono" value={name} onChange={(event) => setName(event.target.value.trim())} spellCheck={false} />
          </Field>
          <Field label={t(kind === 'set' ? 'set.type' : 'set.keyType')} group>
            <Choice label={t(kind === 'set' ? 'set.type' : 'set.keyType')} value={type} options={KEY_TYPES} onChange={setType} />
          </Field>
          {kind === 'map' && (
            <Field label={t('set.valueType')} group>
              <Choice label={t('set.valueType')} value={value} options={VALUE_TYPES} onChange={setValue} />
            </Field>
          )}
          <Field label={t('set.flags')} group>
            <span className={styles.checks}>
              <label className={styles.option} title={t('set.intervalHint')}>
                <input type="checkbox" checked={interval} onChange={(event) => setIntervalFlag(event.target.checked)} />
                {t('set.interval')}
              </label>
              <label className={styles.option}>
                <input type="checkbox" checked={timeouts} onChange={(event) => setTimeouts(event.target.checked)} />
                {t('set.timeouts')}
              </label>
              <label className={styles.option}>
                <input type="checkbox" checked={counter} onChange={(event) => setCounter(event.target.checked)} />
                {t('set.counter')}
              </label>
            </span>
          </Field>
          {timeouts && (
            <Field label={t('set.defaultTimeout')} group>
              <Choice label={t('set.defaultTimeout')} value={timeout} options={TIMEOUTS} empty={t('elements.timeoutNone')} onChange={setDefaultTimeout} />
            </Field>
          )}
          <Field label={t('set.elements')}>
            <input className="input mono" value={elements} placeholder={kind === 'map' ? '22 : accept, 80 : drop' : '192.168.1.10, 10.0.0.0/24'}
              onChange={(event) => setElements(event.target.value)} spellCheck={false} />
          </Field>
          <p className={styles.note}>{t('set.intervalHint')}</p>
        </div>
        <div className={styles.preview}>
          <span className={styles.previewLabel}>{t('rule.preview')}</span>
          <NftCode text={preview} block className={styles.previewCode} />
        </div>
        {(found.length > 0 || elementProblems.length > 0) && name !== '' && (
          <ul className={styles.problems}>
            {found.map((key) => <li key={key}>{t(key)}</li>)}
            {elementProblems.map((problem) => <li key={problem}>{t('elements.problem.invalid')}{problem}</li>)}
          </ul>
        )}
      </div>
      <div className={styles.dialogFooter}>
        <span className={styles.spacer} />
        <button type="button" className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="button" className="btn btn-primary" disabled={found.length > 0 || elementProblems.length > 0} onClick={() => onAdd(newSetBlock(spec))}>
          {t('chain.addOk')}
        </button>
      </div>
    </dialog>
  );
}
