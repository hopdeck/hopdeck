import type { HostKeyCheck, HostSummary } from '@hopdeck/core';
import { Fragment, useState } from 'react';
import { api } from '../api.ts';
import { ErrorCallout, toErrorInfo, type ErrorInfo } from '../components/ErrorCallout.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import styles from './HostKeyPanel.module.css';

interface HostKeyPanelProps {
  hostId: string;
  /** known_hosts has another key for the host: replacing it needs explicit confirmation. */
  changed: boolean;
  onTrusted(host: HostSummary): void;
}

/** The file on the server that holds a key of this type, for comparing fingerprints there. */
function serverKeyFile(type: string): string {
  if (type === 'ssh-ed25519') return '/etc/ssh/ssh_host_ed25519_key.pub';
  if (type.startsWith('ecdsa-')) return '/etc/ssh/ssh_host_ecdsa_key.pub';
  if (type === 'ssh-rsa' || type.startsWith('rsa-')) return '/etc/ssh/ssh_host_rsa_key.pub';
  return '/etc/ssh/ssh_host_*_key.pub';
}

/**
 * Shows the key an SSH host presents so the user can compare its fingerprint
 * with the server's own, and records it only after that. Nothing is saved
 * until the user confirms.
 */
export function HostKeyPanel({ hostId, changed, onTrusted }: HostKeyPanelProps) {
  const { t } = useI18n();
  const [check, setCheck] = useState<HostKeyCheck>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorInfo>();
  const [confirmed, setConfirmed] = useState(false);
  const path = `/hosts/${encodeURIComponent(hostId)}/host-key`;

  async function read() {
    setBusy(true);
    setError(undefined);
    try {
      setCheck((await api.get<{ hostKey: HostKeyCheck }>(path)).hostKey);
      setConfirmed(false);
    } catch (caught) {
      setError(toErrorInfo(caught));
    } finally {
      setBusy(false);
    }
  }

  async function trust(fingerprint: string, replace: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      onTrusted((await api.post<{ host: HostSummary }>(path, { fingerprint, replace })).host);
    } catch (caught) {
      setError(toErrorInfo(caught));
    } finally {
      setBusy(false);
    }
  }

  const others = check?.known.filter((key) => key.fingerprint !== check.presented.fingerprint) ?? [];
  const replacing = others.length > 0;

  return (
    <section className={`card ${styles.panel}`}>
      <h2 className={styles.title}>{t(changed ? 'hostKey.titleChanged' : 'hostKey.title')}</h2>

      {check === undefined ? (
        <>
          <p className={styles.text}>{t('hostKey.intro')}</p>
          <div>
            <button type="button" className="btn" onClick={() => void read()} disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {t('hostKey.read')}
            </button>
          </div>
        </>
      ) : (
        <>
          <dl className={styles.keys}>
            <dt>{t('hostKey.presented')}</dt>
            <dd>
              <span className={styles.type}>{check.presented.type}</span>
              <span className={styles.fingerprint}>{check.presented.fingerprint}</span>
            </dd>
            {others.map((key) => (
              <Fragment key={`${key.file} ${key.fingerprint}`}>
                <dt>{t('hostKey.known')}</dt>
                <dd>
                  <span className={styles.type}>{key.type}</span>
                  <span className={`${styles.fingerprint} ${styles.old}`}>{key.fingerprint}</span>
                  <span className={styles.file}>{key.file}</span>
                </dd>
              </Fragment>
            ))}
            <dt>{t('hostKey.file')}</dt>
            <dd className="mono">{check.knownHostsFile}</dd>
          </dl>

          <p className={styles.text}>{t('hostKey.verify')}</p>
          <pre className="details">ssh-keygen -lf {serverKeyFile(check.presented.type)}</pre>

          {replacing && (
            <>
              <p className={styles.text}>{t('hostKey.backup', { file: [...new Set(others.map((key) => key.file))].join(', ') })}</p>
              <label className={styles.confirm}>
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                {t('hostKey.confirmReplace')}
              </label>
            </>
          )}

          <div className={styles.actions}>
            <button
              type="button"
              className={replacing ? 'btn btn-danger-solid' : 'btn btn-primary'}
              disabled={busy || (replacing && !confirmed)}
              onClick={() => void trust(check.presented.fingerprint, replacing)}
            >
              {busy && <span className="spinner" aria-hidden="true" />}
              {t(replacing ? 'hostKey.replace' : 'hostKey.trust')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void read()} disabled={busy}>
              {t('hostKey.readAgain')}
            </button>
          </div>
        </>
      )}

      {error !== undefined && <ErrorCallout error={error} />}
    </section>
  );
}
