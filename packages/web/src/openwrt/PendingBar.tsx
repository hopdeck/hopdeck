// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { useI18n } from '../i18n/I18nProvider.tsx';
import styles from './OpenWrt.module.css';
import type { UciFirewallState } from './useUciFirewall.ts';

/** The changes collected on every tab and not on the router yet, with the way to review and apply them, or drop them. */
export function PendingBar({ state, onReview }: { state: UciFirewallState; onReview(): void }) {
  const { t } = useI18n();
  const count = state.pending.length;
  if (count === 0) return null;
  return (
    <div className={styles.pending} role="status">
      <span className={styles.pendingText}>{t('uci.pending', { count })}</span>
      <span className={styles.muted}>{t('uci.pendingHint')}</span>
      <span className={styles.spacer} />
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          if (window.confirm(t('uci.discardConfirm', { count }))) state.discard();
        }}
      >
        {t('uci.discard')}
      </button>
      <button type="button" className="btn btn-sm btn-primary" onClick={onReview}>
        {t('uci.review')}
      </button>
    </div>
  );
}
