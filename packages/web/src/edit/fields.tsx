import { useId, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider.tsx';
import styles from './Editor.module.css';

/** A labelled row; `group` for several controls, which cannot share one <label>. */
export function Field({ label, group = false, children }: { label: string; group?: boolean; children: ReactNode }) {
  const id = useId();
  if (group) {
    return (
      <div className={styles.field} role="group" aria-labelledby={id}>
        <span id={id} className={styles.fieldLabel}>{label}</span>
        <span className={styles.fieldControl}>{children}</span>
      </div>
    );
  }
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.fieldControl}>{children}</span>
    </label>
  );
}

const CUSTOM = '\u0000custom';

interface ChoiceProps {
  label: string;
  value: string | undefined;
  options: readonly string[];
  /** Label of the empty choice; without it a value is required. */
  empty?: string;
  onChange(value: string | undefined): void;
}

/** A list of common values, plus "other" to type any value nft accepts. */
export function Choice({ label, value, options, empty, onChange }: ChoiceProps) {
  const { t } = useI18n();
  const [typing, setTyping] = useState(value !== undefined && !options.includes(value));
  const custom = typing || (value !== undefined && !options.includes(value));
  return (
    <span className={styles.inline}>
      <select
        className="select"
        aria-label={label}
        value={custom ? CUSTOM : (value ?? '')}
        onChange={(event) => {
          const next = event.target.value;
          setTyping(next === CUSTOM);
          if (next !== CUSTOM) onChange(next === '' ? undefined : next);
        }}
      >
        {empty !== undefined && <option value="">{empty}</option>}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
        <option value={CUSTOM}>{t('rule.other')}</option>
      </select>
      {custom && (
        <input className="input mono" aria-label={label} value={value ?? ''} autoFocus spellCheck={false}
          onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)} />
      )}
    </span>
  );
}
