// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { HostKind, HostNetwork } from '@hopdeck/core';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.ts';
import { Callout } from '../../components/Callout.tsx';
import { ErrorCallout, toErrorInfo, type ErrorInfo } from '../../components/ErrorCallout.tsx';
import { AlertIcon } from '../../components/icons.tsx';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import styles from './Forward.module.css';

/** The host's interfaces and forwarding, read once and again on refresh(). */
export function useNetwork(hostId: string): { network: HostNetwork | undefined; error: ErrorInfo | undefined; refresh(): void; set(network: HostNetwork): void } {
  const [network, setNetwork] = useState<HostNetwork>();
  const [error, setError] = useState<ErrorInfo>();
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    let current = true;
    api.get<{ network: HostNetwork }>(`/hosts/${encodeURIComponent(hostId)}/network`).then(
      (read) => {
        if (!current) return;
        setNetwork(read.network);
        setError(undefined);
      },
      (caught: unknown) => current && setError(toErrorInfo(caught)),
    );
    return () => {
      current = false;
    };
  }, [hostId, asked]);
  return { network, error, refresh: useCallback(() => setAsked((count) => count + 1), []), set: setNetwork };
}

/**
 * Says that the host does not forward packets of a kind, without which no
 * port forward works, and offers to turn it on: now and at boot, or until
 * the next boot. It is a kernel setting, not a rule: no rollback covers it.
 */
export function ForwardingNotice({ hostId, hostKind, version, network, onNetwork }: { hostId: string; hostKind: HostKind; version: 'ip' | 'ip6'; network: HostNetwork; onNetwork(network: HostNetwork): void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<'boot' | 'now'>();
  const [error, setError] = useState<ErrorInfo>();
  if (network.forwarding[version]) return null;

  async function enable(persist: boolean) {
    setBusy(persist ? 'boot' : 'now');
    setError(undefined);
    try {
      onNetwork((await api.post<{ network: HostNetwork }>(`/hosts/${encodeURIComponent(hostId)}/forwarding`, { version, persist })).network);
    } catch (caught) {
      setError(toErrorInfo(caught));
    } finally {
      setBusy(undefined);
    }
  }

  const sandbox = hostKind === 'sandbox';
  return (
    <Callout tone="warn" icon={<AlertIcon />} title={t(version === 'ip' ? 'forward.off.ip' : 'forward.off.ip6')} role="status">
      <p>{t(version === 'ip' ? 'forward.offHint.ip' : 'forward.offHint.ip6')}</p>
      <p>{t('forward.offNoRollback')}</p>
      <div className={styles.actions}>
        {!sandbox && (
          <button type="button" className="btn btn-primary" disabled={busy !== undefined} onClick={() => void enable(true)}>
            {busy === 'boot' && <span className="spinner" aria-hidden="true" />}
            {t('forward.enableBoot')}
          </button>
        )}
        <button type="button" className="btn" disabled={busy !== undefined} onClick={() => void enable(false)}>
          {busy === 'now' && <span className="spinner" aria-hidden="true" />}
          {t(sandbox ? 'forward.enableSandbox' : 'forward.enableNow')}
        </button>
      </div>
      {error !== undefined && <ErrorCallout error={error} />}
    </Callout>
  );
}
