// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { HostSummary } from '@hopdeck/core';
import { HostKindIcon, PlusIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import styles from './HostList.module.css';
import { hostStatus, hostSubtitle } from './status.ts';
import { COPYRIGHT, LICENSE_URL } from '../legal.ts';

interface HostListProps {
  hosts: readonly HostSummary[];
  selectedId: string | undefined;
  connecting: ReadonlySet<string>;
  onSelect(id: string): void;
  onAdd(): void;
}

export function HostList({ hosts, selectedId, connecting, onSelect, onAdd }: HostListProps) {
  const { t } = useI18n();
  return (
    <nav className={styles.sidebar} aria-label={t('hosts.title')}>
      <h2 className={styles.title}>{t('hosts.title')}</h2>
      <ul className={styles.list}>
        {hosts.map((host) => {
          const status = hostStatus(host, connecting.has(host.id));
          const subtitle = hostSubtitle(host);
          return (
            <li key={host.id}>
              <button
                type="button"
                className={styles.item}
                aria-current={host.id === selectedId ? 'true' : undefined}
                onClick={() => onSelect(host.id)}
              >
                <span className={styles.icon}>
                  <HostKindIcon kind={host.kind} />
                </span>
                <span className={styles.text}>
                  <span className={styles.name}>{host.name}</span>
                  <span className={'text' in subtitle ? `${styles.sub} mono` : styles.sub}>
                    {'text' in subtitle ? subtitle.text : t(subtitle.key)}
                  </span>
                </span>
                <span className={styles.marks}>
                  {host.manualOverride && (
                    <span className={styles.override} title={t('override.on')}>
                      {t('override.short')}
                    </span>
                  )}
                  <span className={`dot dot-${status.tone}`} role="img" aria-label={t(status.label)} title={t(status.label)} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" className={styles.add} onClick={onAdd}>
        <PlusIcon />
        {t('hosts.add')}
      </button>
      {/* The Appropriate Legal Notices of GPL-3.0: authors, licence, no warranty. */}
      <footer className={styles.legal}>
        <span>
          Copyright (C) {COPYRIGHT.year}{' '}
          <a href={COPYRIGHT.url} target="_blank" rel="noopener noreferrer">
            {COPYRIGHT.author}
          </a>
        </span>
        <span>
          {t('legal.license')}{' '}
          <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer">
            {t('legal.licenseLink')}
          </a>
        </span>
      </footer>
    </nav>
  );
}
