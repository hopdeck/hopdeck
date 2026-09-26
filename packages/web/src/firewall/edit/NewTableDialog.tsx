import type { Family } from '@hopdeck/core';
import { useEffect, useRef, useState } from 'react';
import { Segmented } from '../../components/Segmented.tsx';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import type { MessageKey } from '../../i18n/locales.ts';
import styles from './Editor.module.css';
import { Field } from './fields.tsx';
import { HOST_TEMPLATE_FAMILIES, type NewTableSpec } from './table-model.ts';

interface NewTableDialogProps {
  open: boolean;
  /** Tables the host has; a new one needs another family or name. */
  existing: readonly { family: Family; name: string }[];
  /** Whether hopdeck reaches the host over SSH, so the template should keep SSH open. */
  remote: boolean;
  onCreate(family: Family, name: string, spec: NewTableSpec): void;
  onClose(): void;
}

const FAMILIES: readonly Family[] = ['inet', 'ip', 'ip6', 'arp', 'bridge', 'netdev'];
const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Starts a new table in the editor; nothing reaches the host before the review. */
export function NewTableDialog({ open, existing, remote, onCreate, onClose }: NewTableDialogProps) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [family, setFamily] = useState<Family>('inet');
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<NewTableSpec['template']>('host');
  const [ssh, setSsh] = useState(remote);
  const taken = (candidate: string, inFamily: Family) => existing.some((table) => table.family === inFamily && table.name === candidate);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      setFamily('inet');
      setName(taken('filter', 'inet') ? 'hopdeck' : 'filter');
      setTemplate('host');
      setSsh(remote);
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  const hostTemplate = HOST_TEMPLATE_FAMILIES.includes(family);
  const chosen = hostTemplate ? template : 'empty';
  const found: MessageKey[] = [];
  if (!NAME.test(name)) found.push('newTable.problem.name');
  if (taken(name, family)) found.push('newTable.problem.taken');

  return (
    <dialog ref={dialog} className={styles.dialog} onClose={onClose} aria-labelledby="new-table-title">
      <div className={styles.dialogBody}>
        <h2 id="new-table-title" className={styles.dialogTitle}>
          {t('newTable.title')}
        </h2>
        <div className={styles.fields}>
          <Field label={t('newTable.family')}>
            <select className="select" value={family} onChange={(event) => setFamily(event.target.value as Family)}>
              {FAMILIES.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </Field>
          <p className={styles.note}>{t(`newTable.familyHint.${family}`)}</p>
          <Field label={t('newTable.name')}>
            <input className="input mono" value={name} onChange={(event) => setName(event.target.value.trim())} spellCheck={false} />
          </Field>
          <Field label={t('newTable.template')} group>
            <Segmented<NewTableSpec['template']>
              label={t('newTable.template')}
              value={chosen}
              onChange={setTemplate}
              options={[
                { value: 'host', label: t('newTable.templateHost'), disabled: !hostTemplate },
                { value: 'empty', label: t('newTable.templateEmpty') },
              ]}
            />
          </Field>
          <p className={styles.note}>{t(chosen === 'host' ? 'newTable.templateHostHint' : 'newTable.templateEmptyHint')}</p>
          {chosen === 'host' && (
            <label className={styles.option}>
              <input type="checkbox" checked={ssh} onChange={(event) => setSsh(event.target.checked)} />
              {t('newTable.ssh')}
            </label>
          )}
          {chosen === 'host' && remote && !ssh && <p className={styles.problems}>{t('newTable.sshWarning')}</p>}
        </div>
        <p className={styles.note}>{t('newTable.nothingYet')}</p>
        {found.length > 0 && name !== '' && (
          <ul className={styles.problems}>
            {found.map((key) => <li key={key}>{t(key)}</li>)}
          </ul>
        )}
      </div>
      <div className={styles.dialogFooter}>
        <span className={styles.spacer} />
        <button type="button" className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="button" className="btn btn-primary" disabled={found.length > 0} onClick={() => onCreate(family, name, { template: chosen, ssh })}>
          {t('newTable.create')}
        </button>
      </div>
    </dialog>
  );
}
