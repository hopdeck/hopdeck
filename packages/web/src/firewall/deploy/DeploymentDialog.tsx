import type { DeploymentView, TableChange } from '@hopdeck/core';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.ts';
import { Callout } from '../../components/Callout.tsx';
import { ErrorCallout, toErrorInfo, type ErrorInfo } from '../../components/ErrorCallout.tsx';
import { AlertIcon, CheckIcon, InfoIcon } from '../../components/icons.tsx';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import type { MessageKey } from '../../i18n/locales.ts';
import styles from './Deploy.module.css';
import { DiffView } from './DiffView.tsx';
import { NftCode } from '../ruleset/NftCode.tsx';

export interface DeploymentResult {
  /** Whether the ruleset may differ now. */
  changed: boolean;
  /** The last state of the deployment, if planning got that far. */
  view: DeploymentView | undefined;
  /** What went wrong on the way, if anything. */
  error: ErrorInfo | undefined;
}

interface DeploymentDialogProps {
  hostId: string;
  hostName: string;
  /** Opens the dialog and plans these changes; undefined keeps it closed. */
  changes: TableChange[] | undefined;
  /** The history version the changes put back, for the record. */
  restoredFrom?: number | undefined;
  onClose(result: DeploymentResult): void;
}

export const ACTIONS: Record<DeploymentView['tables'][number]['action'], MessageKey> = {
  adopt: 'deploy.action.adopt',
  create: 'deploy.action.create',
  replace: 'deploy.action.replace',
  delete: 'deploy.action.delete',
  elements: 'deploy.action.elements',
};

/** Plan, review, apply, then keep or roll back one change. */
export function DeploymentDialog({ hostId, hostName, changes, restoredFrom, onClose }: DeploymentDialogProps) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<DeploymentView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorInfo>();
  const [now, setNow] = useState(Date.now());

  const open = changes !== undefined;
  const awaiting = view?.state === 'awaiting-confirmation';
  const finished = view !== undefined && ['confirmed', 'rolled-back', 'failed', 'invalid'].includes(view.state);

  async function run(action: () => Promise<{ deployment: DeploymentView }>) {
    setBusy(true);
    setError(undefined);
    try {
      setView((await action()).deployment);
    } catch (caught) {
      setError(toErrorInfo(caught));
    } finally {
      setBusy(false);
    }
  }

  // Open: plan the changes on the host.
  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      setView(undefined);
      setError(undefined);
      element.showModal();
      void run(() => api.post(`/hosts/${encodeURIComponent(hostId)}/deployments`, { changes, ...(restoredFrom !== undefined && { restoredFrom }) }));
    } else if (!open && element.open) {
      element.close();
    }
    // Planning runs once per opening, with the changes it was opened with.
  }, [open]);

  // While awaiting confirmation: tick the countdown, and after the deadline ask what the host did.
  useEffect(() => {
    if (!awaiting) return;
    // Start from the current time, not the one remembered when the dialog first rendered.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [awaiting]);
  const remaining = awaiting ? Math.max(0, Math.ceil((Date.parse(view.deadline!) - now) / 1000)) : 0;
  useEffect(() => {
    if (awaiting && remaining === 0 && !busy) {
      const timer = setTimeout(() => void run(() => api.get(`/deployments/${view.id}`)), 2000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [awaiting, remaining, busy]);

  async function close() {
    if (awaiting) return;
    if (view?.state === 'planned') await api.post(`/deployments/${view.id}/discard`).catch(() => undefined);
    onClose({ changed: finished && view?.state !== 'invalid', view, error });
  }

  const act = (action: 'apply' | 'confirm' | 'rollback') => run(() => api.post(`/deployments/${view!.id}/${action}`));

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="deploy-title"
      onCancel={(event) => {
        // Esc must not walk away from a change waiting for a decision.
        event.preventDefault();
        void close();
      }}
    >
      <div className={styles.body}>
        <header className={styles.header}>
          <h2 id="deploy-title" className={styles.title}>
            {t('deploy.title')}
          </h2>
          <span className={styles.host}>{hostName}</span>
        </header>
        {restoredFrom !== undefined && <p className={styles.restoring}>{t('deploy.restoring', { version: restoredFrom })}</p>}

        {view === undefined && busy && (
          <p className={styles.progress} role="status">
            <span className="spinner" aria-hidden="true" />
            {t('deploy.preparing')}
          </p>
        )}

        {view !== undefined && (
          <>
            {view.tables.map((table) => (
              <section key={`${table.family} ${table.name}`} className={styles.table}>
                <h3 className={styles.tableTitle}>
                  <span className={styles.action}>{t(ACTIONS[table.action])}</span>
                  <span className="mono">
                    {table.family} {table.name}
                    {table.set !== undefined && ` · ${table.set.kind} ${table.set.name}`}
                  </span>
                </h3>
                <DiffView diff={table.diff} />
                {table.action === 'elements' && (
                  <details className={styles.commands}>
                    <summary>{t('deploy.commands')}</summary>
                    <NftCode text={table.script.trimEnd()} block />
                    <p className={styles.commandsNote}>{t('deploy.commandsRollback')}</p>
                    <NftCode text={table.rollback.trimEnd()} block />
                  </details>
                )}
              </section>
            ))}

            {view.state === 'planned' && <p className={styles.valid}>{t('deploy.valid')}</p>}
            {view.state === 'invalid' && (
              <Callout tone="danger" icon={<AlertIcon />} title={t('deploy.invalid')} role="alert">
                <pre className="details">{view.validation.message}</pre>
              </Callout>
            )}

            {view.state === 'planned' && <Safety view={view} />}

            {awaiting && (
              <Callout tone="warn" icon={<InfoIcon />} title={t('deploy.awaiting')} role="status">
                <p className={styles.countdown}>{t('deploy.countdown', { count: remaining })}</p>
                {view.outcome?.reason === 'fresh-connection-failed' && (
                  <>
                    <p>{t('deploy.freshFailedPending')}</p>
                    <pre className="details">{view.outcome.detail}</pre>
                  </>
                )}
              </Callout>
            )}

            {finished && view.state !== 'invalid' && <Outcome view={view} />}
          </>
        )}

        {error !== undefined && <ErrorCallout error={error} />}
      </div>

      <footer className={styles.footer}>
        {view?.state === 'planned' && (
          <>
            <button type="button" className="btn" onClick={() => void close()} disabled={busy}>
              {t('deploy.cancel')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void act('apply')} disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {t('deploy.apply')}
            </button>
          </>
        )}
        {awaiting && (
          <>
            <button type="button" className="btn btn-danger-solid" onClick={() => void act('rollback')} disabled={busy}>
              {t('deploy.rollback')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void act('confirm')} disabled={busy || remaining === 0}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {t('deploy.confirm')}
            </button>
          </>
        )}
        {(finished || (view === undefined && !busy)) && (
          <button type="button" className="btn" onClick={() => void close()}>
            {t('common.close')}
          </button>
        )}
      </footer>
    </dialog>
  );
}

function Safety({ view }: { view: DeploymentView }) {
  const { t } = useI18n();
  const { safety } = view;
  const watchdog: MessageKey =
    safety.watchdog === 'systemd' ? 'deploy.safety.systemd' : safety.watchdog === 'detached' ? 'deploy.safety.detached' : 'deploy.safety.unavailable';
  return (
    <section className={styles.safety}>
      <h3 className={styles.safetyTitle}>{t('deploy.safety.title')}</h3>
      <ul className={styles.safetyList}>
        <li className={safety.watchdog === 'unavailable' ? styles.bad : undefined}>{t(watchdog, { seconds: safety.seconds })}</li>
        {safety.freshConnectionCheck && <li>{t('deploy.safety.fresh')}</li>}
        <li>{t('deploy.safety.atomic')}</li>
        {view.manualOverride && <li className={styles.bad}>{t('deploy.overrideNote')}</li>}
        <li className={styles.directory}>{t('deploy.safety.directory', { directory: safety.directory })}</li>
      </ul>
    </section>
  );
}

/** What a kept change left for the next boot. */
function Persisted({ result }: { result: NonNullable<DeploymentView['persisted']> }) {
  const { t } = useI18n();
  const saved = result.written.length > 0 || result.removed.length > 0;
  return (
    <>
      {saved && (
        <Callout tone="ok" icon={<CheckIcon />} title={t('deploy.persisted.title')}>
          <ul className={styles.files}>
            {result.written.map((file) => (
              <li key={file}>{t('deploy.persisted.written', { file })}</li>
            ))}
            {result.removed.map((file) => (
              <li key={file}>{t('deploy.persisted.removed', { file })}</li>
            ))}
          </ul>
        </Callout>
      )}
      {result.notManaged.length > 0 && (
        <Callout tone="warn" icon={<AlertIcon />} title={t('deploy.persisted.notManaged', { tables: result.notManaged.join(', ') })} />
      )}
      {result.problem !== undefined && (
        <Callout tone="warn" icon={<AlertIcon />} title={t('deploy.persisted.problem')} role="alert">
          <pre className="details">{result.problem.detail}</pre>
        </Callout>
      )}
    </>
  );
}

/** Where the kept change went in the host's history. */
function Recorded({ recorded }: { recorded: NonNullable<DeploymentView['recorded']> }) {
  const { t } = useI18n();
  if (recorded.version !== undefined) return <p className={styles.recorded}>{t('deploy.recorded', { version: recorded.version })}</p>;
  if (recorded.problem === undefined) return null;
  return (
    <Callout tone="warn" icon={<AlertIcon />} title={t('deploy.notRecorded')} role="alert">
      <pre className="details">{recorded.problem.detail}</pre>
    </Callout>
  );
}

function Outcome({ view }: { view: DeploymentView }) {
  const { t } = useI18n();
  if (view.state === 'confirmed') {
    return (
      <>
        <Callout tone="ok" icon={<CheckIcon />} title={t('deploy.confirmed')} />
        {view.persisted !== undefined && <Persisted result={view.persisted} />}
        {view.recorded !== undefined && <Recorded recorded={view.recorded} />}
      </>
    );
  }
  const detail = view.outcome?.detail.trim() ?? '';
  const title: MessageKey =
    view.state === 'failed'
      ? 'deploy.failed'
      : view.outcome?.reason === 'fresh-connection-failed'
        ? 'deploy.rolledBack.fresh'
        : view.outcome?.reason === 'timeout'
          ? 'deploy.rolledBack.timeout'
          : 'deploy.rolledBack.user';
  return (
    <Callout tone={view.state === 'failed' ? 'danger' : 'warn'} icon={<AlertIcon />} title={t(title)} role="alert">
      {detail !== '' && (
        <div>
          <p className="details-label">{t('error.original')}</p>
          <pre className="details">{detail}</pre>
        </div>
      )}
    </Callout>
  );
}
