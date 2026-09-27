// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { SshKeyInfo, SshKeysView } from '@hopdeck/core';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { ErrorCallout, toErrorInfo, type ErrorInfo } from '../components/ErrorCallout.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/locales.ts';
import styles from './SshKeyPanel.module.css';

/** How long the agent keeps an unlocked key; "none" as long as the agent runs. */
const LIFETIMES: readonly { value: string; label: MessageKey }[] = [
  { value: '900', label: 'sshKeys.lifetime.15m' },
  { value: '3600', label: 'sshKeys.lifetime.1h' },
  { value: '14400', label: 'sshKeys.lifetime.4h' },
  { value: '28800', label: 'sshKeys.lifetime.8h' },
  { value: '86400', label: 'sshKeys.lifetime.24h' },
  { value: 'none', label: 'sshKeys.lifetime.none' },
];

const LIFETIME_KEY = 'hopdeck.keyLifetime';

/** The viewer's last choice; storage can be missing or refuse, so it falls back to an hour. */
function storedLifetime(): string {
  try {
    const stored = localStorage.getItem(LIFETIME_KEY);
    return LIFETIMES.some((option) => option.value === stored) ? stored! : '3600';
  } catch {
    return '3600';
  }
}

/**
 * The private keys ssh offers an SSH host that refused the login, and a way to
 * unlock one: its passphrase goes to ssh-add once, and the agent keeps the key
 * for as long as the user chose. hopdeck keeps the passphrase nowhere.
 */
export function SshKeyPanel({ hostId, onUnlocked }: { hostId: string; onUnlocked(): void }) {
  const { t } = useI18n();
  const [view, setView] = useState<SshKeysView>();
  const [error, setError] = useState<ErrorInfo>();
  const path = `/hosts/${encodeURIComponent(hostId)}/ssh-keys`;

  const load = useCallback(async () => {
    try {
      setView((await api.get<{ keys: SshKeysView }>(path)).keys);
      setError(undefined);
    } catch (caught) {
      setError(toErrorInfo(caught));
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  if (view === undefined) return error === undefined ? null : <ErrorCallout error={error} />;
  const locked = view.keys.filter((key) => key.encrypted && !key.loaded);

  return (
    <section className={`card ${styles.panel}`} aria-labelledby="ssh-keys-title">
      <h2 id="ssh-keys-title" className={styles.title}>
        {t('sshKeys.title')}
      </h2>
      {view.keys.length === 0 ? (
        <p className={styles.text}>{t('sshKeys.none')}</p>
      ) : (
        <>
          <p className={styles.text}>{t(locked.length > 0 ? 'sshKeys.intro' : 'sshKeys.allOpen')}</p>
          <ul className={styles.keys}>
            {view.keys.map((key) => (
              <Key key={key.file} sshKey={key} view={view} path={path} onUnlocked={onUnlocked} />
            ))}
          </ul>
          <p className={styles.agent}>{t(view.agent === 'session' ? 'sshKeys.agent.session' : 'sshKeys.agent.hopdeck')}</p>
        </>
      )}
      {error !== undefined && <ErrorCallout error={error} />}
    </section>
  );
}

function Key({ sshKey, view, path, onUnlocked }: { sshKey: SshKeyInfo; view: SshKeysView; path: string; onUnlocked(): void }) {
  const { t } = useI18n();
  const [passphrase, setPassphrase] = useState('');
  const [lifetime, setLifetime] = useState(storedLifetime);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorInfo>();
  const state: MessageKey = sshKey.loaded ? 'sshKeys.state.loaded' : sshKey.encrypted ? 'sshKeys.state.locked' : 'sshKeys.state.open';

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      localStorage.setItem(LIFETIME_KEY, lifetime);
    } catch {
      // Remembered or not, the choice applies now.
    }
    try {
      await api.post<{ keys: SshKeysView }>(`${path}/unlock`, {
        file: sshKey.file,
        passphrase,
        seconds: lifetime === 'none' ? null : Number(lifetime),
      });
      setPassphrase('');
      onUnlocked();
    } catch (caught) {
      setError(toErrorInfo(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={styles.key}>
      <div className={styles.keyHead}>
        <span className={styles.file}>{sshKey.file}</span>
        <span className={styles.type}>{sshKey.type}</span>
        <span className={styles.fingerprint}>{sshKey.fingerprint}</span>
        {sshKey.comment !== '' && <span className={styles.comment}>{sshKey.comment}</span>}
        <span className={`${styles.state} ${styles[`state-${sshKey.loaded ? 'loaded' : sshKey.encrypted ? 'locked' : 'open'}`]}`}>{t(state)}</span>
      </div>
      {sshKey.encrypted && !sshKey.loaded && (
        <form className={styles.unlock} onSubmit={(event) => void unlock(event)}>
          <label className={styles.field}>
            <span>{t('sshKeys.passphrase')}</span>
            <input
              className="input"
              type="password"
              autoComplete="off"
              required
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>{t('sshKeys.lifetime')}</span>
            <select className="input" value={lifetime} onChange={(event) => setLifetime(event.target.value)}>
              {LIFETIMES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.value === 'none' ? t(view.agent === 'session' ? 'sshKeys.lifetime.session' : 'sshKeys.lifetime.hopdeck') : t(option.label)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || passphrase === ''}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {t('sshKeys.unlock')}
          </button>
        </form>
      )}
      {error !== undefined && <ErrorCallout error={error} />}
    </li>
  );
}
