// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { ALLOW_KEYS_FILE, type KeyBlocker, type KeySetupResult, type SshKeyInfo } from '@hopdeck/core';
import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { Callout } from '../components/Callout.tsx';
import { ErrorCallout, toErrorInfo, type ErrorInfo } from '../components/ErrorCallout.tsx';
import { PasswordField } from '../components/PasswordField.tsx';
import { AlertIcon, CheckIcon, InfoIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/locales.ts';
import styles from './SshKeyPanel.module.css';

const BLOCKERS: Readonly<Record<string, MessageKey>> = {
  pubkeyauthentication: 'keySetup.blocker.pubkeyauthentication',
  authenticationmethods: 'keySetup.blocker.authenticationmethods',
  permitrootlogin: 'keySetup.blocker.permitrootlogin',
  authorizedkeysfile: 'keySetup.blocker.authorizedkeysfile',
  pubkeyacceptedalgorithms: 'keySetup.blocker.pubkeyacceptedalgorithms',
  home: 'keySetup.blocker.home',
};

const NOT_APPLIED: Readonly<Record<NonNullable<NonNullable<KeySetupResult['allowed']>['why']>, MessageKey>> = {
  'no-directory': 'keySetup.allowed.no-directory',
  invalid: 'keySetup.allowed.invalid',
  unreadable: 'keySetup.allowed.unreadable',
  overridden: 'keySetup.allowed.overridden',
  'reload-failed': 'keySetup.allowed.reload-failed',
  unknown: 'keySetup.allowed.unknown',
};

/** What to run on the host to see the settings hopdeck looks at. */
const CHECK_COMMAND = "sshd -T | grep -iE '^(pubkeyauthentication|authenticationmethods|permitrootlogin|authorizedkeysfile|strictmodes) '";

/**
 * Puts a key on the host with one password login, as ssh-copy-id does, and
 * says whether the key alone gets in. When sshd keeps keys out, it says what
 * does, and on request adds the lines that let keys in; passwords keep
 * working. The password stays in this form until the key works, for that
 * second step, and goes to hopdeck only for those logins.
 */
export function KeySetup({
  path,
  keys,
  chosen,
  user,
  onWorks,
}: {
  path: string;
  keys: SshKeyInfo[];
  /** The key to start with, such as one just generated; the first otherwise. */
  chosen?: string | undefined;
  user?: string | undefined;
  onWorks(): void;
}) {
  const { t } = useI18n();
  const [file, setFile] = useState(keys.find((key) => key.file === chosen)?.file ?? keys[0]?.file ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'setup' | 'allow'>();
  const [result, setResult] = useState<KeySetupResult>();
  const [error, setError] = useState<ErrorInfo>();
  const key = keys.find((candidate) => candidate.file === file);

  async function run(allow: boolean, event?: FormEvent) {
    event?.preventDefault();
    setBusy(allow ? 'allow' : 'setup');
    setError(undefined);
    try {
      const { setup } = await api.post<{ setup: KeySetupResult }>(`${path}/setup`, { file, password, allow });
      setResult(setup);
      if (setup.outcome !== 'refused') setPassword('');
      if (setup.outcome === 'works') onWorks();
    } catch (caught) {
      setError(toErrorInfo(caught));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className={styles.setup}>
      <h3 className={styles.subtitle}>{t('keySetup.title')}</h3>
      <p className={styles.text}>{t('keySetup.intro')}</p>
      <form className={styles.unlock} onSubmit={(event) => void run(false, event)}>
        <label className={styles.field}>
          <span>{t('keySetup.key')}</span>
          <select
            className="input"
            value={file}
            onChange={(event) => {
              setFile(event.target.value);
              setResult(undefined);
            }}
          >
            {keys.map((candidate) => (
              <option key={candidate.file} value={candidate.file}>
                {candidate.file} ({candidate.type})
              </option>
            ))}
          </select>
        </label>
        {/* "new-password": browsers fill "off" fields with saved passwords anyway, such as a key's passphrase. */}
        <PasswordField
          className={styles.field}
          label={user === undefined ? t('keySetup.password') : t('keySetup.passwordOf', { user })}
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button type="submit" className="btn" disabled={busy !== undefined || password === '' || file === ''}>
          {busy === 'setup' && <span className="spinner" aria-hidden="true" />}
          {t('keySetup.run')}
        </button>
      </form>
      {key?.encrypted === true && !key.loaded && <p className={styles.agent}>{t('keySetup.lockedNote')}</p>}
      {result !== undefined && (
        <Result result={result} canAllow={password !== '' && busy === undefined} allowing={busy === 'allow'} onAllow={() => void run(true)} />
      )}
      {error !== undefined && <ErrorCallout error={error} />}
    </div>
  );
}

function Result({ result, canAllow, allowing, onAllow }: { result: KeySetupResult; canAllow: boolean; allowing: boolean; onAllow(): void }) {
  const { t } = useI18n();
  const { outcome, check, allowed } = result;
  const vars = { file: result.file };
  const added = <p>{t(result.added ? 'keySetup.added' : 'keySetup.alreadyThere')}</p>;

  if (outcome === 'works') {
    return (
      <Callout tone="ok" icon={<CheckIcon />} title={t('keySetup.works', vars)} role="status">
        {added}
        {allowed?.applied === true && <Allowed allowed={allowed} />}
      </Callout>
    );
  }
  if (outcome === 'unverified') {
    return (
      <Callout tone="info" icon={<InfoIcon />} title={t('keySetup.unverified', vars)} role="status">
        {added}
        <p>{t('keySetup.unverifiedHint')}</p>
        {allowed !== undefined && <Allowed allowed={allowed} />}
      </Callout>
    );
  }

  const allowLines = check.blockers.flatMap((blocker) => (blocker.allow === undefined ? [] : [blocker.allow]));
  return (
    <Callout tone="warn" icon={<AlertIcon />} title={t('keySetup.refused', vars)} role="alert">
      {added}
      {result.refusal !== undefined && (
        <div>
          <p className="details-label">{t('keySetup.sshSaid')}</p>
          <pre className="details">{result.refusal}</pre>
        </div>
      )}
      {allowed !== undefined && <Allowed allowed={allowed} />}
      {check.server === 'dropbear' && <p>{t('keySetup.dropbear', vars)}</p>}
      {check.server === 'unknown' && <p>{t('keySetup.unknownServer')}</p>}
      {check.reason !== undefined && (
        <div>
          <p>{t('keySetup.unread')}</p>
          <pre className="details">{check.reason}</pre>
        </div>
      )}
      {check.blockers.length > 0 && (
        <div>
          <p>{t('keySetup.blockers')}</p>
          <ul className={styles.blockers}>
            {check.blockers.map((blocker) => (
              <li key={blocker.setting}>{blockerText(t, blocker)}</li>
            ))}
          </ul>
        </div>
      )}
      {check.server === 'sshd' && check.reason === undefined && check.blockers.length === 0 && <p>{t('keySetup.noBlockers')}</p>}
      {check.server === 'sshd' && check.reason !== undefined && (
        <div>
          <p>{t('keySetup.checkYourself')}</p>
          <pre className="details">{CHECK_COMMAND}</pre>
        </div>
      )}
      {/* Once tried, trying again changes nothing: what was not applied says why. */}
      {allowLines.length > 0 && allowed === undefined && (
        <div className={styles.allow}>
          <p>{t('keySetup.allowIntro', { file: ALLOW_KEYS_FILE })}</p>
          <pre className="details">{allowLines.join('\n')}</pre>
          <p>{t('keySetup.allowKeeps')}</p>
          <div>
            <button type="button" className="btn btn-primary" disabled={!canAllow} onClick={onAllow}>
              {allowing && <span className="spinner" aria-hidden="true" />}
              {t('keySetup.allow')}
            </button>
          </div>
        </div>
      )}
    </Callout>
  );
}

function Allowed({ allowed }: { allowed: NonNullable<KeySetupResult['allowed']> }) {
  const { t } = useI18n();
  if (allowed.applied) {
    return (
      <div>
        <p>{t('keySetup.allowed.applied', { file: allowed.file })}</p>
        <pre className="details">{allowed.lines.join('\n')}</pre>
      </div>
    );
  }
  return (
    <div>
      <p>{t(NOT_APPLIED[allowed.why ?? 'unknown'], { file: allowed.file })}</p>
      {allowed.reason !== undefined && <pre className="details">{allowed.reason}</pre>}
    </div>
  );
}

function blockerText(t: ReturnType<typeof useI18n>['t'], blocker: KeyBlocker): string {
  const key = BLOCKERS[blocker.setting];
  return key === undefined ? t('keySetup.blocker.other', { setting: blocker.setting, value: blocker.value }) : t(key, { value: blocker.value });
}
