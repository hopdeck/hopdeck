import { describe, expect, it } from 'vitest';
import { createTranslator, extraKeys, missingKeys, pickLocale } from './translate.ts';

const en = {
  greeting: 'Hello {{name}}',
  'rules.count_one': '{{count}} rule',
  'rules.count_other': '{{count}} rules',
  onlyEnglish: 'Only in English',
};

const pl = {
  greeting: 'Cześć {{name}}',
  'rules.count_one': '{{count}} reguła',
  'rules.count_few': '{{count}} reguły',
  'rules.count_many': '{{count}} reguł',
  'rules.count_other': '{{count}} reguły',
};

describe('createTranslator', () => {
  const t = createTranslator('pl', pl, en);

  it('interpolates variables and leaves unknown ones visible', () => {
    expect(t('greeting', { name: 'Ala' })).toBe('Cześć Ala');
    expect(t('greeting')).toBe('Cześć {{name}}');
  });

  it('chooses the plural form of the language', () => {
    const forms = [1, 2, 5, 12, 22, 1.5].map((count) => t('rules.count', { count }));
    expect(forms).toEqual(['1 reguła', '2 reguły', '5 reguł', '12 reguł', '22 reguły', '1.5 reguły']);
  });

  it('falls back to English, then to the key', () => {
    expect(t('onlyEnglish')).toBe('Only in English');
    expect(t('nowhere')).toBe('nowhere');
    const partial = createTranslator('pl', { 'rules.count_one': '{{count}} reguła' }, en);
    expect(partial('rules.count', { count: 7 })).toBe('7 rules');
  });
});

describe('pickLocale', () => {
  it('matches full tags, then languages, then falls back', () => {
    expect(pickLocale(['pl-PL', 'en-US'], ['en', 'pl'], 'en')).toBe('pl');
    expect(pickLocale(['PT-br'], ['en', 'pt-BR', 'pt'], 'en')).toBe('pt-BR');
    expect(pickLocale(['de-DE', 'fr'], ['en', 'pl'], 'en')).toBe('en');
  });
});

describe('missingKeys and extraKeys', () => {
  it('require every plural form the language uses', () => {
    expect(missingKeys('pl', pl, en)).toEqual(['onlyEnglish']);
    const { ['rules.count_few']: _few, ...withoutFew } = pl;
    expect(missingKeys('pl', withoutFew, en)).toEqual(['rules.count_few', 'onlyEnglish']);
  });

  it('report keys that English no longer has', () => {
    expect(extraKeys({ ...pl, removed: 'x' }, en)).toEqual(['removed']);
    expect(extraKeys(pl, en)).toEqual([]);
  });
});
