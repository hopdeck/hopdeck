import { groupTrace, TRACE_PROTOCOLS, type HostKind, type TraceEvent, type TraceFilter, type TracedPacket, type TraceView } from '@nftm/core';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { Callout } from '../components/Callout.tsx';
import { ErrorCallout, toErrorInfo, type ErrorInfo } from '../components/ErrorCallout.tsx';
import { AlertIcon, InfoIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { chainAnchor } from '../ruleset/model.ts';
import { NftCode } from '../ruleset/NftCode.tsx';
import styles from './Trace.module.css';

/** What the tab shows, kept by the caller so a trace survives switching tabs. */
export interface TraceSession {
  filter: TraceFilter;
  seconds: number;
  perSecond: number;
  trace?: TraceView;
}

export const NEW_TRACE_SESSION: TraceSession = { filter: { protocol: 'tcp' }, seconds: 60, perSecond: 10 };

interface TracePanelProps {
  hostId: string;
  hostKind: HostKind;
  session: TraceSession;
  onSession(update: (session: TraceSession) => TraceSession): void;
  /** Shows a chain in the rules tab. */
  onShowChain(anchor: string): void;
}

const DURATIONS = [30, 60, 120, 300];
const RATES = [1, 5, 10, 50];
/** Packets shown; the trace itself keeps more. */
const SHOWN = 200;

/** Marks packets that match a filter and shows the path each one took through the chains and rules. */
export function TracePanel({ hostId, hostKind, session, onSession, onShowChain }: TracePanelProps) {
  const { t } = useI18n();
  const { filter, seconds, perSecond, trace } = session;
  const setFilter = (update: (filter: TraceFilter) => TraceFilter) => onSession((current) => ({ ...current, filter: update(current.filter) }));
  const setSeconds = (value: number) => onSession((current) => ({ ...current, seconds: value }));
  const setPerSecond = (value: number) => onSession((current) => ({ ...current, perSecond: value }));
  const setTrace = (value: TraceView) => onSession((current) => ({ ...current, trace: value }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorInfo>();
  const [now, setNow] = useState(Date.now());
  const [traffic, setTraffic] = useState<string>();
  const running = trace?.state === 'running';

  async function call(action: () => Promise<{ trace: TraceView }>) {
    setBusy(true);
    setError(undefined);
    try {
      setTrace((await action()).trace);
    } catch (caught) {
      setError(toErrorInfo(caught));
    } finally {
      setBusy(false);
    }
  }

  // While it runs: fetch what nft printed every second.
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
      api.get<{ trace: TraceView }>(`/traces/${trace.id}`).then(
        (result) => setTrace(result.trace),
        (caught: unknown) => setError(toErrorInfo(caught)),
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [running, trace?.id]);

  // Leaving the tab does not stop a trace: the host keeps recording, and this tab reads the rest on return.

  function start(event: FormEvent) {
    event.preventDefault();
    const cleaned = Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== undefined && value.trim() !== ''));
    void call(() => api.post(`/hosts/${encodeURIComponent(hostId)}/traces`, { filter: cleaned, seconds, perSecond }));
  }

  const packets = useMemo(() => (trace === undefined ? [] : groupTrace(trace.lines)), [trace?.lines.length, trace?.id]);
  const shown = packets.slice(-SHOWN);
  const remaining = running ? Math.max(0, Math.ceil((Date.parse(trace.endsAt) - now) / 1000)) : 0;
  const set = (key: keyof TraceFilter) => (value: string) => setFilter((current) => ({ ...current, [key]: value || undefined }));

  return (
    <div className={styles.panel}>
      <p className={styles.intro}>{t('trace.intro')}</p>
      <form className={`card ${styles.form}`} onSubmit={start}>
        <label className={styles.field}>
          <span>{t('rule.protocol')}</span>
          <select className="select" value={filter.protocol ?? ''} disabled={running} onChange={(event) => set('protocol')(event.target.value)}>
            <option value="">{t('rule.any')}</option>
            {TRACE_PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{protocol}</option>)}
          </select>
        </label>
        <TextField label={t('rule.srcAddress')} value={filter.saddr} placeholder="10.0.0.5" disabled={running} onChange={set('saddr')} />
        <TextField label={t('rule.dstAddress')} value={filter.daddr} placeholder="192.168.1.10" disabled={running} onChange={set('daddr')} />
        <TextField label={t('rule.srcPort')} value={filter.sport} placeholder="1024-65535" disabled={running} onChange={set('sport')} />
        <TextField label={t('rule.dstPort')} value={filter.dport} placeholder="22, 80" disabled={running} onChange={set('dport')} />
        <TextField label={t('rule.inInterface')} value={filter.iif} placeholder="eth0" disabled={running} onChange={set('iif')} />
        <label className={styles.field}>
          <span>{t('trace.duration')}</span>
          <select className="select" value={seconds} disabled={running} onChange={(event) => setSeconds(Number(event.target.value))}>
            {DURATIONS.map((value) => <option key={value} value={value}>{t('trace.seconds', { count: value })}</option>)}
          </select>
        </label>
        <label className={styles.field} title={t('trace.rateHint')}>
          <span>{t('trace.rate')}</span>
          <select className="select" value={perSecond} disabled={running} onChange={(event) => setPerSecond(Number(event.target.value))}>
            {RATES.map((value) => <option key={value} value={value}>{t('trace.perSecond', { count: value })}</option>)}
          </select>
        </label>
        <div className={styles.actions}>
          {running ? (
            <button type="button" className="btn btn-danger-solid" disabled={busy} onClick={() => void call(() => api.post(`/traces/${trace.id}/stop`))}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {t('trace.stop')}
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {t('trace.start')}
            </button>
          )}
          {hostKind === 'sandbox' && (
            <button type="button" className="btn" disabled={!running}
              onClick={() => {
                const port = Number(filter.dport?.split(/[,-]/)[0]);
                api.post<{ output: string }>(`/hosts/${encodeURIComponent(hostId)}/test-traffic`, Number.isInteger(port) && port > 0 ? { port } : {}).then(
                  (result) => setTraffic(result.output),
                  (caught: unknown) => setError(toErrorInfo(caught)),
                );
              }}>
              {t('trace.testTraffic')}
            </button>
          )}
        </div>
      </form>

      {error !== undefined && <ErrorCallout error={error} />}

      {trace !== undefined && (
        <section className={styles.status} aria-live="polite">
          {running && (
            <p className={styles.running}>
              <span className="spinner" aria-hidden="true" />
              {t('trace.running', { count: packets.length, seconds: remaining })}
            </p>
          )}
          {trace.state === 'finished' && <p className={styles.note}>{t('trace.finished', { count: packets.length })}</p>}
          {trace.problem !== undefined && (
            <ErrorCallout error={{ code: trace.problem.code, message: trace.problem.detail }} />
          )}
          {trace.cleanup !== undefined && (
            <Callout tone="warn" icon={<AlertIcon />} title={t('trace.cleanupFailed', { table: trace.table })}>
              <pre className="details">{trace.cleanup}</pre>
            </Callout>
          )}
          {traffic !== undefined && (
            <details className={styles.raw}>
              <summary>{t('trace.trafficOutput')}</summary>
              <pre className="details">{traffic}</pre>
            </details>
          )}
          <details className={styles.raw}>
            <summary>{t('trace.table', { table: trace.table })}</summary>
            <p className={styles.note}>{t('trace.tableHint', { time: new Date(trace.endsAt).toLocaleTimeString() })}</p>
            <NftCode block text={trace.definition.trimEnd()} />
          </details>
        </section>
      )}

      {trace !== undefined && packets.length === 0 && running && (
        <Callout tone="info" icon={<InfoIcon />} title={t('trace.waiting')}>
          {t('trace.waitingHint')}
        </Callout>
      )}

      {packets.length > shown.length && <p className={styles.note}>{t('trace.more', { shown: shown.length, total: packets.length })}</p>}
      <ol className={styles.packets}>
        {shown.map((packet) => (
          <PacketCard key={packet.id} packet={packet} onShowChain={onShowChain} />
        ))}
      </ol>

      {trace !== undefined && trace.lines.length > 0 && (
        <details className={styles.raw}>
          <summary>{t('trace.raw', { count: trace.lines.length })}</summary>
          {trace.dropped > 0 && <p className={styles.note}>{t('trace.dropped', { count: trace.dropped })}</p>}
          <pre className="details">{trace.lines.join('\n')}</pre>
        </details>
      )}
    </div>
  );
}

function TextField({ label, value, placeholder, disabled, onChange }: { label: string; value: string | undefined; placeholder: string; disabled: boolean; onChange(value: string): void }) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input className="input mono" value={value ?? ''} placeholder={placeholder} disabled={disabled} spellCheck={false} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function PacketCard({ packet, onShowChain }: { packet: TracedPacket; onShowChain(anchor: string): void }) {
  const { t } = useI18n();
  const { summary } = packet;
  const from = [summary.saddr, summary.sport].filter(Boolean).join(':');
  const to = [summary.daddr, summary.dport].filter(Boolean).join(':');
  const details = [
    summary.protocol,
    summary.tcpFlags && `[${summary.tcpFlags}]`,
    summary.icmpType,
    summary.iif && `iif ${summary.iif}`,
    summary.oif && `oif ${summary.oif}`,
    summary.length && `${summary.length} B`,
  ].filter(Boolean);
  // One block per chain: nft prints the packet when it enters a chain, then what happened there.
  const chains: { key: string; step: TraceEvent; events: TraceEvent[] }[] = [];
  for (const step of packet.steps) {
    const key = `${step.family} ${step.table} ${step.chain}`;
    const last = chains.at(-1);
    if (step.kind === 'packet' || last === undefined || last.key !== key) chains.push({ key, step, events: [] });
    if (step.kind !== 'packet') chains.at(-1)!.events.push(step);
  }

  return (
    <li className={`card ${styles.packet}`}>
      <header className={styles.packetHeader}>
        <span className={`${styles.verdict} ${packet.verdict === 'drop' ? styles.drop : packet.verdict === 'accept' ? styles.accept : ''}`}>
          {packet.verdict ?? t('trace.noVerdict')}
        </span>
        <span className={styles.direction}>{t(packet.direction === 'out' ? 'trace.outgoing' : 'trace.incoming')}</span>
        <span className="mono">
          {from || '?'} → {to || '?'}
        </span>
        <span className={styles.details}>{details.join(' · ')}</span>
      </header>
      {chains.length === 0 ? (
        <p className={styles.note}>{t('trace.noChains')}</p>
      ) : (
        <ol className={styles.steps}>
          {chains.map(({ key, step, events }, index) => (
            <li key={`${key} ${index}`} className={styles.chainStep}>
              <button type="button" className={styles.chainLink} onClick={() => onShowChain(chainAnchor(step.family, step.table, step.chain))}>
                <span className={styles.family}>{step.family}</span> {step.table} › <strong>{step.chain}</strong>
              </button>
              {events.length === 0 && <p className={styles.note}>{t('trace.passed')}</p>}
              {events.map((event, eventIndex) => (
                <div key={eventIndex} className={`${styles.event} ${event === packet.decidedBy ? styles.decided : ''}`}>
                  {event.kind === 'rule' ? (
                    <>
                      <NftCode text={event.rule!} />
                      <span className={styles.eventVerdict}>{event.verdict}</span>
                    </>
                  ) : event.kind === 'policy' ? (
                    <span>
                      {t('trace.policy')} <strong className="mono">{event.verdict}</strong>
                    </span>
                  ) : (
                    <span className="mono">{event.raw}</span>
                  )}
                </div>
              ))}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}
