// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { deleteIpSetChanges, IPSET_MATCHES, ipSetChanges, ipSetForm, ipSetProblems, type FirewallIpSet, type IpSetForm } from '@hopdeck/core';
import { useState } from 'react';
import { EditIcon, PlusIcon, TrashIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/locales.ts';
import { Field } from '../firewall/edit/fields.tsx';
import editor from '../firewall/edit/Editor.module.css';
import { fieldErrors, FormDialog } from './FormDialog.tsx';
import styles from './OpenWrt.module.css';
import { touchedSections, type UciFirewallState } from './useUciFirewall.ts';
import { problemText } from './ZonesPanel.tsx';

/** What a set holds, in words; several matches, a set of tuples, as fw4 names them. */
export function matchText(t: ReturnType<typeof useI18n>['t'], match: readonly string[]): string {
  if (match.length === 1 && (IPSET_MATCHES as readonly string[]).includes(match[0]!)) return t(`uci.sets.match.${match[0]}` as MessageKey);
  return match.join(' . ');
}

/** "a, b c" and lines as a list. */
const list = (text: string) => text.split(/[,\s]+/).filter((item) => item !== '');

/**
 * Named sets fw4 declares in its table, for traffic rules to match against
 * all at once: addresses to block, ports to let in. The entries are UCI's;
 * a file on the router can add more.
 */
export function IpSetsPanel({ state }: { state: UciFirewallState }) {
  const { t, locale } = useI18n();
  const [dialog, setDialog] = useState<{ set?: FirewallIpSet; opening: number }>();
  const firewall = state.firewall!;
  const touched = touchedSections(state.pending);
  const number = new Intl.NumberFormat(locale);

  return (
    <div className={styles.panel}>
      <p className={styles.note}>{t('uci.sets.intro')}</p>
      <div className={styles.bar}>
        <button type="button" className="btn btn-primary" onClick={() => setDialog({ opening: Date.now() })}>
          <PlusIcon />
          {t('uci.sets.add')}
        </button>
      </div>
      {firewall.ipsets.length === 0 ? (
        <p className={styles.note}>{t('uci.sets.none')}</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t('uci.rules.name')}</th>
              <th>{t('uci.sets.holds')}</th>
              <th>{t('uci.rules.family')}</th>
              <th>{t('uci.sets.entries')}</th>
              <th>{t('uci.sets.comment')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {firewall.ipsets.map((set) => (
              <tr key={set.section.name} className={`${set.enabled ? '' : styles.off} ${touched.has(set.section.name) ? styles.changed : ''}`}>
                <td className={`${styles.name} ${styles.nowrap}`}>{set.name}</td>
                <td className={styles.nowrap}>{matchText(t, set.match)}</td>
                <td className={styles.mono}>{set.family}</td>
                <td className={styles.mono}>
                  {set.entries.length === 0 ? <span className={styles.muted}>–</span> : `${set.entries.slice(0, 3).join(' ')}${set.entries.length > 3 ? ' …' : ''}`}
                  <div className={styles.muted}>
                    {t('uci.sets.count', { count: set.entries.length, formatted: number.format(set.entries.length) })}
                    {set.loadfile !== undefined && ` · ${t('uci.sets.fromFile', { file: set.loadfile })}`}
                  </div>
                </td>
                <td className={styles.muted}>{set.comment ?? ''}</td>
                <td className={styles.actionsCell}>
                  <span className={styles.buttons}>
                    <button type="button" className="btn btn-ghost btn-sm btn-icon" title={t('uci.edit')} aria-label={t('uci.edit')} onClick={() => setDialog({ set, opening: Date.now() })}>
                      <EditIcon />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-icon btn-danger"
                      title={t('uci.remove')}
                      aria-label={t('uci.remove')}
                      onClick={() => {
                        const removal = deleteIpSetChanges(firewall, set);
                        if (removal.usedBy.length > 0) {
                          window.alert(t('uci.sets.inUse', { name: set.name, names: removal.usedBy.join(', ') }));
                          return;
                        }
                        if (window.confirm(t('uci.sets.removeConfirm', { name: set.name }))) state.change(removal.changes);
                      }}
                    >
                      <TrashIcon />
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {dialog !== undefined && <IpSetDialog state={state} set={dialog.set} opening={dialog.opening} onClose={() => setDialog(undefined)} />}
    </div>
  );
}

function IpSetDialog({ state, set, opening, onClose }: { state: UciFirewallState; set: FirewallIpSet | undefined; opening: number; onClose(): void }) {
  const { t } = useI18n();
  const firewall = state.firewall!;
  const [form, setForm] = useState<IpSetForm>(() => ipSetForm(set));
  const [entries, setEntries] = useState(form.entries.join('\n'));
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [revealed, setRevealed] = useState(false);
  const full: IpSetForm = { ...form, entries: list(entries) };
  const problems = ipSetProblems(firewall, set, full);
  const { errorOf, invalid } = fieldErrors(problems, (problem) => problemText(t, problem), touched, revealed);
  const edit = (field: string, next: Partial<IpSetForm>) => {
    setTouched((current) => new Set([...current, field]));
    setForm((current) => ({ ...current, ...next }));
  };
  const matchKey = form.match.join(' ');
  const matches: string[] = (IPSET_MATCHES as readonly string[]).includes(matchKey) ? [...IPSET_MATCHES] : [...IPSET_MATCHES, matchKey];

  return (
    <FormDialog
      open
      opening={opening}
      title={set === undefined ? t('uci.sets.new') : t('uci.sets.edit', { name: set.name })}
      onClose={onClose}
      onSave={() => {
        if (problems.length > 0) {
          setRevealed(true);
          return;
        }
        state.change(ipSetChanges(firewall, set, full, state.ref()));
        onClose();
      }}
    >
      <Field label={t('uci.rules.name')} error={errorOf('name')}>
        <input className="input mono" value={form.name} maxLength={31} spellCheck={false} autoFocus aria-invalid={invalid('name')}
          onChange={(event) => edit('name', { name: event.target.value })} />
      </Field>
      {set !== undefined && form.name !== set.name && <p className={editor.note}>{t('uci.sets.renameNote')}</p>}
      <label className={editor.option}>
        <input type="checkbox" checked={form.enabled} onChange={(event) => edit('enabled', { enabled: event.target.checked })} />
        {t('uci.redirects.enabled')}
      </label>
      <Field label={t('uci.sets.holds')}>
        <select className="select" value={matchKey} onChange={(event) => edit('match', { match: event.target.value.split(' ') })}>
          {matches.map((match) => (
            <option key={match} value={match}>
              {matchText(t, match.split(' '))}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('uci.rules.family')}>
        <select className="select" value={form.family} onChange={(event) => edit('family', { family: event.target.value as IpSetForm['family'] })}>
          <option value="ipv4">IPv4</option>
          <option value="ipv6">IPv6</option>
        </select>
      </Field>
      <Field label={t('uci.sets.entries')} error={errorOf('entries')}>
        <textarea className={`input mono ${editor.textarea}`} rows={8} value={entries} spellCheck={false} placeholder={t('uci.sets.entriesPlaceholder')} aria-invalid={invalid('entries')}
          onChange={(event) => {
            setTouched((current) => new Set([...current, 'entries']));
            setEntries(event.target.value);
          }} />
      </Field>
      <Field label={t('uci.sets.loadfile')}>
        <input className="input mono" value={form.loadfile} spellCheck={false} placeholder={t('uci.sets.loadfilePlaceholder')} onChange={(event) => edit('loadfile', { loadfile: event.target.value })} />
      </Field>
      <Field label={t('uci.sets.comment')}>
        <input className="input" value={form.comment} maxLength={128} onChange={(event) => edit('comment', { comment: event.target.value })} />
      </Field>
      <p className={editor.note}>{t('uci.sets.hint')}</p>
    </FormDialog>
  );
}
