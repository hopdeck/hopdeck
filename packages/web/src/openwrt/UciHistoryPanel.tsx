// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { diffLines, hasChanges, uciRestoreChanges, type UciChange, type UciHistoryDetail, type UciHistoryState, type UciHistoryVersion } from '@hopdeck/core';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { ErrorCallout, toErrorInfo, type ErrorInfo } from '../components/ErrorCallout.tsx';
import { RefreshIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/locales.ts';
import { DiffView } from '../firewall/deploy/DiffView.tsx';
import styles from '../firewall/history/History.module.css';
import { formatBytes } from '../firewall/ruleset/model.ts';
import type { UciFirewallState } from './useUciFirewall.ts';

interface UciHistoryPanelProps {
  hostId: string;
  state: UciFirewallState;
  /** Opens the review of the changes that put a version back, with the include files it had. */
  onRestore(changes: UciChange[], files: { path: string; content: string }[], version: number): void;
}

const KINDS: Record<UciHistoryVersion['kind'], MessageKey> = {
  baseline: 'history.kind.baseline',
  change: 'history.kind.change',
  outside: 'history.kind.outside',
};

/**
 * The history of the router's firewall configuration, kept on the router:
 * every version, what changed in /etc/config/firewall and in hopdeck's
 * nftables files, who did it, and a way back.
 */
export function UciHistoryPanel({ hostId, state, onRestore }: UciHistoryPanelProps) {
  const { t, locale } = useI18n();
  const [history, setHistory] = useState<UciHistoryState>();
  const [error, setError] = useState<ErrorInfo>();
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<number>();
  // Versions never change once written, so what was read stays good.
  const [details, setDetails] = useState<ReadonlyMap<number, UciHistoryDetail>>(new Map());
  const [detailError, setDetailError] = useState<ErrorInfo>();
  const path = `/hosts/${encodeURIComponent(hostId)}/uci/firewall/history`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const read = await api.get<{ history: UciHistoryState }>(path);
      setHistory(read.history);
      setError(undefined);
      setSelected((current) => (read.history.versions.some((version) => version.id === current) ? current : read.history.versions[0]?.id));
    } catch (caught) {
      setError(toErrorInfo(caught));
    } finally {
      setLoading(false);
    }
  }, [path]);

  // Read again whenever the configuration is: a kept change or one noticed from elsewhere is a new version.
  useEffect(() => {
    void load();
  }, [load, state.hash]);

  const versions = history?.versions ?? [];
  const index = versions.findIndex((version) => version.id === selected);
  const version = index === -1 ? undefined : versions[index];
  const previous = index === -1 ? undefined : versions[index + 1];
  const missing = [version?.id, previous?.id].filter((id): id is number => id !== undefined && !details.has(id));
  const missingKey = missing.join(',');

  useEffect(() => {
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(missing.map((id) => api.get<{ version: UciHistoryDetail }>(`${path}/${id}`))).then(
      (loaded) => {
        if (cancelled) return;
        setDetails((map) => new Map([...map, ...loaded.map(({ version: detail }) => [detail.version.id, detail] as const)]));
        setDetailError(undefined);
      },
      (caught: unknown) => {
        if (!cancelled) setDetailError(toErrorInfo(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [missingKey, path]);

  if (error !== undefined && history === undefined) return <ErrorCallout error={error} />;
  if (history === undefined) {
    return (
      <p className={styles.loading} role="status">
        <span className="spinner" aria-hidden="true" />
        {t('history.loading')}
      </p>
    );
  }

  const detail = version === undefined ? undefined : details.get(version.id);
  const earlier = previous === undefined ? undefined : details.get(previous.id);
  const restore = detail !== undefined && state.base !== undefined ? uciRestoreChanges(state.base, detail.config) : undefined;
  const full = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' });
  const short = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });

  return (
    <div className={styles.panel}>
      <div className={styles.bar}>
        <span>{t('uci.history.summary', { count: versions.length, size: formatBytes(history.size, locale) })}</span>
        <span className={styles.directory}>{history.directory}</span>
        <button type="button" className={`btn btn-sm ${styles.refresh}`} onClick={() => void load()} disabled={loading}>
          {loading ? <span className="spinner" aria-hidden="true" /> : <RefreshIcon />}
          {t('ruleset.refresh')}
        </button>
      </div>
      {error !== undefined && <ErrorCallout error={error} />}
      {versions.length === 0 && <p className={styles.empty}>{t('uci.history.empty')}</p>}

      {versions.length > 0 && (
        <div className={styles.layout}>
          <ol className={styles.list} aria-label={t('history.versions')}>
            {versions.map((entry) => (
              <li key={entry.id}>
                <button type="button" className={styles.item} aria-current={entry.id === selected} onClick={() => setSelected(entry.id)}>
                  <span className={styles.itemHead}>
                    <span className={styles.id}>#{entry.id}</span>
                    <Kind version={entry} />
                    <time className={styles.time} dateTime={entry.time}>
                      {short.format(new Date(entry.time))}
                    </time>
                  </span>
                  <span className={styles.what}>{summary(entry, t)}</span>
                  <span className={styles.who}>
                    {entry.author.user}@{entry.author.computer}
                  </span>
                </button>
              </li>
            ))}
          </ol>

          {version !== undefined && (
            <section className={styles.detail} aria-labelledby="uci-history-version">
              <header className={styles.detailHead}>
                <h3 id="uci-history-version" className={styles.detailTitle}>
                  <span className={styles.id}>#{version.id}</span>
                  <Kind version={version} />
                  <time dateTime={version.time}>{full.format(new Date(version.time))}</time>
                </h3>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={restore === undefined || restore.length === 0}
                  title={restore?.length === 0 ? t('history.restoreNothing') : undefined}
                  onClick={() => {
                    if (restore === undefined || detail === undefined) return;
                    if (state.pending.length > 0) {
                      window.alert(t('uci.history.pendingFirst', { count: state.pending.length }));
                      return;
                    }
                    onRestore(restore, detail.includes, version.id);
                  }}
                >
                  {t('history.restore')}
                </button>
              </header>

              <Author version={version} onSelect={setSelected} />

              {detailError !== undefined && <ErrorCallout error={detailError} />}
              {detail === undefined || (previous !== undefined && earlier === undefined) ? (
                detailError === undefined && (
                  <p className={styles.loading} role="status">
                    <span className="spinner" aria-hidden="true" />
                    {t('history.loading')}
                  </p>
                )
              ) : (
                <Files before={earlier} after={detail} />
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function Kind({ version }: { version: UciHistoryVersion }) {
  const { t } = useI18n();
  const restore = version.restoredFrom !== undefined;
  return <span className={`${styles.kind} ${styles[`kind-${restore ? 'restore' : version.kind}`]}`}>{t(restore ? 'history.kind.restore' : KINDS[version.kind])}</span>;
}

function summary(version: UciHistoryVersion, t: ReturnType<typeof useI18n>['t']): string {
  if (version.kind === 'outside') return t('uci.history.outsideSummary');
  if (version.kind === 'baseline') return t('uci.history.baselineSummary');
  const sections = [...new Set(version.changes.map((change) => change.label))];
  return sections.join(', ');
}

const NOTES: Record<UciHistoryVersion['kind'], MessageKey> = {
  baseline: 'uci.history.baselineNote',
  change: 'history.authorNote',
  outside: 'uci.history.noticedNote',
};

/** Who made the version, or noticed it: what hopdeck reported, then what the router saw. */
function Author({ version, onSelect }: { version: UciHistoryVersion; onSelect(id: number): void }) {
  const { t } = useI18n();
  const { author } = version;
  const { connection } = author;
  return (
    <>
      <dl className={styles.facts}>
        <dt>{t(version.kind === 'change' ? 'history.by' : 'history.noticedBy')}</dt>
        <dd className="mono">
          {author.user}@{author.computer}
        </dd>
        <dt>{t('history.login')}</dt>
        <dd className="mono">{author.login}</dd>
        <dt>{t('history.connection')}</dt>
        <dd className="mono">{connection === undefined ? t('history.noConnection') : t('history.address', { address: connection.address, port: connection.port })}</dd>
        {connection !== undefined && (
          <>
            <dt>{t('history.authentication')}</dt>
            <dd className="mono">{connection.method === undefined ? t('history.notLogged') : `${connection.method}${connection.key === undefined ? '' : ` ${connection.key}`}`}</dd>
          </>
        )}
        {version.kind === 'change' && version.changes.length > 0 && (
          <>
            <dt>{t('history.what')}</dt>
            <dd>{summary(version, t)}</dd>
          </>
        )}
        {version.restoredFrom !== undefined && (
          <>
            <dt>{t('history.restores')}</dt>
            <dd>
              <button type="button" className={styles.link} onClick={() => onSelect(version.restoredFrom!)}>
                #{version.restoredFrom}
              </button>
            </dd>
          </>
        )}
      </dl>
      <p className={styles.note}>{t(NOTES[version.kind])}</p>
    </>
  );
}

/** /etc/config/firewall and hopdeck's nftables files, from the version before to this one. */
function Files({ before, after }: { before: UciHistoryDetail | undefined; after: UciHistoryDetail }) {
  const { t } = useI18n();
  const files = [
    { name: '/etc/config/firewall', old: before?.text, next: after.text },
    ...[...new Set([...(before?.includes ?? []), ...after.includes].map((include) => include.path))].map((path) => ({
      name: path,
      old: before?.includes.find((include) => include.path === path)?.content,
      next: after.includes.find((include) => include.path === path)?.content,
    })),
  ];
  return (
    <div className={styles.tables}>
      {before === undefined && <p className={styles.note}>{t('history.noEarlier')}</p>}
      {files.map((file) => {
        const diff = diffLines(file.old ?? '', file.next ?? '');
        const status = before === undefined ? 'same' : file.old === undefined ? 'added' : file.next === undefined ? 'removed' : hasChanges(diff) ? 'changed' : 'same';
        return (
          <section key={file.name} className={styles.table}>
            <h4 className={styles.tableTitle}>
              <span className="mono">{file.name}</span>
              {before !== undefined && <span className={`${styles.status} ${styles[`status-${status}`]}`}>{t(`history.table.${status}` as MessageKey)}</span>}
            </h4>
            {(before === undefined || status !== 'same') && <DiffView diff={diff} />}
          </section>
        );
      })}
    </div>
  );
}
