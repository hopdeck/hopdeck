// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { AvailableKey, KeyUse, SshKeysView, UsedKey } from '@hopdeck/core';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Callout } from '../components/Callout.tsx';
import { ErrorCallout, toErrorInfo, type ErrorInfo } from '../components/ErrorCallout.tsx';
import { CheckIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { Offered, UseChoice } from './KeyOffer.tsx';
import styles from './SshKeyPanel.module.css';

interface KeyExistingProps {
  /** The host's ssh-keys API path. */
  path: string;
  /** The files ssh offers the host already, which are no choice here. */
  offered: readonly string[];
  /** The host as ssh reaches it, for the ssh config snippet. */
  destination: string;
  /** The host's keys now, and the chosen key's file. */
  onUsed(view: SshKeysView, file: string): void;
  /** Tries the host again, now that ssh offers it the key. */
  onConnect(): void;
}

/**
 * Makes ssh offer the host a private key already in ~/.ssh, as KeyGenerate
 * does a new one: one key can open any number of hosts. Shown only when
 * there is such a key that ssh does not offer the host yet.
 */
export function KeyExisting({ path, offered, destination, onUsed, onConnect }: KeyExistingProps) {
  const { t } = useI18n();
  const [available, setAvailable] = useState<{ dir: string; keys: AvailableKey[] }>();
  const [file, setFile] = useState('');
  const [use, setUse] = useState<KeyUse>('hopdeck');
  const [busy, setBusy] = useState(false);
  const [used, setUsed] = useState<{ used: UsedKey; key: AvailableKey }>();
  const [error, setError] = useState<ErrorInfo>();

  useEffect(() => {
    let current = true;
    api.get<{ dir: string; keys: AvailableKey[] }>('/ssh-keys').then(
      (listed) => current && setAvailable(listed),
      (caught: unknown) => current && setError(toErrorInfo(caught)),
    );
    return () => {
      current = false;
    };
  }, []);

  const candidates = available?.keys.filter((key) => !offered.includes(key.file)) ?? [];
  const chosen = candidates.find((key) => key.file === file) ?? candidates[0];
  if (chosen === undefined && used === undefined && error === undefined) return null;

  async function submit(key: AvailableKey) {
    setBusy(true);
    setError(undefined);
    try {
      const done = await api.post<{ used: UsedKey; keys: SshKeysView }>(`${path}/use`, { file: key.file, use });
      setUsed({ used: done.used, key });
      onUsed(done.keys, key.file);
    } catch (caught) {
      setError(toErrorInfo(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className={`${styles.setup} ${styles.generate}`}>
      <summary>{t('keyUse.title')}</summary>
      <div className={styles.body}>
        {available !== undefined && <p className={styles.text}>{t('keyUse.intro', { dir: available.dir })}</p>}
        {chosen !== undefined && (
          <>
            <div className={styles.unlock}>
              <label className={styles.field}>
                <span>{t('keyUse.key')}</span>
                <select className="input" value={chosen.file} onChange={(event) => setFile(event.target.value)}>
                  {candidates.map((key) => (
                    <option key={key.file} value={key.file}>
                      {key.file} ({key.type}
                      {key.comment === '' ? '' : `, ${key.comment}`})
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className={styles.agent}>
              <span className={styles.fingerprint}>{chosen.fingerprint}</span> · {t(chosen.encrypted ? 'sshKeys.state.locked' : 'sshKeys.state.open')}
            </p>
            <UseChoice use={use} onChange={setUse} />
            <div>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit(chosen)}>
                {busy && <span className="spinner" aria-hidden="true" />}
                {t('keyUse.submit')}
              </button>
            </div>
          </>
        )}
        {used !== undefined && (
          <Callout tone="ok" icon={<CheckIcon />} title={t('keyUse.done', { file: used.used.file })} role="status">
            <Offered used={used.used} destination={destination} />
            {used.key.encrypted ? (
              <p>{t('keyUse.nextLocked')}</p>
            ) : (
              <>
                <p>{t('keyUse.next')}</p>
                <div>
                  <button type="button" className="btn" onClick={onConnect}>
                    {t('keyUse.connect')}
                  </button>
                </div>
              </>
            )}
          </Callout>
        )}
        {error !== undefined && <ErrorCallout error={error} />}
      </div>
    </details>
  );
}
