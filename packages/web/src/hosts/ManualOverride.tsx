import type { HostSummary } from '@hopdeck/core';
import { useRef, useState } from 'react';
import { api } from '../api.ts';
import { ErrorCallout, toErrorInfo, type ErrorInfo } from '../components/ErrorCallout.tsx';
import { AlertIcon, UnlockIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import styles from './ManualOverride.module.css';

interface ManualOverrideProps {
  host: HostSummary;
  onUpdate(host: HostSummary): void;
}

async function setOverride(hostId: string, enabled: boolean): Promise<HostSummary> {
  return (await api.post<{ host: HostSummary }>(`/hosts/${encodeURIComponent(hostId)}/manual-override`, { enabled })).host;
}

/** The header button that switches Manual override on, after a short warning. */
export function ManualOverrideButton({ host, onUpdate }: ManualOverrideProps) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<ErrorInfo>();

  async function enable() {
    try {
      onUpdate(await setOverride(host.id, true));
      dialog.current?.close();
    } catch (caught) {
      setError(toErrorInfo(caught));
    }
  }

  if (host.manualOverride) return null;
  return (
    <>
      <button type="button" className="btn btn-ghost" onClick={() => dialog.current?.showModal()}>
        <UnlockIcon />
        {t('override.label')}
      </button>
      <dialog ref={dialog} className={styles.dialog} aria-labelledby="override-title">
        <div className={styles.body}>
          <span className={styles.icon}>
            <AlertIcon />
          </span>
          <div className={styles.text}>
            <h2 id="override-title" className={styles.title}>
              {t('override.warnTitle')}
            </h2>
            <p>{t('override.warn')}</p>
            <p>{t('override.warnSafety')}</p>
          </div>
        </div>
        {error !== undefined && <ErrorCallout error={error} />}
        <div className={styles.footer}>
          <button type="button" className="btn" onClick={() => dialog.current?.close()}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-danger-solid" onClick={() => void enable()}>
            {t('override.enable')}
          </button>
        </div>
      </dialog>
    </>
  );
}

/** Shown for as long as Manual override is on. */
export function ManualOverrideBanner({ host, onUpdate }: ManualOverrideProps) {
  const { t } = useI18n();
  const [error, setError] = useState<ErrorInfo>();
  if (!host.manualOverride) return null;
  return (
    <div className={styles.banner} role="status">
      <UnlockIcon className={styles.bannerIcon} />
      <div className={styles.bannerText}>
        <strong>{t('override.on')}</strong>
        <span>{t('override.banner')}</span>
        {error !== undefined && <ErrorCallout error={error} />}
      </div>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => void setOverride(host.id, false).then(onUpdate, (caught: unknown) => setError(toErrorInfo(caught)))}
      >
        {t('override.disable')}
      </button>
    </div>
  );
}
