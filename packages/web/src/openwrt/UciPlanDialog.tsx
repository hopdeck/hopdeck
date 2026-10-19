// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { diffLines, hasChanges, type UciChange, type UciPlanView } from '@hopdeck/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import { Callout } from '../components/Callout.tsx';
import { ErrorCallout, toErrorInfo, type ErrorInfo } from '../components/ErrorCallout.tsx';
import { AlertIcon, CheckIcon, InfoIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/locales.ts';
import deploy from '../firewall/deploy/Deploy.module.css';
import { DiffView } from '../firewall/deploy/DiffView.tsx';
import styles from './OpenWrt.module.css';

export interface UciPlanResult {
  /** The last state of the plan, if planning got that far. */
  view: UciPlanView | undefined;
  error: ErrorInfo | undefined;
}

interface UciPlanDialogProps {
  hostId: string;
  hostName: string;
  /** Opens the dialog and plans these changes; undefined keeps it closed. */
  changes: UciChange[] | undefined;
  /** The hash of the configuration the changes were made on. */
  base: string | undefined;
  /** Include files the changes point to, written on the router with them. */
  files?: { path: string; content: string }[] | undefined;
  /** The history version the changes put back. */
  restoredFrom?: number | undefined;
  onClose(result: UciPlanResult): void;
}

/**
 * Review, apply, then keep or roll back the collected changes of the
 * firewall's UCI configuration, as LuCI's "Save & Apply" does, with what
 * rpcd will write listed by section, and what fw4 made of it.
 */
export function UciPlanDialog({ hostId, hostName, changes, base, files = [], restoredFrom, onClose }: UciPlanDialogProps) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<UciPlanView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorInfo>();
  const [now, setNow] = useState(Date.now());

  const open = changes !== undefined;
  const awaiting = view?.state === 'awaiting-confirmation';
  const finished = view !== undefined && ['confirmed', 'rolled-back', 'failed', 'invalid'].includes(view.state);

  async function run(action: () => Promise<{ plan: UciPlanView }>) {
    setBusy(true);
    setError(undefined);
    try {
      setView((await action()).plan);
    } catch (caught) {
      setError(toErrorInfo(caught));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      setView(undefined);
      setError(undefined);
      element.showModal();
      void run(() =>
        api.post(`/hosts/${encodeURIComponent(hostId)}/uci/firewall/plans`, {
          changes,
          ...(base !== undefined && { base }),
          ...(files.length > 0 && { files }),
          ...(restoredFrom !== undefined && { restoredFrom }),
        }),
      );
    } else if (!open && element.open) {
      element.close();
    }
    // Planning runs once per opening, with the changes it was opened with.
  }, [open]);

  // While awaiting confirmation: tick the countdown, and after the deadline ask what rpcd did.
  useEffect(() => {
    if (!awaiting) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [awaiting]);
  const remaining = awaiting ? Math.max(0, Math.ceil((Date.parse(view.deadline!) - now) / 1000)) : 0;
  useEffect(() => {
    if (awaiting && remaining === 0 && !busy) {
      const timer = setTimeout(() => void run(() => api.get(`/uci-plans/${view.id}`)), 4000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [awaiting, remaining, busy]);

  async function close() {
    if (awaiting) return;
    if (view?.state === 'planned') await api.post(`/uci-plans/${view.id}/discard`).catch(() => undefined);
    onClose({ view, error });
  }

  const act = (action: 'apply' | 'confirm' | 'rollback') => run(() => api.post(`/uci-plans/${view!.id}/${action}`));
  const groups = useMemo(() => groupStaged(view?.staged ?? []), [view?.staged]);
  const nft = useMemo(() => (view?.ruleset === undefined ? undefined : diffLines(view.ruleset.before, view.ruleset.after)), [view?.ruleset]);

  return (
    <dialog
      ref={dialog}
      className={deploy.dialog}
      aria-labelledby="uci-plan-title"
      onCancel={(event) => {
        // Esc must not walk away from a change waiting for a decision.
        event.preventDefault();
        void close();
      }}
    >
      <div className={deploy.body}>
        <header className={deploy.header}>
          <h2 id="uci-plan-title" className={deploy.title}>
            {t('uci.plan.title')}
          </h2>
          <span className={deploy.host}>{hostName} · /etc/config/firewall</span>
        </header>
        {restoredFrom !== undefined && <p className={deploy.restoring}>{t('deploy.restoring', { version: restoredFrom })}</p>}

        {view === undefined && busy && (
          <p className={deploy.progress} role="status">
            <span className="spinner" aria-hidden="true" />
            {t('uci.plan.preparing')}
          </p>
        )}

        {view !== undefined && (
          <>
            {groups.length > 0 && (
              <ul className={styles.staged}>
                {groups.map((group) => (
                  <li key={group.section}>
                    <span className={styles.stagedLabel}>{group.label}</span>
                    <ul className={styles.stagedChanges}>
                      {group.changes.map((change, index) => (
                        <li key={index} className="mono">
                          {stagedText(t, change)}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}

            {(view.pendingElsewhere.cli || view.pendingElsewhere.sessions > 0) && (
              <Callout tone="warn" icon={<AlertIcon />} title={t('uci.plan.pendingElsewhere')}>
                {view.pendingElsewhere.cli && <p>{t('uci.plan.pendingCli')}</p>}
                {view.pendingElsewhere.sessions > 0 && <p>{t('uci.plan.pendingSessions', { count: view.pendingElsewhere.sessions })}</p>}
              </Callout>
            )}

            {view.state === 'invalid' && (
              <Callout tone="danger" icon={<AlertIcon />} title={t('uci.plan.invalid')} role="alert">
                <pre className="details">{view.validation.message}</pre>
              </Callout>
            )}

            {view.state === 'planned' && (
              <section className={deploy.safety}>
                <h3 className={deploy.safetyTitle}>{t('deploy.safety.title')}</h3>
                <ul className={deploy.safetyList}>
                  <li>{t('uci.plan.safety.rpcd', { seconds: view.safety.seconds })}</li>
                  <li>{t('uci.plan.safety.reload')}</li>
                  {view.safety.freshConnectionCheck && <li>{t('deploy.safety.fresh')}</li>}
                </ul>
              </section>
            )}

            {/* When fw4 could not load the change, its words are the outcome's below. */}
            {view.warnings !== undefined && view.outcome?.reason !== 'reload-failed' && (
              <Callout tone="info" icon={<InfoIcon />} title={t('uci.plan.warnings')}>
                <pre className="details">{view.warnings}</pre>
              </Callout>
            )}

            {awaiting && (
              <Callout tone="warn" icon={<InfoIcon />} title={t('deploy.awaiting')} role="status">
                <p className={deploy.countdown}>{t('deploy.countdown', { count: remaining })}</p>
              </Callout>
            )}

            {nft !== undefined && (
              <section className={deploy.table}>
                <h3 className={deploy.tableTitle}>
                  <span className="mono">inet fw4</span>
                  <span className={deploy.action}>{t('uci.plan.nft')}</span>
                </h3>
                {hasChanges(nft) ? <DiffView diff={nft} /> : <p className={deploy.method}>{t('uci.plan.nftSame')}</p>}
              </section>
            )}

            {finished && view.state !== 'invalid' && <Outcome view={view} />}
          </>
        )}

        {error?.code === 'ruleset-changed' ? (
          // Not a table, as for nft: the configuration file, whose sections' names may have moved.
          <Callout tone="warn" icon={<AlertIcon />} title={t('uci.stale')} role="alert">
            <p className="details-label">{t('error.original')}</p>
            <pre className="details">{error.message}</pre>
          </Callout>
        ) : (
          error !== undefined && <ErrorCallout error={error} />
        )}
      </div>

      <footer className={deploy.footer}>
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

type Staged = UciPlanView['staged'][number];

/** The changes of each section together, in the order rpcd lists them; moves last, as one line each. */
function groupStaged(staged: readonly Staged[]): { section: string; label: string; changes: Staged[] }[] {
  const groups: { section: string; label: string; changes: Staged[] }[] = [];
  for (const change of staged) {
    let group = groups.find((candidate) => candidate.section === change.section);
    if (group === undefined) {
      group = { section: change.section, label: change.label, changes: [] };
      groups.push(group);
    }
    group.changes.push(change);
  }
  return groups;
}

function stagedText(t: ReturnType<typeof useI18n>['t'], change: Staged): string {
  switch (change.kind) {
    case 'add':
      return t('uci.staged.add', { type: change.option ?? '' });
    case 'set':
      // A named section is made by setting its type: a set without a value.
      return change.value === undefined ? t('uci.staged.add', { type: change.option ?? '' }) : `${change.option ?? ''} = ${change.value}`;
    case 'list-add':
      return `${change.option ?? ''} += ${change.value ?? ''}`;
    case 'list-del':
      return `${change.option ?? ''} −= ${change.value ?? ''}`;
    case 'remove':
      return change.option === undefined ? t('uci.staged.remove') : t('uci.staged.removeOption', { option: change.option });
    case 'order':
      // rpcd's place is in the whole file, which says little; the tab shows where it went.
      return t('uci.staged.order');
    default:
      return [change.kind, change.option, change.value].filter((part) => part !== undefined).join(' ');
  }
}

function Outcome({ view }: { view: UciPlanView }) {
  const { t } = useI18n();
  if (view.state === 'confirmed') {
    const { recorded } = view;
    return (
      <>
        <Callout tone="ok" icon={<CheckIcon />} title={t('uci.plan.confirmed')} />
        {recorded?.version !== undefined && <p className={deploy.recorded}>{t('deploy.recorded', { version: recorded.version })}</p>}
        {recorded?.problem !== undefined && (
          <Callout tone="warn" icon={<AlertIcon />} title={t('deploy.notRecorded')} role="alert">
            <pre className="details">{recorded.problem.detail}</pre>
          </Callout>
        )}
      </>
    );
  }
  const detail = view.outcome?.detail.trim() ?? '';
  const reason = view.outcome?.reason;
  const title: MessageKey =
    view.state === 'failed'
      ? 'deploy.failed'
      : reason === 'reload-failed'
        ? 'uci.plan.rolledBack.reload'
        : reason === 'fresh-connection-failed'
          ? 'deploy.rolledBack.fresh'
          : reason === 'timeout'
            ? 'deploy.rolledBack.timeout'
            : 'deploy.rolledBack.user';
  return (
    <Callout tone={view.state === 'failed' || reason === 'reload-failed' ? 'danger' : 'warn'} icon={<AlertIcon />} title={t(title)} role="alert">
      {detail !== '' && (
        <div>
          <p className="details-label">{t('error.original')}</p>
          <pre className="details">{detail}</pre>
        </div>
      )}
    </Callout>
  );
}
