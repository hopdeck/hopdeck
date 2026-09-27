// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type en from './locales/en.json';
import type { Messages } from './translate.ts';

/** English is the source language: every other locale translates its keys. */
export const SOURCE_LOCALE = 'en';

// Every JSON file in ./locales is a language, named by its BCP 47 tag
// (en.json, pl.json, pt-BR.json). Adding a file is all it takes.
const files = import.meta.glob<Messages>('./locales/*.json', { eager: true, import: 'default' });

export const MESSAGES: Readonly<Record<string, Messages>> = Object.fromEntries(
  Object.entries(files).map(([path, messages]) => [path.slice('./locales/'.length, -'.json'.length), messages]),
);

export const LOCALES: readonly string[] = Object.keys(MESSAGES).sort();

type PluralSuffix = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
type BaseKey<K extends string> = K extends `${infer Base}_${PluralSuffix}` ? Base : K;

/** Keys of the English locale, with plural suffixes removed. */
export type MessageKey = BaseKey<keyof typeof en & string>;

/** The language's own name, e.g. "Polski" for pl. */
export function languageName(locale: string): string {
  const name = new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;
  return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
}
