// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { groupPacketLog, loggingRules, ruleKey, type LoggingRule, type PacketLogEntry, type PacketLogGroup, type PacketLogSource } from '@hopdeck/core';
import { useMemo, useState } from 'react';
import { Callout } from '../../components/Callout.tsx';
import { ErrorCallout } from '../../components/ErrorCallout.tsx';
import { InfoIcon, RefreshIcon } from '../../components/icons.tsx';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import type { MessageKey } from '../../i18n/locales.ts';
import { chainAnchor, ruleCounter, type RulesetModel } from '../ruleset/model.ts';
import type { LiveInfo } from '../ruleset/useLive.ts';
import { shortIPv6 } from './format.ts';
import { usePacketLog } from './usePacketLog.ts';
import styles from './PacketLog.module.css';

interface PacketLogPanelProps {
  hostId: string;
  /** Whether the tab is in view: only then the log is read. */
  active: boolean;
  /** The rules as last read, to tell which rule logged a line. */
  model: RulesetModel | undefined;
  /** Live counters, for how many packets a logging rule saw. */
  live: LiveInfo | undefined;
  /** Shows a chain in the rules tab. */
  onShowChain(anchor: string): void;
  /** Where a prefix comes from in the host's own configuration, such as OpenWrt's UCI, when that is known. */
  origin?: ((prefix: string) => PrefixOrigin | undefined) | undefined;
}

/** The part of a host's configuration that made a logging rule, with a way to show it. */
export interface PrefixOrigin {
  label: string;
  /** What it does with the packet, where the rule that logs leaves that to another. */
  verdict?: string;
  onShow(): void;
}

const INTERVALS = [0, 2, 5, 15];
/** Lines shown at once; the filter searches all that were read. */
const SHOWN = 300;

const SOURCES: Readonly<Record<PacketLogSource['kind'], MessageKey>> = {
  journal: 'log.source.journal',
  logread: 'log.source.logread',
  file: 'log.source.file',
  dmesg: 'log.source.dmesg',
  none: 'log.source.none',
};

/**
 * The packets rules with a log statement wrote to the host's kernel log,
 * newest first. The same packet again within a second is one line with its
 * count; each line names the rule its prefix belongs to, and what that rule
 * did with the packet. hopdeck keeps none of it: it reads the host's log.
 */
export function PacketLogPanel({ hostId, active, model, live, onShowChain, origin }: PacketLogPanelProps) {
  const { t, locale } = useI18n();
  const [seconds, setSeconds] = useState(5);
  const [filter, setFilter] = useState('');
  const log = usePacketLog(hostId, active, seconds);
  const rules = useMemo(() => (model === undefined ? new Map<string, LoggingRule[]>() : loggingRules(model.ruleset)), [model]);
  const query = filter.trim().toLowerCase();
  const groups = useMemo(() => {
    const matching = query === '' ? log.entries : log.entries.filter((entry) => entry.message.toLowerCase().includes(query));
    return groupPacketLog(matching);
  }, [log.entries, query]);
  const shown = groups.slice(0, SHOWN);
  const all = [...rules.values()].flat();

  /** Packets a logging rule counted: live where the rules tab reads them, else as last read. */
  const counted = (rule: LoggingRule): number | undefined => {
    const live_ = live?.state.rules[ruleKey(rule.family, rule.table, rule.handle)];
    if (live_ !== undefined) return live_.packets;
    const table = model?.ruleset.tables.find((node) => node.table.family === rule.family && node.table.name === rule.table);
    const found = table?.chains.find((node) => node.chain.name === rule.chain)?.rules.find((candidate) => candidate.handle === rule.handle);
    return found === undefined || table === undefined ? undefined : ruleCounter(found, table)?.packets;
  };

  return (
    <div className={styles.panel}>
      <p className={styles.note}>{t('log.intro')}</p>
      <div className={`card ${styles.bar}`}>
        <label className={styles.filter}>
          <span className="visually-hidden">{t('log.filter')}</span>
          <input
            className="input mono"
            type="search"
            value={filter}
            placeholder={t('log.filterPlaceholder')}
            spellCheck={false}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        <label className={styles.refresh} title={t('log.refreshHint')}>
          {t('log.refresh')}
          <select className="select select-compact" value={seconds} onChange={(event) => setSeconds(Number(event.target.value))}>
            {INTERVALS.map((value) => (
              <option key={value} value={value}>
                {value === 0 ? t('live.off') : t('live.every', { count: value })}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-sm" disabled={log.loading} onClick={log.refresh}>
          {log.loading ? <span className="spinner" aria-hidden="true" /> : <RefreshIcon />}
          {t('log.refreshNow')}
        </button>
        {log.view !== undefined && (
          <span className={styles.source}>
            {t(SOURCES[log.view.source.kind], { path: log.view.source.kind === 'file' ? log.view.source.path : '' })}
            {' · '}
            {t('log.readAt', { time: new Date(log.view.readAt).toLocaleTimeString(locale) })}
          </span>
        )}
      </div>

      {log.error !== undefined && <ErrorCallout error={log.error} />}
      {log.view?.asUser === true && (
        <Callout tone="info" icon={<InfoIcon />} title={t('log.asUser')}>
          {t('log.asUserHint')}
        </Callout>
      )}
      {log.view?.stderr !== undefined && (
        <details className={styles.raw}>
          <summary>{t('log.stderr')}</summary>
          <pre className="details">{log.view.stderr}</pre>
        </details>
      )}

      {model !== undefined && (
        <details className={styles.rules} open={all.length > 0 && all.length <= 8}>
          <summary>{t('log.rules', { count: all.length })}</summary>
          {all.length === 0 ? (
            <p className={styles.note}>{t('log.noRules')}</p>
          ) : (
            <ul className={styles.ruleList}>
              {all.map((rule) => {
                const count = counted(rule);
                const from = origin?.(rule.prefix);
                return (
                  <li key={ruleKey(rule.family, rule.table, rule.handle)} className={styles.ruleRow}>
                    <span className="mono">{rule.prefix === '' ? t('log.noPrefix') : JSON.stringify(rule.prefix)}</span>
                    {from !== undefined && <OriginLink origin={from} />}
                    <ChainLink rule={rule} onShowChain={onShowChain} />
                    {rule.verdict !== undefined && <Verdict verdict={rule.verdict} />}
                    {count !== undefined && <span className={styles.count}>{t('log.counted', { count, formatted: count.toLocaleString(locale) })}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </details>
      )}

      {log.view !== undefined && log.entries.length === 0 && (
        <Callout tone="info" icon={<InfoIcon />} title={t(log.view.source.kind === 'none' ? 'log.noSource' : 'log.empty')}>
          {t(log.view.source.kind === 'none' ? 'log.noSourceHint' : 'log.emptyHint')}
        </Callout>
      )}
      {log.entries.length > 0 && groups.length === 0 && <p className={styles.note}>{t('log.noMatch')}</p>}

      {shown.length > 0 && (
        <ol className={styles.entries}>
          {shown.map((group) => (
            <Line key={group.key} group={group} rules={rules.get(group.entries[0]!.prefix)} origin={origin?.(group.entries[0]!.prefix)} onShowChain={onShowChain} />
          ))}
        </ol>
      )}
      {groups.length > shown.length && <p className={styles.note}>{t('log.more', { shown: shown.length, total: groups.length })}</p>}
    </div>
  );
}

function Line({ group, rules, origin, onShowChain }: { group: PacketLogGroup; rules: LoggingRule[] | undefined; origin: PrefixOrigin | undefined; onShowChain(anchor: string): void }) {
  const { t, locale } = useI18n();
  const entry = group.entries[0]!;
  const count = group.entries.length;
  const rule = rules?.length === 1 ? rules[0] : undefined;
  const verdict = origin?.verdict ?? rule?.verdict;
  return (
    <li className={styles.entry}>
      <details>
        <summary className={styles.summary}>
          <span className={`${styles.time} mono`}>{when(entry, locale)}</span>
          <span className={styles.times} title={t('log.timesHint', { count })}>
            {count > 1 ? `×${count}` : ''}
          </span>
          {verdict !== undefined ? <Verdict verdict={verdict} /> : <span className={styles.verdict} />}
          <span className="mono">{packet(entry, count)}</span>
          <span className={styles.interfaces}>{interfaces(entry)}</span>
          <span className={styles.prefix}>
            {origin !== undefined ? (
              <OriginLink origin={origin} />
            ) : rule !== undefined ? (
              <ChainLink rule={rule} onShowChain={onShowChain} />
            ) : (
              <span title={t(rules === undefined ? 'log.unmatched' : 'log.ambiguous', { count: rules?.length ?? 0 })}>
                {entry.prefix.trim() === '' ? t('log.noPrefix') : entry.prefix.trim()}
              </span>
            )}
          </span>
        </summary>
        <pre className={`details ${styles.lines}`}>{group.entries.map((one) => `${one.time === undefined ? '' : `${one.time}  `}${one.message}`).join('\n')}</pre>
      </details>
    </li>
  );
}

function ChainLink({ rule, onShowChain }: { rule: LoggingRule; onShowChain(anchor: string): void }) {
  return (
    <button type="button" className={styles.chainLink} onClick={() => onShowChain(chainAnchor(rule.family, rule.table, rule.chain))}>
      <span className={styles.family}>{rule.family}</span> {rule.table} › <strong>{rule.chain}</strong> <span className={styles.family}>#{rule.handle}</span>
    </button>
  );
}

function OriginLink({ origin }: { origin: PrefixOrigin }) {
  return (
    <button type="button" className={styles.chainLink} onClick={origin.onShow}>
      {origin.label}
    </button>
  );
}

function Verdict({ verdict }: { verdict: string }) {
  const word = verdict.replace(/^policy /, '');
  const tone = word === 'drop' || word === 'reject' ? styles.drop : word === 'accept' ? styles.accept : '';
  return (
    <span className={`${styles.verdict} ${tone}`} title={verdict}>
      {verdict}
    </span>
  );
}

/** The time of day, with the date when it is not today. */
function when(entry: PacketLogEntry, locale: string): string {
  if (entry.time === undefined) return '—';
  const time = new Date(entry.time);
  const today = new Date().toDateString() === time.toDateString();
  return today ? time.toLocaleTimeString(locale) : time.toLocaleString(locale);
}

/** "TCP 203.0.113.7:51234 → 198.51.100.10:22 SYN"; one source port stands for a group only if it is the only one. */
function packet(entry: PacketLogEntry, count: number): string {
  const port = (full: string | undefined, value: number | undefined) => {
    if (full === undefined) return '?';
    const address = shortIPv6(full);
    return value === undefined ? address : address.includes(':') ? `[${address}]:${value}` : `${address}:${value}`;
  };
  const icmp = entry.icmp === undefined ? '' : ` type ${entry.icmp.type}${entry.icmp.code === 0 ? '' : `/${entry.icmp.code}`}`;
  const flags = entry.tcpFlags.length === 0 ? '' : ` ${entry.tcpFlags.join(',')}`;
  return `${entry.protocol ?? '?'}${icmp} ${port(entry.src, count > 1 ? undefined : entry.sport)} → ${port(entry.dst, entry.dport)}${flags}`;
}

function interfaces(entry: PacketLogEntry): string {
  if (entry.in !== '' && entry.out !== '') return `${entry.in} → ${entry.out}`;
  if (entry.in !== '') return `in ${entry.in}`;
  return entry.out === '' ? '' : `out ${entry.out}`;
}
