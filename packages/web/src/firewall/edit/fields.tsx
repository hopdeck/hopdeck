// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRightIcon } from '../../components/icons.tsx';
import { useI18n } from '../../i18n/I18nProvider.tsx';
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

interface ListInputProps {
  value: string;
  onChange(value: string): void;
  label: string;
  placeholder?: string;
  /** What line breaks become, as in a pasted column of addresses: ", " for lists, " " for a rule's text. */
  join?: string;
}

/**
 * A one-line field for lists that unfolds downwards to show its whole value,
 * wrapped, instead of scrolling sideways: a rule may match hundreds of
 * addresses. The button shows once the value is longer than the field.
 */
export function ListInput({ value, onChange, label, placeholder, join = ', ' }: ListInputProps) {
  const { t } = useI18n();
  const field = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);

  useLayoutEffect(() => {
    const element = field.current;
    if (element === null) return;
    const fit = () => {
      if (open) {
        // As tall as its content, borders included.
        element.style.height = 'auto';
        element.style.height = `${element.scrollHeight + element.offsetHeight - element.clientHeight}px`;
      } else {
        element.style.height = '';
      }
      setLong(open || element.scrollWidth > element.clientWidth + 1);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [value, open]);

  return (
    <span className={styles.listInput}>
      <textarea
        ref={field}
        className={`input mono ${styles.listText}${open ? ` ${styles.listOpen}` : ''}`}
        rows={1}
        wrap={open ? 'soft' : 'off'}
        spellCheck={false}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        // One line, whatever is typed or pasted.
        onKeyDown={(event) => event.key === 'Enter' && event.preventDefault()}
        onChange={(event) => onChange(event.target.value.replace(/[,\s]*[\r\n]+[,\s]*/g, join))}
      />
      {long && (
        <button
          type="button"
          className={`btn btn-ghost btn-icon ${styles.listToggle}`}
          aria-expanded={open}
          title={t(open ? 'rule.fieldCollapse' : 'rule.fieldExpand')}
          aria-label={t(open ? 'rule.fieldCollapse' : 'rule.fieldExpand')}
          onClick={() => setOpen(!open)}
        >
          <ChevronRightIcon className={open ? styles.chevronUp : styles.chevronDown} />
        </button>
      )}
    </span>
  );
}
