// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { SshKeyInfo, SshKeysView } from '@hopdeck/core';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { ErrorCallout, toErrorInfo, type ErrorInfo } from '../components/ErrorCallout.tsx';
import { PasswordField } from '../components/PasswordField.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/locales.ts';
import { KeyExisting } from './KeyExisting.tsx';
import { KeyGenerate } from './KeyGenerate.tsx';
import { KeySetup } from './KeySetup.tsx';
import styles from './SshKeyPanel.module.css';

/** How long the agent keeps an unlocked key; "none" as long as the agent runs. */
export const LIFETIMES: readonly { value: string; label: MessageKey }[] = [
  { value: '900', label: 'sshKeys.lifetime.15m' },
  { value: '3600', label: 'sshKeys.lifetime.1h' },
  { value: '14400', label: 'sshKeys.lifetime.4h' },
  { value: '28800', label: 'sshKeys.lifetime.8h' },
  { value: '86400', label: 'sshKeys.lifetime.24h' },
  { value: 'none', label: 'sshKeys.lifetime.none' },
];

export const LIFETIME_KEY = 'hopdeck.keyLifetime';

/** What the agent that holds unlocked keys is, and how long it keeps them. */
const AGENT_TEXT: Readonly<Record<Exclude<SshKeysView['agent'], 'none'>, MessageKey>> = {
  session: 'sshKeys.agent.session',
  hopdeck: 'sshKeys.agent.hopdeck',
  windows: 'sshKeys.agent.windows',
};

/** The viewer's last choice; storage can be missing or refuse, so it falls back to an hour. */
export function storedLifetime(): string {
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
 * for as long as the user chose. hopdeck keeps the passphrase nowhere. Below
 * them, ways to give the host another key, one already in ~/.ssh or a new
 * one, and to put a key on the host.
 */
export function SshKeyPanel({ hostId, destination, onUnlocked }: { hostId: string; destination: string; onUnlocked(): void }) {
  const { t } = useI18n();
  const [view, setView] = useState<SshKeysView>();
  // The key last generated or chosen here, which the key setup then puts on the host.
  const [latest, setLatest] = useState<string>();
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

  async function forget() {
    try {
      setView((await api.delete<{ keys: SshKeysView }>(`${path}/remembered`)).keys);
      setError(undefined);
    } catch (caught) {
      setError(toErrorInfo(caught));
    }
  }

  function offer(next: SshKeysView, file: string) {
    setView(next);
    setLatest(file);
  }

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
              <Key
                key={key.file}
                sshKey={key}
                view={view}
                path={path}
                onUnlocked={(next) => {
                  // In the agent now, whether or not the host takes the key.
                  setView(next);
                  onUnlocked();
                }}
              />
            ))}
          </ul>
          {view.agent === 'none' ? (
            <div>
              <p className={styles.text}>{t('sshKeys.agent.none')}</p>
              {view.agentError !== undefined && <pre className="details">{view.agentError}</pre>}
            </div>
          ) : (
            <p className={styles.agent}>{t(AGENT_TEXT[view.agent])}</p>
          )}
          {view.remembered !== undefined && (
            <p className={styles.remembered}>
              <span>{t('sshKeys.remembered', { file: view.remembered })}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void forget()}>
                {t('sshKeys.forget')}
              </button>
            </p>
          )}
        </>
      )}
      <KeyExisting path={path} offered={view.keys.map((key) => key.file)} destination={destination} onUsed={offer} onConnect={onUnlocked} />
      <KeyGenerate path={path} agent={view.agent} destination={destination} onGenerated={offer} />
      {view.keys.length > 0 && <KeySetup key={latest} path={path} keys={view.keys} chosen={latest} user={view.user} onWorks={onUnlocked} />}
      {error !== undefined && <ErrorCallout error={error} />}
    </section>
  );
}

function Key({ sshKey, view, path, onUnlocked }: { sshKey: SshKeyInfo; view: SshKeysView; path: string; onUnlocked(view: SshKeysView): void }) {
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
      const { keys } = await api.post<{ keys: SshKeysView }>(`${path}/unlock`, {
        file: sshKey.file,
        passphrase,
        seconds: lifetime === 'none' ? null : Number(lifetime),
      });
      setPassphrase('');
      onUnlocked(keys);
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
      {sshKey.encrypted && !sshKey.loaded && view.agent !== 'none' && (
        <form className={styles.unlock} onSubmit={(event) => void unlock(event)}>
          <PasswordField
            className={styles.field}
            label={t('sshKeys.passphrase')}
            autoComplete="off"
            required
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
          />
          <label className={styles.field}>
            <span>{t('sshKeys.lifetime')}</span>
            <select className="input" value={lifetime} onChange={(event) => setLifetime(event.target.value)}>
              {LIFETIMES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.value === 'none'
                    ? t(view.agent === 'hopdeck' ? 'sshKeys.lifetime.hopdeck' : view.agent === 'windows' ? 'sshKeys.lifetime.windows' : 'sshKeys.lifetime.session')
                    : t(option.label)}
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
