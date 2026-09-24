import { describe, expect, it } from 'vitest';
import { LOCALES, MESSAGES, SOURCE_LOCALE, languageName } from './locales.ts';
import { extraKeys, missingKeys } from './translate.ts';

// A new language only needs a JSON file; these tests tell its author what is
// missing or outdated.
describe.each(LOCALES.filter((locale) => locale !== SOURCE_LOCALE))('locale %s', (locale) => {
  const source = MESSAGES[SOURCE_LOCALE]!;
  const messages = MESSAGES[locale]!;

  it('translates every English key', () => {
    expect(missingKeys(locale, messages, source)).toEqual([]);
  });

  it('has no keys that English no longer has', () => {
    expect(extraKeys(messages, source)).toEqual([]);
  });

  it('keeps the same {{variables}} as English', () => {
    const variables = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
    for (const [key, text] of Object.entries(messages)) {
      const english = source[key] ?? source[key.replace(/_(zero|one|two|few|many)$/, '_other')];
      if (english !== undefined) expect(variables(text), key).toEqual(variables(english));
    }
  });
});

describe('locales', () => {
  it('include English and Polish with their own names', () => {
    expect(LOCALES).toEqual(expect.arrayContaining(['en', 'pl']));
    expect(languageName('en')).toBe('English');
    expect(languageName('pl')).toBe('Polski');
  });
});
