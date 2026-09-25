import type { PersistedTable, PersistenceStatus } from '@nftm/core';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Callout } from '../components/Callout.tsx';
import { ErrorCallout, toErrorInfo, type ErrorInfo } from '../components/ErrorCallout.tsx';
import { AlertIcon, CheckIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/locales.ts';
import styles from './Persistence.module.css';

const STATES: Record<PersistedTable['state'], MessageKey> = {
  saved: 'persist.state.saved',
  differs: 'persist.state.differs',
  missing: 'persist.state.missing',
  orphaned: 'persist.state.orphaned',
};

/**
 * What survives a reboot: the managed tables saved in /etc/nftm, whether the
 * boot configuration loads them, and whether anything loads it at all.
 * `version` changes whenever the ruleset was read again.
 */
export function PersistencePanel({ hostId, version }: { hostId: string; version: unknown }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<PersistenceStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorInfo>();
  const path = `/hosts/${encodeURIComponent(hostId)}/persistence`;

  const load = useCallback(async () => {
    try {
      setStatus((await api.get<{ persistence: PersistenceStatus }>(path)).persistence);
      setError(undefined);
    } catch (caught) {
      setError(toErrorInfo(caught));
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load, version]);

  async function act(action: 'save' | 'include' | 'service') {
    setBusy(true);
    setError(undefined);
    try {
      setStatus((await api.post<{ persistence: PersistenceStatus }>(`${path}/${action}`)).persistence);
    } catch (caught) {
      setError(toErrorInfo(caught));
    } finally {
      setBusy(false);
    }
  }

  if (error !== undefined && status === undefined) return <ErrorCallout error={error} />;
  // Nothing managed, nothing to keep across a reboot.
  if (status === undefined || status.tables.length === 0) return null;

  const file = status.mainConfig ?? '';
  const unsaved = status.tables.some((table) => table.state !== 'saved');
  const allGood = status.problem === undefined && status.includePresent && status.serviceEnabled !== false && !unsaved;

  return (
    <section className={`card ${styles.panel}`}>
      <h2 className={styles.title}>
        {allGood ? <CheckIcon className={styles.ok} /> : <AlertIcon className={styles.warn} />}
        {t('persist.title')}
      </h2>

      {status.problem !== undefined && (
        <Callout tone="warn" icon={<AlertIcon />} title={t('persist.unavailable')}>
          <pre className="details">{status.problem.detail}</pre>
        </Callout>
      )}

      {status.problem === undefined && status.mainConfig === undefined && (
        <Callout tone="warn" icon={<AlertIcon />} title={t('persist.noConfig')} />
      )}

      {status.problem === undefined && status.mainConfig !== undefined && !status.includePresent && (
        <Callout tone="warn" icon={<AlertIcon />} title={t('persist.noInclude.title')}>
          <p>{t('persist.noInclude', { file })}</p>
          <pre className="details">{status.includeLine}</pre>
          <p>{t('persist.noInclude.safety')}</p>
          {status.source === 'guess' && <p>{t('persist.guess')}</p>}
          <div>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act('include')}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {t('persist.addInclude', { file })}
            </button>
          </div>
        </Callout>
      )}

      {status.serviceEnabled === false && (
        <Callout tone="warn" icon={<AlertIcon />} title={t('persist.serviceOff.title')}>
          <p>{t('persist.serviceOff', { file })}</p>
          <div>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act('service')}>
              {t('persist.enableService')}
            </button>
          </div>
        </Callout>
      )}

      <ul className={styles.tables}>
        {status.tables.map((table) => (
          <li key={table.file} className={styles.table}>
            <span className={`${styles.state} ${table.state === 'saved' ? styles.stateOk : styles.stateWarn}`}>{t(STATES[table.state])}</span>
            <span className="mono">
              {table.family} {table.name}
            </span>
            <span className={styles.file}>{table.file}</span>
            {table.alsoInMainConfig && <span className={styles.note}>{t('persist.alsoInMain', { file })}</span>}
          </li>
        ))}
      </ul>

      {status.problem === undefined && unsaved && (
        <div>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act('save')}>
            {t('persist.saveAll')}
          </button>
        </div>
      )}

      {error !== undefined && <ErrorCallout error={error} />}
    </section>
  );
}
