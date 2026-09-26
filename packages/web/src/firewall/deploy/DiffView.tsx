import type { DiffLine } from '@hopdeck/core';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import { collapseDiff } from './collapse.ts';
import styles from './Deploy.module.css';

const SIGNS = { same: ' ', add: '+', remove: '-' } as const;

/** A unified line diff; unchanged runs away from changes are folded. */
export function DiffView({ diff }: { diff: readonly DiffLine[] }) {
  const { t } = useI18n();
  return (
    <pre className={styles.diff}>
      {collapseDiff(diff).map((block, index) =>
        block.kind === 'gap' ? (
          <span key={index} className={styles.gap}>
            {t('deploy.unchanged', { count: block.count })}
          </span>
        ) : (
          <span key={index} className={`${styles.diffLine} ${styles[block.line.kind]}`}>
            <span className={styles.sign} aria-hidden="true">
              {SIGNS[block.line.kind]}
            </span>
            {block.line.text || ' '}
          </span>
        ),
      )}
    </pre>
  );
}
