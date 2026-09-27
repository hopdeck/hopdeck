import {
  diffLines,
  hasChanges,
  isManaged,
  normalizedTable,
  restoreChanges,
  stripHandles,
  tableText,
  type DiffLine,
  type Family,
  type HistoryState,
  type HistoryVersion,
  type HistoryVersionDetail,
  type TableChange,
} from '@hopdeck/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api.ts';
import { Callout } from '../../components/Callout.tsx';
import { ErrorCallout, toErrorInfo, type ErrorInfo } from '../../components/ErrorCallout.tsx';
import { AlertIcon, InfoIcon, RefreshIcon } from '../../components/icons.tsx';
import { Segmented } from '../../components/Segmented.tsx';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import type { MessageKey } from '../../i18n/locales.ts';
import { ACTIONS } from '../deploy/DeploymentDialog.tsx';
import { DiffView } from '../deploy/DiffView.tsx';
import { formatBytes, type RulesetModel } from '../ruleset/model.ts';
import styles from './History.module.css';

/** changes: what the version changed, from the one before; restore: what putting it back would change now. */
type Compare = 'changes' | 'restore';

interface HistoryPanelProps {
  hostId: string;
  /** The ruleset as last read: what "now" means, and a new one reloads the history. */
  model: RulesetModel | undefined;
  /** Whether hopdeck may change this host's firewall, so a version can be put back. */
  canRestore: boolean;
  onRestore(changes: TableChange[], version: number): void;
}

type TableText = { family: Family; name: string; text: string };

const KINDS: Record<HistoryVersion['kind'], MessageKey> = {
  baseline: 'history.kind.baseline',
  change: 'history.kind.change',
  outside: 'history.kind.outside',
};

/** The history of the managed tables kept on the host: every version, what changed, who did it, and a way back. */
export function HistoryPanel({ hostId, model, canRestore, onRestore }: HistoryPanelProps) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<HistoryState>();
  const [error, setError] = useState<ErrorInfo>();
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<number>();
  // Versions never change once written, so what was read stays good.
  const [details, setDetails] = useState<ReadonlyMap<number, HistoryVersionDetail>>(new Map());
  const [detailError, setDetailError] = useState<ErrorInfo>();
  const [compare, setCompare] = useState<Compare>('changes');
  const path = `/hosts/${encodeURIComponent(hostId)}/history`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { history } = await api.get<{ history: HistoryState }>(path);
      setState(history);
      setError(undefined);
      setSelected((current) => (history.versions.some((version) => version.id === current) ? current : history.versions[0]?.id));
    } catch (caught) {
      setError(toErrorInfo(caught));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load, model?.readAt]);

  const versions = state?.versions ?? [];
  const index = versions.findIndex((version) => version.id === selected);
  const version = index === -1 ? undefined : versions[index];
  const previous = index === -1 ? undefined : versions[index + 1];
  const missing = [version?.id, compare === 'changes' ? previous?.id : undefined].filter(
    (id): id is number => id !== undefined && !details.has(id),
  );
  const missingKey = missing.join(',');

  useEffect(() => {
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(missing.map((id) => api.get<{ version: HistoryVersionDetail }>(`${path}/${id}`))).then(
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

  // The managed tables now, as a version would keep them.
  const now = useMemo(() => {
    if (model === undefined) return undefined;
    const listing = stripHandles(model.text);
    const managed = model.ruleset.tables.filter((node) => isManaged(node.table)).map((node) => ({ family: node.table.family, name: node.table.name }));
    const tables = managed.flatMap(({ family, name }) => {
      const text = tableText(listing, family, name);
      return text === undefined ? [] : [{ family, name, text: normalizedTable(text) }];
    });
    return { listing, managed, tables };
  }, [model]);

  const detail = version === undefined ? undefined : details.get(version.id);
  const earlier = previous === undefined ? undefined : details.get(previous.id);
  const restoreAll = detail !== undefined && now !== undefined ? restoreChanges(detail, now.listing, now.managed) : undefined;

  if (error !== undefined && state === undefined) return <ErrorCallout error={error} />;
  if (state === undefined) {
    return (
      <p className={styles.loading} role="status">
        <span className="spinner" aria-hidden="true" />
        {t('history.loading')}
      </p>
    );
  }

  const full = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' });
  const short = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });

  return (
    <div className={styles.panel}>
      <div className={styles.bar}>
        <span>
          {t('history.summary', {
            count: versions.length,
            size: formatBytes(state.size, locale),
            limit: formatBytes(state.settings.history.maxBytes, locale),
          })}
        </span>
        <span className={styles.directory}>{state.directory}</span>
        <button type="button" className={`btn btn-sm ${styles.refresh}`} onClick={() => void load()} disabled={loading}>
          {loading ? <span className="spinner" aria-hidden="true" /> : <RefreshIcon />}
          {t('ruleset.refresh')}
        </button>
      </div>

      {error !== undefined && <ErrorCallout error={error} />}
      {state.problem !== undefined && (
        <Callout tone="info" icon={<InfoIcon />} title={t('history.unavailable')}>
          <pre className="details">{state.problem.detail}</pre>
        </Callout>
      )}
      {state.failure !== undefined && (
        <Callout tone="warn" icon={<AlertIcon />} title={t('history.failure', { time: full.format(new Date(state.failure.time)) })} role="alert">
          <pre className="details">{state.failure.detail}</pre>
        </Callout>
      )}
      {state.unreadable !== undefined && (
        <p className={styles.note}>{t('history.unreadable', { versions: state.unreadable.map((id) => `#${id}`).join(', ') })}</p>
      )}

      {versions.length === 0 && state.problem === undefined && <p className={styles.empty}>{t('history.empty')}</p>}

      {versions.length > 0 && (
        <div className={styles.layout}>
          <ol className={styles.list} aria-label={t('history.versions')}>
            {versions.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className={styles.item}
                  aria-current={entry.id === selected}
                  onClick={() => setSelected(entry.id)}
                >
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
            <section className={styles.detail} aria-labelledby="history-version">
              <header className={styles.detailHead}>
                <h3 id="history-version" className={styles.detailTitle}>
                  <span className={styles.id}>#{version.id}</span>
                  <Kind version={version} />
                  <time dateTime={version.time}>{full.format(new Date(version.time))}</time>
                </h3>
                {canRestore && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={restoreAll === undefined || restoreAll.length === 0}
                    title={restoreAll?.length === 0 ? t('history.restoreNothing') : undefined}
                    onClick={() => restoreAll !== undefined && onRestore(restoreAll, version.id)}
                  >
                    {t('history.restore')}
                  </button>
                )}
              </header>

              <Author version={version} onSelect={setSelected} />

              <div className={styles.compare}>
                <Segmented<Compare>
                  label={t('history.compare')}
                  value={compare}
                  onChange={setCompare}
                  options={[
                    { value: 'changes', label: t('history.compare.changes') },
                    { value: 'restore', label: t('history.compare.restore') },
                  ]}
                />
              </div>

              {detailError !== undefined && <ErrorCallout error={detailError} />}
              {detail === undefined || now === undefined || (compare === 'changes' && previous !== undefined && earlier === undefined) ? (
                detailError === undefined && (
                  <p className={styles.loading} role="status">
                    <span className="spinner" aria-hidden="true" />
                    {t('history.loading')}
                  </p>
                )
              ) : (
                <Tables
                  before={compare === 'changes' ? (earlier?.tables ?? []) : now.tables}
                  after={detail.tables}
                  note={compare === 'changes' && previous === undefined ? t('history.noEarlier') : undefined}
                  restore={
                    canRestore && compare === 'restore'
                      ? (family, name) => {
                          const changes = restoreChanges(detail, now.listing, now.managed, { family, name });
                          if (changes.length > 0) onRestore(changes, version.id);
                        }
                      : undefined
                  }
                />
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function Kind({ version }: { version: HistoryVersion }) {
  const { t } = useI18n();
  const restore = version.restoredFrom !== undefined;
  return (
    <span className={`${styles.kind} ${styles[`kind-${restore ? 'restore' : version.kind}`]}`}>
      {t(restore ? 'history.kind.restore' : KINDS[version.kind])}
    </span>
  );
}

function summary(version: HistoryVersion, t: ReturnType<typeof useI18n>['t']): string {
  if (version.kind === 'outside') return t('history.outsideSummary');
  if (version.kind === 'baseline') return t('history.baselineSummary', { count: version.tables.length });
  return version.changes.map((change) => `${t(ACTIONS[change.action])} ${change.family} ${change.name}${change.set ? ` · ${change.set}` : ''}`).join(', ');
}

const NOTES: Record<HistoryVersion['kind'], MessageKey> = {
  baseline: 'history.baselineNote',
  change: 'history.authorNote',
  outside: 'history.noticedNote',
};

/** Who made the version, or noticed it: what hopdeck reported, then what the host itself saw. */
function Author({ version, onSelect }: { version: HistoryVersion; onSelect(id: number): void }) {
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
            <dd className="mono">
              {connection.method === undefined ? t('history.notLogged') : `${connection.method}${connection.key === undefined ? '' : ` ${connection.key}`}`}
            </dd>
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
        {version.deployment !== undefined && (
          <>
            <dt>{t('history.deployment')}</dt>
            <dd className="mono">{version.deployment}</dd>
          </>
        )}
        {version.manualOverride === true && (
          <>
            <dt>{t('override.label')}</dt>
            <dd className={styles.warn}>{t('history.override')}</dd>
          </>
        )}
      </dl>
      <p className={styles.note}>{t(NOTES[version.kind])}</p>
    </>
  );
}

interface TableDiff {
  family: Family;
  name: string;
  status: 'added' | 'removed' | 'changed' | 'same';
  diff: DiffLine[];
}

const STATUS: Record<TableDiff['status'], MessageKey> = {
  added: 'history.table.added',
  removed: 'history.table.removed',
  changed: 'history.table.changed',
  same: 'history.table.same',
};

/** Table by table, from `before` to `after`; tables that did not change are only named. */
function Tables({
  before,
  after,
  note,
  restore,
}: {
  before: readonly TableText[];
  after: readonly TableText[];
  note: string | undefined;
  restore: ((family: Family, name: string) => void) | undefined;
}) {
  const { t } = useI18n();
  const tables = compareTables(before, after);
  return (
    <div className={styles.tables}>
      {note !== undefined && <p className={styles.note}>{note}</p>}
      {tables.length === 0 && <p className={styles.note}>{t('history.noTables')}</p>}
      {tables.map((table) => (
        <section key={`${table.family} ${table.name}`} className={styles.table}>
          <h4 className={styles.tableTitle}>
            <span className="mono">
              {table.family} {table.name}
            </span>
            <span className={`${styles.status} ${styles[`status-${table.status}`]}`}>{t(STATUS[table.status])}</span>
            {restore !== undefined && table.status !== 'same' && (
              <button type="button" className={`btn btn-sm btn-ghost ${styles.tableAction}`} onClick={() => restore(table.family, table.name)}>
                {t('history.restoreTable')}
              </button>
            )}
          </h4>
          {table.status !== 'same' && <DiffView diff={table.diff} />}
        </section>
      ))}
    </div>
  );
}

function compareTables(before: readonly TableText[], after: readonly TableText[]): TableDiff[] {
  const key = (table: { family: Family; name: string }) => `${table.family} ${table.name}`;
  const names = [...new Map([...after, ...before].map((table) => [key(table), table])).values()];
  return names.map(({ family, name }) => {
    const old = before.find((table) => key(table) === `${family} ${name}`)?.text;
    const next = after.find((table) => key(table) === `${family} ${name}`)?.text;
    const diff = diffLines(old ?? '', next ?? '');
    const status = old === undefined ? 'added' : next === undefined ? 'removed' : hasChanges(diff) ? 'changed' : 'same';
    return { family, name, status, diff };
  });
}
