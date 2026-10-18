// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { useEffect, useRef, type ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider.tsx';
import editor from '../firewall/edit/Editor.module.css';
import styles from './OpenWrt.module.css';

interface FormDialogProps {
  open: boolean;
  /** Changes on each opening, so the form inside starts afresh. */
  opening: number;
  title: string;
  intro?: string;
  children: ReactNode;
  /** Adds the edit to the pending changes; the form shows its problems first, if it has any. */
  onSave(): void;
  onClose(): void;
}

/** A form for one section of the firewall; saving adds to the changes collected for review, nothing goes to the router yet. */
export function FormDialog({ open, opening, title, intro, children, onSave, onClose }: FormDialogProps) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog ref={dialog} className={`${editor.dialog} ${styles.dialog}`} onClose={onClose} aria-labelledby="uci-form-title">
      <div key={opening} className={editor.dialogBody}>
        <h2 id="uci-form-title" className={editor.dialogTitle}>
          {title}
        </h2>
        {intro !== undefined && <p className={editor.note}>{intro}</p>}
        <div className={editor.fields}>{children}</div>
      </div>
      <div className={editor.dialogFooter}>
        <span className={editor.note}>{t('uci.form.later')}</span>
        <span className={editor.spacer} />
        <button type="button" className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            onSave();
            // What is wrong shows at its field; the first gets the focus.
            requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
          }}
        >
          {t('uci.form.save')}
        </button>
      </div>
    </dialog>
  );
}

/** Problems shown at their fields once one was changed, or once saving was tried. */
export function fieldErrors<P extends { field: string }>(problems: readonly P[], text: (problem: P) => string, touched: ReadonlySet<string>, revealed: boolean) {
  const errorOf = (field: string) =>
    revealed || touched.has(field)
      ? problems
          .filter((problem) => problem.field === field)
          .map(text)
          .join(' ') || undefined
      : undefined;
  return { errorOf, invalid: (field: string) => (errorOf(field) === undefined ? undefined : true) };
}
