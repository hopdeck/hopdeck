// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { useId, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/locales.ts';
import { EyeIcon, EyeOffIcon } from './icons.tsx';
import styles from './PasswordField.module.css';

interface PasswordFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'id'> {
  label: string;
  /** For a field whose placeholder says what it is. */
  hiddenLabel?: boolean;
  /** The field takes the width it is given, not its own. */
  wide?: boolean;
}

/**
 * A password field that can show what it holds, and says what makes a right
 * password arrive wrong: Caps Lock, or a space at either end, as a copied
 * line brings. The value goes as typed; nothing trims it.
 */
export function PasswordField({ label, hiddenLabel = false, wide = false, className, onKeyDown, onKeyUp, onChange, autoComplete, ...input }: PasswordFieldProps) {
  const { t } = useI18n();
  const id = useId();
  const [shown, setShown] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  // What an uncontrolled field holds, as typed.
  const [typed, setTyped] = useState('');
  const value = typeof input.value === 'string' ? input.value : typed;

  const notes: MessageKey[] = [];
  if (capsLock) notes.push('password.capsLock');
  const [leading, trailing] = [/^\s/.test(value), /\s$/.test(value)];
  if (leading || trailing) notes.push(leading && trailing ? 'password.spaceBoth' : leading ? 'password.spaceStart' : 'password.spaceEnd');

  function keys(event: KeyboardEvent<HTMLInputElement>) {
    setCapsLock(event.getModifierState('CapsLock'));
  }

  return (
    <div className={[className, wide && styles.wide].filter(Boolean).join(' ')}>
      <label htmlFor={id} className={hiddenLabel ? 'visually-hidden' : undefined}>
        {label}
      </label>
      <span className={styles.row}>
        <span className={styles.box}>
          <input
            {...input}
            id={id}
            className="input"
            type={shown ? 'text' : 'password'}
            // Shown, it is a text field: no form history, no spell checker that sends words away.
            autoComplete={shown ? 'off' : autoComplete}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-describedby={`${id}-notes`}
            onKeyDown={(event) => {
              keys(event);
              onKeyDown?.(event);
            }}
            onKeyUp={(event) => {
              keys(event);
              onKeyUp?.(event);
            }}
            onChange={(event) => {
              setTyped(event.target.value);
              onChange?.(event);
            }}
          />
          <button
            type="button"
            className={`btn btn-ghost btn-sm btn-icon ${styles.toggle}`}
            aria-label={t('password.show')}
            title={t('password.show')}
            aria-pressed={shown}
            onClick={() => setShown(!shown)}
          >
            {shown ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </span>
        <span id={`${id}-notes`} className={styles.notes} role="status">
          {notes.map((note) => t(note)).join(' · ')}
        </span>
      </span>
    </div>
  );
}
