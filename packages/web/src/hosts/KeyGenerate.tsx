// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { RSA_BITS, type GeneratedKey, type KeyType, type KeyUse, type SshKeysView } from '@hopdeck/core';
import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { Callout } from '../components/Callout.tsx';
import { ErrorCallout, toErrorInfo, type ErrorInfo } from '../components/ErrorCallout.tsx';
import { PasswordField } from '../components/PasswordField.tsx';
import { AlertIcon, CheckIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { Offered, UseChoice } from './KeyOffer.tsx';
import { LIFETIME_KEY, LIFETIMES, storedLifetime } from './SshKeyPanel.tsx';
import styles from './SshKeyPanel.module.css';

/** Ed25519, or RSA of one of the sizes hopdeck allows. */
const KINDS: readonly { value: string; type: KeyType; bits?: number }[] = [
  { value: 'ed25519', type: 'ed25519' },
  ...RSA_BITS.map((bits) => ({ value: `rsa-${bits}`, type: 'rsa' as const, bits })),
];

/** The usual file name for a key of the type, as hopdeck suggests it. */
function suggestedName(type: KeyType): string {
  return type === 'ed25519' ? 'id_ed25519_hopdeck' : 'id_rsa_hopdeck';
}

interface KeyGenerateProps {
  /** The host's ssh-keys API path. */
  path: string;
  agent: SshKeysView['agent'];
  /** The host as ssh reaches it, for the ssh config snippet. */
  destination: string;
  /** The host's keys now, and the new key's file. */
  onGenerated(view: SshKeysView, file: string): void;
}

/**
 * Generates a key pair in ~/.ssh with ssh-keygen, and makes ssh offer it to
 * this host: hopdeck keeps it for the host, or a Host block in ~/.ssh/config
 * names it. With a passphrase, the key goes to the agent at once.
 */
export function KeyGenerate({ path, agent, destination, onGenerated }: KeyGenerateProps) {
  const { t } = useI18n();
  const [kind, setKind] = useState('ed25519');
  const [name, setName] = useState(suggestedName('ed25519'));
  const [named, setNamed] = useState(false);
  const [comment, setComment] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [use, setUse] = useState<KeyUse>('hopdeck');
  const [lifetime, setLifetime] = useState(storedLifetime);
  const [busy, setBusy] = useState(false);
  // A key without a passphrase is made only once that is confirmed.
  const [askingEmpty, setAskingEmpty] = useState(false);
  const [error, setError] = useState<ErrorInfo>();
  const [made, setMade] = useState<GeneratedKey>();
  const chosen = KINDS.find((option) => option.value === kind)!;
  const mismatch = passphrase !== repeat;

  async function generate(event: FormEvent, withoutPassphrase = false) {
    event.preventDefault();
    if (mismatch || name === '') return;
    if (passphrase === '' && !withoutPassphrase) {
      setAskingEmpty(true);
      return;
    }
    setAskingEmpty(false);
    setBusy(true);
    setError(undefined);
    try {
      localStorage.setItem(LIFETIME_KEY, lifetime);
    } catch {
      // Remembered or not, the choice applies now.
    }
    try {
      const done = await api.post<{ key: GeneratedKey; keys: SshKeysView }>(`${path}/generate`, {
        type: chosen.type,
        ...(chosen.bits !== undefined && { bits: chosen.bits }),
        name,
        comment,
        passphrase,
        use,
        seconds: lifetime === 'none' ? null : Number(lifetime),
      });
      setMade(done.key);
      setPassphrase('');
      setRepeat('');
      onGenerated(done.keys, done.key.file);
    } catch (caught) {
      setError(toErrorInfo(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className={`${styles.setup} ${styles.generate}`}>
      <summary>{t('keyGen.title')}</summary>
      <div className={styles.body}>
        <p className={styles.text}>{t('keyGen.intro')}</p>
        <form className={styles.unlock} onSubmit={(event) => void generate(event)}>
          <label className={styles.field}>
            <span>{t('keyGen.type')}</span>
            <select
              className="input"
              value={kind}
              onChange={(event) => {
                const next = KINDS.find((option) => option.value === event.target.value)!;
                setKind(next.value);
                if (!named) setName(suggestedName(next.type));
              }}
            >
              {KINDS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.bits === undefined ? t('keyGen.type.ed25519') : t('keyGen.type.rsa', { bits: option.bits })}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span>{t('keyGen.name')}</span>
            <input
              className="input mono"
              required
              maxLength={64}
              pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setNamed(true);
              }}
            />
          </label>
          <label className={styles.field}>
            <span>{t('keyGen.comment')}</span>
            <input className="input" maxLength={200} placeholder={t('keyGen.commentPlaceholder')} value={comment} onChange={(event) => setComment(event.target.value)} />
          </label>
          <PasswordField
            className={styles.field}
            label={t('keyGen.passphrase')}
            autoComplete="new-password"
            value={passphrase}
            onChange={(event) => {
              setPassphrase(event.target.value);
              setAskingEmpty(false);
            }}
          />
          <PasswordField className={styles.field} label={t('keyGen.repeat')} autoComplete="new-password" value={repeat} onChange={(event) => setRepeat(event.target.value)} />
          {passphrase !== '' && agent !== 'none' && (
            <label className={styles.field}>
              <span>{t('sshKeys.lifetime')}</span>
              <select className="input" value={lifetime} onChange={(event) => setLifetime(event.target.value)}>
                {LIFETIMES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.value === 'none'
                      ? t(agent === 'hopdeck' ? 'sshKeys.lifetime.hopdeck' : agent === 'windows' ? 'sshKeys.lifetime.windows' : 'sshKeys.lifetime.session')
                      : t(option.label)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </form>
        {mismatch && repeat !== '' && <p className={styles.warning}>{t('keyGen.mismatch')}</p>}

        <UseChoice use={use} onChange={setUse} />
        <div>
          <button type="button" className="btn btn-primary" disabled={busy || mismatch || name === '' || askingEmpty} onClick={(event) => void generate(event)}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {t('keyGen.generate')}
          </button>
        </div>
        {askingEmpty && (
          <Callout tone="warn" icon={<AlertIcon />} title={t('keyGen.noPassphraseTitle')} role="alert">
            <p>{t('keyGen.noPassphrase')}</p>
            <div className={styles.actions}>
              <button type="button" className="btn btn-danger-solid" disabled={busy} onClick={(event) => void generate(event, true)}>
                {busy && <span className="spinner" aria-hidden="true" />}
                {t('keyGen.withoutPassphrase')}
              </button>
              <button type="button" className="btn" onClick={() => setAskingEmpty(false)}>
                {t('keyGen.setPassphrase')}
              </button>
            </div>
          </Callout>
        )}
        {made !== undefined && (
          <Callout tone="ok" icon={<CheckIcon />} title={t('keyGen.done', { file: made.file })} role="status">
            <p className="mono">
              {made.type} {made.fingerprint} {made.comment}
            </p>
            <p className="details-label">{t('keyGen.public')}</p>
            <pre className="details">{made.publicKey}</pre>
            <Offered used={made} destination={destination} />
            <p>{t('keyGen.next')}</p>
          </Callout>
        )}
        {error !== undefined && <ErrorCallout error={error} />}
      </div>
    </details>
  );
}
