// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

const STORAGE_KEY = 'hopdeck.theme';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

/**
 * Sets <html data-theme> to the resolved theme, "light" or "dark"; the CSS
 * only knows those two. With "system" it follows the operating system.
 */
export function applyTheme(choice: ThemeChoice): void {
  const dark = choice === 'dark' || (choice === 'system' && systemDark.matches);
  document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
}

/** Calls `listener` when the operating system switches between light and dark. */
export function onSystemThemeChange(listener: () => void): () => void {
  systemDark.addEventListener('change', listener);
  return () => systemDark.removeEventListener('change', listener);
}

// Storage can be unavailable (private windows, blocked site data); the choice
// is a convenience, so failures fall back to the system theme.
export function loadThemeChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return THEME_CHOICES.includes(saved as ThemeChoice) ? (saved as ThemeChoice) : 'system';
  } catch {
    return 'system';
  }
}

export function saveThemeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // ignored, see loadThemeChoice
  }
}
