import { initialLocale } from './i18n/I18nProvider.tsx';
import { MESSAGES, SOURCE_LOCALE } from './i18n/locales.ts';
import { createTranslator } from './i18n/translate.ts';

/**
 * Warns anyone who opens the browser console. Scammers tell people to paste
 * code there to "fix" something; here such code runs with the panel's token,
 * which changes firewalls as root on every host the panel reaches.
 */
export function warnInConsole(): void {
  const locale = initialLocale();
  const t = createTranslator(locale, MESSAGES[locale] ?? {}, MESSAGES[SOURCE_LOCALE] ?? {}, SOURCE_LOCALE);
  const font = 'font-family: system-ui, sans-serif;';
  console.log(`%c${t('console.stop')}`, `${font} color: #e0321b; font-size: 42px; font-weight: 800; -webkit-text-stroke: 1px #000;`);
  console.log(`%c${t('console.warning')}`, `${font} font-size: 15px; line-height: 1.5;`);
  console.log(`%c${t('console.advice')}`, `${font} font-size: 15px; line-height: 1.5; font-weight: 700;`);
}
