import type { HostSummary } from '@hopdeck/core';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { ErrorCallout, toErrorInfo, type ErrorInfo } from '../components/ErrorCallout.tsx';
import { CloseIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import styles from './AddHostDialog.module.css';

interface AddHostDialogProps {
  open: boolean;
  onClose(): void;
  onAdded(host: HostSummary): void;
}

export function AddHostDialog({ open, onClose, onAdded }: AddHostDialogProps) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const destination = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      setError(null);
      element.showModal();
      destination.current?.focus();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      const { host } = await api.post<{ host: HostSummary }>('/hosts', {
        destination: String(data.get('destination') ?? ''),
        name: String(data.get('name') ?? '') || undefined,
      });
      form.reset();
      onAdded(host);
    } catch (caught) {
      setError(toErrorInfo(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} className={styles.dialog} onClose={onClose} aria-labelledby="add-host-title">
      <form className={styles.form} onSubmit={submit}>
        <div className={styles.header}>
          <h2 id="add-host-title" className={styles.title}>
            {t('addHost.title')}
          </h2>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label={t('common.close')}>
            <CloseIcon />
          </button>
        </div>

        <label className="field">
          <span className="field-label">{t('addHost.destination')}</span>
          <input
            ref={destination}
            name="destination"
            className="input mono"
            placeholder="admin@fw1.example.com"
            required
            maxLength={255}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="field-hint">{t('addHost.destinationHint')}</span>
        </label>

        <label className="field">
          <span className="field-label">{t('addHost.name')}</span>
          <input name="name" className="input" maxLength={100} autoComplete="off" />
        </label>

        {error !== null && <ErrorCallout error={error} />}

        <div className={styles.footer}>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {t('addHost.submit')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
