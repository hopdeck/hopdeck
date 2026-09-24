import { useEffect, useState } from 'react';
import { ApiError, apiGet } from './api.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import { LanguageSelect } from './i18n/LanguageSelect.tsx';

interface Health {
  ok: boolean;
  version: string;
}

type State = { kind: 'loading' } | { kind: 'ready'; health: Health } | { kind: 'error'; error: unknown };

export function App() {
  const { t } = useI18n();
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    apiGet<Health>('/health').then(
      (health) => setState({ kind: 'ready', health }),
      (error: unknown) => setState({ kind: 'error', error }),
    );
  }, []);

  return (
    <main>
      <header>
        <h1>nftm</h1>
        <LanguageSelect />
      </header>
      {state.kind === 'loading' && <p>{t('app.connecting')}</p>}
      {state.kind === 'ready' && <p>{t('app.connected', { version: state.health.version })}</p>}
      {state.kind === 'error' && (
        <p role="alert">
          {state.error instanceof ApiError && state.error.status === 401
            ? t('app.unauthorized')
            : t('app.error', { message: state.error instanceof Error ? state.error.message : String(state.error) })}
        </p>
      )}
    </main>
  );
}
