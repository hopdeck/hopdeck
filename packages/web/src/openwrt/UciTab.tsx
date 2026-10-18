// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { ReactNode } from 'react';
import { Callout } from '../components/Callout.tsx';
import { ErrorCallout } from '../components/ErrorCallout.tsx';
import { AlertIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import styles from './OpenWrt.module.css';
import { PendingBar } from './PendingBar.tsx';
import type { UciFirewallState } from './useUciFirewall.ts';

interface UciTabProps {
  state: UciFirewallState;
  /** The router's configuration changed since the pending changes were made on it. */
  stale: boolean;
  onReview(): void;
  /** Drops the pending changes and reads the configuration again. */
  onStart(): void;
  children(): ReactNode;
}

/** A tab of OpenWrt's firewall: what is pending above, the tab once the configuration is read. */
export function UciTab({ state, stale, onReview, onStart, children }: UciTabProps) {
  const { t } = useI18n();
  if (state.error !== undefined) return <ErrorCallout error={state.error} />;
  if (state.firewall === undefined) {
    return (
      <p className={styles.note} role="status">
        <span className="spinner" aria-hidden="true" /> {t('uci.loading')}
      </p>
    );
  }
  return (
    <div className={styles.panel}>
      {stale ? (
        <Callout tone="warn" icon={<AlertIcon />} title={t('uci.stale')} role="alert">
          <p>{t('uci.staleHint', { count: state.pending.length })}</p>
          <div>
            <button type="button" className="btn btn-sm" onClick={onStart}>
              {t('uci.staleStart')}
            </button>
          </div>
        </Callout>
      ) : (
        <PendingBar state={state} onReview={onReview} />
      )}
      {children()}
    </div>
  );
}
