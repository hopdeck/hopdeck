import { HISTORY_MAX_BYTES, HISTORY_MIN_VERSIONS, type HistoryState } from '@hopdeck/core';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { Callout } from '../components/Callout.tsx';
import { ErrorCallout, toErrorInfo, type ErrorInfo } from '../components/ErrorCallout.tsx';
import { CheckIcon, InfoIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { formatBytes } from '../firewall/ruleset/model.ts';
import styles from './HostView.module.css';

const MIB = 1024 * 1024;

/** Settings kept on the host itself, so everyone who manages it shares them. */
export function HostSettings({ hostId }: { hostId: string }) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<HistoryState>();
  const [megabytes, setMegabytes] = useState('');
  const [error, setError] = useState<ErrorInfo>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const path = `/hosts/${encodeURIComponent(hostId)}`;

  const show = useCallback((history: HistoryState) => {
    setState(history);
    setMegabytes(String(Math.round(history.settings.history.maxBytes / MIB)));
  }, []);

  useEffect(() => {
    api.get<{ history: HistoryState }>(`${path}/history`).then(
      ({ history }) => show(history),
      (caught: unknown) => setError(toErrorInfo(caught)),
    );
  }, [path, show]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      const { history } = await api.post<{ history: HistoryState }>(`${path}/settings`, { history: { maxBytes: Number(megabytes) * MIB } });
      show(history);
      setSaved(true);
    } catch (caught) {
      setError(toErrorInfo(caught));
    } finally {
      setBusy(false);
    }
  }

  if (state === undefined) {
    return error === undefined ? (
      <p className={styles.loading} role="status">
        <span className="spinner" aria-hidden="true" />
        {t('settings.loading')}
      </p>
    ) : (
      <ErrorCallout error={error} />
    );
  }

  const min = HISTORY_MAX_BYTES.min / MIB;
  const max = HISTORY_MAX_BYTES.max / MIB;
  return (
    <section className="card">
      <h2 className={styles.cardTitle}>{t('settings.history')}</h2>
      <div className={styles.settingsBody}>
        {state.problem !== undefined ? (
          <Callout tone="info" icon={<InfoIcon />} title={t('history.unavailable')}>
            <pre className="details">{state.problem.detail}</pre>
          </Callout>
        ) : (
          <form className={styles.settings} onSubmit={(event) => void save(event)}>
            <label className={styles.settingsField}>
              <span>{t('settings.historyLimit')}</span>
              <span className={styles.settingsInput}>
                <input
                  type="number"
                  className="input mono"
                  min={min}
                  max={max}
                  step={1}
                  required
                  value={megabytes}
                  onChange={(event) => {
                    setMegabytes(event.target.value);
                    setSaved(false);
                  }}
                />
                MiB
              </span>
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy || Number(megabytes) * MIB === state.settings.history.maxBytes}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {t('settings.save')}
            </button>
            {saved && (
              <span className={styles.settingsSaved} role="status">
                <CheckIcon />
                {t('settings.saved')}
              </span>
            )}
          </form>
        )}
        <p className={styles.settingsNote}>
          {t('settings.historyUsage', { count: state.versions.length, size: formatBytes(state.size, locale), min: HISTORY_MIN_VERSIONS })}
        </p>
        <p className={styles.settingsNote}>{t('settings.sharedNote', { file: state.settingsFile })}</p>
        {error !== undefined && <ErrorCallout error={error} />}
      </div>
    </section>
  );
}
