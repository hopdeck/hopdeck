import { stripHandles } from '@hopdeck/core';
import { useState } from 'react';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { NftCode } from './NftCode.tsx';
import styles from './Ruleset.module.css';

/** The whole ruleset as nft prints it. */
export function ListingView({ text }: { text: string }) {
  const { t } = useI18n();
  const [handles, setHandles] = useState(false);
  const [copied, setCopied] = useState<'no' | 'yes' | { failed: string }>('no');
  const shown = handles ? text : stripHandles(text);

  async function copy() {
    try {
      await navigator.clipboard.writeText(shown);
      setCopied('yes');
      setTimeout(() => setCopied('no'), 2000);
    } catch (error) {
      setCopied({ failed: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <div className={`card ${styles.listing}`}>
      <div className={styles.listingToolbar}>
        <label className={styles.checkbox}>
          <input type="checkbox" checked={handles} onChange={(event) => setHandles(event.target.checked)} />
          {t('text.handles')}
        </label>
        <button type="button" className="btn btn-sm" onClick={() => void copy()}>
          {copied === 'yes' ? t('text.copied') : t('text.copy')}
        </button>
      </div>
      {typeof copied === 'object' && (
        <p className={styles.copyError} role="alert">
          {t('text.copyFailed', { message: copied.failed })}
        </p>
      )}
      {shown.trim() === '' ? (
        <p className={styles.noRules}>{t('ruleset.empty')}</p>
      ) : (
        <NftCode block text={shown} className={styles.listingCode} />
      )}
    </div>
  );
}
