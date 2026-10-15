// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

/**
 * Minimal i18n without dependencies. Locale files are flat JSON objects in the
 * i18next v4 JSON format, so translation platforms such as Weblate can read
 * them directly:
 *
 *   "hosts.title": "Hosts"                  plain text
 *   "host.connected": "Connected to {{name}}"  interpolation
 *   "rules.count_one": "{{count}} rule"     plural forms, chosen with
 *   "rules.count_other": "{{count}} rules"  Intl.PluralRules for `count`
 */

export type Messages = Readonly<Record<string, string>>;
export type Vars = Readonly<Record<string, string | number>>;
export type Translate = (key: string, vars?: Vars) => string;

/** Missing texts fall back to the fallback messages, then to the key itself. */
export function createTranslator(locale: string, messages: Messages, fallback: Messages, fallbackLocale = 'en'): Translate {
  const rules = new Intl.PluralRules(locale);
  const fallbackRules = new Intl.PluralRules(fallbackLocale);
  return (key, vars) => {
    const count = typeof vars?.['count'] === 'number' ? vars['count'] : undefined;
    const text = resolve(messages, rules, key, count) ?? resolve(fallback, fallbackRules, key, count) ?? key;
    return interpolate(text, vars);
  };
}

/** Picks the first available locale that matches a preference by full tag or by language. */
export function pickLocale(preferred: readonly string[], available: readonly string[], fallback: string): string {
  for (const tag of preferred) {
    const wanted = tag.toLowerCase();
    const match =
      available.find((code) => code.toLowerCase() === wanted) ??
      available.find((code) => code.toLowerCase() === wanted.split('-')[0]);
    if (match !== undefined) return match;
  }
  return fallback;
}

/**
 * Keys of `reference` that `messages` lacks. For plural keys, `locale` needs
 * every plural form its language uses, e.g. one/few/many/other for Polish.
 */
export function missingKeys(locale: string, messages: Messages, reference: Messages): string[] {
  const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  const required = new Set<string>();
  for (const key of Object.keys(reference)) {
    const base = pluralBase(key, reference);
    if (base === undefined) required.add(key);
    else for (const category of categories) required.add(`${base}_${category}`);
  }
  return [...required].filter((key) => !(key in messages));
}

/** Keys of `messages` that no longer exist in `reference`. */
export function extraKeys(messages: Messages, reference: Messages): string[] {
  return Object.keys(messages).filter((key) => {
    const base = pluralBase(key, messages);
    return base === undefined ? !(key in reference) : !(`${base}_other` in reference);
  });
}

function resolve(messages: Messages, rules: Intl.PluralRules, key: string, count: number | undefined) {
  if (count === undefined) return messages[key];
  return messages[`${key}_${rules.select(count)}`] ?? messages[`${key}_other`] ?? messages[key];
}

function interpolate(text: string, vars: Vars | undefined): string {
  if (vars === undefined) return text;
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** "rules.count_few" is a plural form when "rules.count_other" exists. */
function pluralBase(key: string, messages: Messages): string | undefined {
  const match = /^(.+)_(zero|one|two|few|many|other)$/.exec(key);
  return match !== null && `${match[1]}_other` in messages ? match[1] : undefined;
}
