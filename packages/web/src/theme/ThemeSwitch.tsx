// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { useEffect, useState } from 'react';
import { MonitorIcon, MoonIcon, SunIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/locales.ts';
import { applyTheme, loadThemeChoice, onSystemThemeChange, saveThemeChoice, THEME_CHOICES, type ThemeChoice } from './theme.ts';
import styles from './ThemeSwitch.module.css';

const ICONS = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } satisfies Record<ThemeChoice, unknown>;
const LABELS: Record<ThemeChoice, MessageKey> = { system: 'theme.system', light: 'theme.light', dark: 'theme.dark' };

export function ThemeSwitch() {
  const { t } = useI18n();
  const [choice, setChoice] = useState(loadThemeChoice);

  useEffect(() => {
    applyTheme(choice);
    saveThemeChoice(choice);
    return choice === 'system' ? onSystemThemeChange(() => applyTheme('system')) : undefined;
  }, [choice]);

  return (
    <div className={styles.group} role="group" aria-label={t('theme.label')}>
      {THEME_CHOICES.map((option) => {
        const Icon = ICONS[option];
        return (
          <button
            key={option}
            type="button"
            className={styles.option}
            aria-pressed={choice === option}
            title={t(LABELS[option])}
            onClick={() => setChoice(option)}
          >
            <Icon />
            <span className="visually-hidden">{t(LABELS[option])}</span>
          </button>
        );
      })}
    </div>
  );
}
