// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { HostUsage } from '@hopdeck/core';
import type { ErrorInfo } from '../components/ErrorCallout.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { formatBytes } from '../firewall/ruleset/model.ts';
import styles from './UsageMeter.module.css';

/** The host's CPU (100% per fully busy thread, as top shows) and memory in use, as useUsage() reads them. */
export function UsageMeter({ usage, error }: { usage: HostUsage | undefined; error: ErrorInfo | undefined }) {
  const { t, locale } = useI18n();
  if (error !== undefined && usage === undefined) {
    return (
      <p className={styles.error} role="status">
        {t('usage.unavailable')}: <span className={styles.detail}>{error.message}</span>
      </p>
    );
  }
  if (usage === undefined) return null;

  const { cpu, memory } = usage;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const memoryShare = memory.total > 0 ? (memory.used / memory.total) * 100 : 0;
  return (
    <div className={styles.meter} role="group" aria-label={t('usage.label')}>
      <Stat
        label={t('usage.cpu')}
        value={`${number.format(cpu.percent)}%`}
        share={cpu.threads > 0 ? cpu.percent / cpu.threads : 0}
        hint={t('usage.cpuHint', { count: cpu.threads, max: number.format(cpu.threads * 100) })}
      />
      <Stat
        label={t('usage.ram')}
        value={`${formatBytes(memory.used, locale)} / ${formatBytes(memory.total, locale)}`}
        extra={`${number.format(memoryShare)}%`}
        share={memoryShare}
        hint={t('usage.ramHint')}
      />
      {error !== undefined && (
        <span className={styles.stale} title={error.message}>
          {t('usage.stale')}: {error.message}
        </span>
      )}
    </div>
  );
}

function Stat({ label, value, extra, share, hint }: { label: string; value: string; extra?: string; share: number; hint: string }) {
  const full = Math.min(100, Math.max(0, share));
  return (
    <div className={styles.stat} title={hint}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>
        {value}
        {extra !== undefined && <span className={styles.extra}>{extra}</span>}
      </span>
      <span className={styles.bar} aria-hidden="true">
        <span className={full >= 90 ? `${styles.fill} ${styles.high}` : styles.fill} style={{ width: `${full}%` }} />
      </span>
    </div>
  );
}
