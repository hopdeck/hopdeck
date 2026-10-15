// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { LOCALES, MESSAGES, SOURCE_LOCALE, type MessageKey } from './locales.ts';
import { createTranslator, pickLocale, type Vars } from './translate.ts';

export interface I18n {
  locale: string;
  locales: readonly string[];
  setLocale(locale: string): void;
  t(key: MessageKey, vars?: Vars): string;
}

const STORAGE_KEY = 'hopdeck.locale';
const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState(initialLocale);

  const i18n = useMemo<I18n>(
    () => ({
      locale,
      locales: LOCALES,
      setLocale(next) {
        setLocale(next);
        saveLocale(next);
      },
      t: createTranslator(locale, MESSAGES[locale] ?? {}, MESSAGES[SOURCE_LOCALE] ?? {}, SOURCE_LOCALE),
    }),
    [locale],
  );

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return <I18nContext value={i18n}>{children}</I18nContext>;
}

export function useI18n(): I18n {
  const i18n = useContext(I18nContext);
  if (i18n === null) throw new Error('useI18n must be used inside <I18nProvider>');
  return i18n;
}

/** The saved choice, else the browser's preferred languages, else English. */
export function initialLocale(): string {
  const saved = loadLocale();
  if (saved !== null && saved in MESSAGES) return saved;
  return pickLocale(navigator.languages, LOCALES, SOURCE_LOCALE);
}

// Storage can be unavailable (private windows, blocked site data); the choice
// is a convenience, so failures are ignored.
function loadLocale(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveLocale(locale: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // ignored, see above
  }
}
