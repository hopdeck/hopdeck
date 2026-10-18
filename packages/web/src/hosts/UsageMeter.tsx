// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { HostUsage } from '@hopdeck/core';
import type { ErrorInfo } from '../components/ErrorCallout.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { formatBytes } from '../firewall/ruleset/model.ts';
import styles from './UsageMeter.module.css';
import { bootTime, uptimeText } from './uptime.ts';

/** The host's CPU (100% per fully busy thread, as top shows), memory in use and uptime, as useUsage() reads them. */
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
  const uptime = uptimeText(usage.uptime);
  const booted = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(bootTime(usage.readAt, usage.uptime));
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
      <Stat label={t('usage.uptime')} value={t(uptime.key, uptime.vars)} hint={t('usage.uptimeHint', { since: booted })} />
      {error !== undefined && (
        <span className={styles.stale} title={error.message}>
          {t('usage.stale')}: {error.message}
        </span>
      )}
    </div>
  );
}

/** One reading; with a share (0 to 100), a bar under it shows how full it is. */
function Stat({ label, value, extra, share, hint }: { label: string; value: string; extra?: string; share?: number; hint: string }) {
  const full = share === undefined ? 0 : Math.min(100, Math.max(0, share));
  return (
    <div className={styles.stat} title={hint}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>
        {value}
        {extra !== undefined && <span className={styles.extra}>{extra}</span>}
      </span>
      {/* Without a share, an empty bar keeps the value on the same line as the others. */}
      <span className={share === undefined ? `${styles.bar} ${styles.noBar}` : styles.bar} aria-hidden="true">
        {share !== undefined && <span className={full >= 90 ? `${styles.fill} ${styles.high}` : styles.fill} style={{ width: `${full}%` }} />}
      </span>
    </div>
  );
}
