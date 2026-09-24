import type { HostFacts, HostStatus, HostSummary } from '@nftm/core';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api.ts';
import { Callout } from '../components/Callout.tsx';
import { AlertIcon, CheckIcon, HostKindIcon, LockIcon, RefreshIcon, SandboxIcon, TrashIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import styles from './HostView.module.css';
import { errorHint, errorTitle, hostSubtitle } from './status.ts';

interface HostViewProps {
  host: HostSummary;
  connecting: boolean;
  onConnect(): void;
  onRemove(): void;
  /** Rejects with an ApiError, e.g. code "wrong-password". */
  onUnlock(password: string): Promise<void>;
}

export function HostView({ host, connecting, onConnect, onRemove, onUnlock }: HostViewProps) {
  const { t } = useI18n();
  const { status } = host;
  const subtitle = hostSubtitle(host);

  return (
    <section className={styles.view} aria-labelledby="host-title">
      <header className={styles.header}>
        <div className={styles.identity}>
          <span className={styles.icon}>
            <HostKindIcon kind={host.kind} />
          </span>
          <div className={styles.names}>
            <h1 id="host-title" className={styles.title}>
              {host.name}
            </h1>
            <p className={'text' in subtitle ? `${styles.subtitle} mono` : styles.subtitle}>
              {'text' in subtitle ? subtitle.text : t(subtitle.key)}
            </p>
          </div>
        </div>
        <div className={styles.actions}>
          <button type="button" className="btn" onClick={onConnect} disabled={connecting}>
            {connecting ? <span className="spinner" aria-hidden="true" /> : <RefreshIcon />}
            {t(status.state === 'new' ? 'host.connect' : 'host.reconnect')}
          </button>
          {host.kind === 'ssh' && (
            <button type="button" className="btn btn-ghost btn-danger" onClick={onRemove}>
              <TrashIcon />
              {t('host.remove')}
            </button>
          )}
        </div>
      </header>

      {host.kind === 'sandbox' && (
        <Callout tone="info" icon={<SandboxIcon />} title={t('host.sandboxTitle')}>
          {t('host.sandboxNote')}
        </Callout>
      )}

      {status.state === 'new' && (
        <p className={styles.loading} role="status">
          <span className="spinner" aria-hidden="true" />
          {t('status.connecting')}
        </p>
      )}

      {status.state === 'error' && (
        <Callout tone="danger" icon={<AlertIcon />} title={t(errorTitle(status.error.code))} role="alert">
          {errorHint(status.error.code) !== undefined && (
            <p>{t(errorHint(status.error.code)!, { destination: host.destination ?? host.name })}</p>
          )}
          {status.error.detail !== '' && (
            <details className={styles.details}>
              <summary>{t('error.details')}</summary>
              <pre className="details">{status.error.detail}</pre>
            </details>
          )}
        </Callout>
      )}

      {status.state === 'connected' && (
        <>
          <Access status={status} onUnlock={onUnlock} />
          <Facts facts={status.facts} />
        </>
      )}
    </section>
  );
}

function Access({ status, onUnlock }: { status: Extract<HostStatus, { state: 'connected' }>; onUnlock: HostViewProps['onUnlock'] }) {
  const { t } = useI18n();
  const { privilege } = status;

  if (status.facts.nft === undefined) {
    return <Callout tone="danger" icon={<AlertIcon />} title={t('access.nftMissing')} />;
  }
  if (privilege.kind === 'root') return <Callout tone="ok" icon={<CheckIcon />} title={t('access.root')} />;
  if (privilege.kind === 'sudo') return <Callout tone="ok" icon={<CheckIcon />} title={t('access.sudo')} />;
  if (privilege.kind === 'sudo-password') {
    return status.passwordStored ? (
      <Callout tone="ok" icon={<CheckIcon />} title={t('access.sudoPasswordStored')} />
    ) : (
      <PasswordPrompt onUnlock={onUnlock} />
    );
  }
  return (
    <Callout tone="warn" icon={<AlertIcon />} title={t('access.noneTitle')}>
      <p>{t('access.noneHint')}</p>
      {privilege.detail !== '' && <pre className="details">{privilege.detail}</pre>}
    </Callout>
  );
}

function PasswordPrompt({ onUnlock }: { onUnlock: HostViewProps['onUnlock'] }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError(null);
    try {
      await onUnlock(String(new FormData(form).get('password') ?? ''));
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
      form.reset();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Callout tone="warn" icon={<LockIcon />} title={t('access.passwordTitle')}>
      <p>{t('access.passwordHint')}</p>
      <form className={styles.passwordForm} onSubmit={submit}>
        <label className="visually-hidden" htmlFor="sudo-password">
          {t('access.passwordLabel')}
        </label>
        <input
          id="sudo-password"
          name="password"
          type="password"
          className="input"
          placeholder={t('access.passwordLabel')}
          autoComplete="off"
          required
        />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {t('access.unlock')}
        </button>
      </form>
      {error !== null && (
        <p className={styles.error} role="alert">
          {t(errorTitle(error instanceof ApiError ? error.code : 'unknown'))}
        </p>
      )}
    </Callout>
  );
}

function Facts({ facts }: { facts: HostFacts }) {
  const { t } = useI18n();
  return (
    <div className="card">
      <h2 className={styles.cardTitle}>{t('facts.title')}</h2>
      <dl className={styles.facts}>
        <dt>{t('facts.os')}</dt>
        <dd>{facts.os?.name || t('facts.unknown')}</dd>
        <dt>{t('facts.kernel')}</dt>
        <dd className="mono">{facts.kernel}</dd>
        <dt>{t('facts.nft')}</dt>
        <dd>{facts.nft ? <span className="mono">{facts.nft.version}</span> : t('facts.notInstalled')}</dd>
        {facts.nft && (
          <>
            <dt>{t('facts.nftPath')}</dt>
            <dd className="mono">{facts.nft.path}</dd>
          </>
        )}
        <dt>{t('facts.systemd')}</dt>
        <dd>{t(facts.systemd ? 'facts.yes' : 'facts.no')}</dd>
        <dt>{t('facts.hostname')}</dt>
        <dd className="mono">{facts.hostname}</dd>
        <dt>{t('facts.user')}</dt>
        <dd>{facts.uid === 0 ? <span className="mono">root</span> : t('facts.uid', { uid: facts.uid })}</dd>
      </dl>
    </div>
  );
}
