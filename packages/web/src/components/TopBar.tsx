// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { LanguageSelect } from '../i18n/LanguageSelect.tsx';
import { ThemeSwitch } from '../theme/ThemeSwitch.tsx';
import { LogoIcon } from './icons.tsx';
import styles from './TopBar.module.css';

export function TopBar({ version }: { version?: string | undefined }) {
  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <span className={styles.logo}>
          <LogoIcon />
        </span>
        <span className={styles.name}>hopdeck</span>
        {version !== undefined && <span className={styles.version}>v{version}</span>}
      </div>
      <div className={styles.controls}>
        <LanguageSelect />
        <ThemeSwitch />
      </div>
    </header>
  );
}
