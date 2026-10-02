// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { KeyUse, UsedKey } from '@hopdeck/core';
import { useId } from 'react';
import { useI18n } from '../i18n/I18nProvider.tsx';
import styles from './SshKeyPanel.module.css';

/** How ssh is to offer the host a key: hopdeck adds it, or ~/.ssh/config names it. */
export function UseChoice({ use, onChange }: { use: KeyUse; onChange(use: KeyUse): void }) {
  const { t } = useI18n();
  // Radios outside a form group by name across the page.
  const name = useId();
  return (
    <fieldset className={styles.choices}>
      <legend className={styles.text}>{t('keyGen.use')}</legend>
      {(['hopdeck', 'config'] as const).map((option) => (
        <label key={option}>
          <input type="radio" name={name} checked={use === option} onChange={() => onChange(option)} />
          {t(option === 'hopdeck' ? 'keyGen.use.hopdeck' : 'keyGen.use.config')}
        </label>
      ))}
    </fieldset>
  );
}

/** Where ssh now finds the key for the host, and the lines that do the same for ssh in a terminal. */
export function Offered({ used, destination }: { used: UsedKey; destination: string }) {
  const { t } = useI18n();
  // ssh matches Host patterns against the host, without the user.
  const host = destination.slice(destination.lastIndexOf('@') + 1);
  if (used.config === undefined) {
    return (
      <>
        <p>{t('keyGen.offeredByHopdeck')}</p>
        <pre className="details">{`Host ${host}\n    IdentityFile ${used.file}`}</pre>
      </>
    );
  }
  return (
    <>
      <p>{t('keyGen.offeredByConfig', { file: used.config.file })}</p>
      <pre className="details">{used.config.block}</pre>
      {used.config.backup !== undefined && <p>{t('keyGen.backup', { file: used.config.backup })}</p>}
    </>
  );
}
