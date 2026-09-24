import { useI18n } from './I18nProvider.tsx';
import { languageName } from './locales.ts';

export function LanguageSelect() {
  const { locale, locales, setLocale, t } = useI18n();
  return (
    <label>
      <span className="visually-hidden">{t('language.label')}</span>
      <select className="select select-compact" value={locale} onChange={(event) => setLocale(event.target.value)}>
        {locales.map((code) => (
          <option key={code} value={code} lang={code}>
            {languageName(code)}
          </option>
        ))}
      </select>
    </label>
  );
}
