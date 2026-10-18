// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { redirectChanges, redirectForm, redirectProblems, type FirewallRedirect, type RedirectForm } from '@hopdeck/core';
import { useState } from 'react';
import { EditIcon, PlusIcon, TrashIcon } from '../components/icons.tsx';
import { Segmented } from '../components/Segmented.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { Field } from '../firewall/edit/fields.tsx';
import editor from '../firewall/edit/Editor.module.css';
import type { RulesetModel } from '../firewall/ruleset/model.ts';
import type { LiveInfo } from '../firewall/ruleset/useLive.ts';
import { fw4Counters, fw4Name } from './counters.ts';
import { fieldErrors, FormDialog } from './FormDialog.tsx';
import styles from './OpenWrt.module.css';
import { touchedSections, type UciFirewallState } from './useUciFirewall.ts';
import { problemText } from './ZonesPanel.tsx';

interface RedirectsPanelProps {
  state: UciFirewallState;
  model: RulesetModel | undefined;
  live: LiveInfo | undefined;
}

/** Port forwards as OpenWrt keeps them: redirect sections, which fw4 turns into DNAT, with the connections each took. */
export function RedirectsPanel({ state, model, live }: RedirectsPanelProps) {
  const { t, locale } = useI18n();
  const [dialog, setDialog] = useState<{ redirect?: FirewallRedirect; opening: number }>();
  const firewall = state.firewall!;
  const touched = touchedSections(state.pending);
  const counters = model === undefined ? undefined : fw4Counters(model, live, 'redirect');
  const number = new Intl.NumberFormat(locale);

  return (
    <div className={styles.panel}>
      <p className={styles.note}>{t('uci.redirects.intro')}</p>
      <div className={styles.bar}>
        <button type="button" className="btn btn-primary" onClick={() => setDialog({ opening: Date.now() })}>
          <PlusIcon />
          {t('uci.redirects.add')}
        </button>
      </div>
      {firewall.redirects.length === 0 ? (
        <p className={styles.note}>{t('uci.redirects.none')}</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th aria-label={t('uci.redirects.enabled')} />
              <th>{t('uci.rules.name')}</th>
              <th>{t('uci.redirects.forward')}</th>
              <th>{t('uci.redirects.zones')}</th>
              <th className={styles.numeric}>{t('uci.redirects.connections')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {firewall.redirects.map((redirect) => {
              const committed = state.base?.sections.find((section) => section.name === redirect.section.name);
              const counter = committed === undefined ? undefined : counters?.get(fw4Name(committed, state.base!.sections));
              const dnat = redirect.target === 'DNAT';
              const protocols = (redirect.protocols.length === 0 ? ['tcp', 'udp'] : redirect.protocols).map((protocol) => protocol.toUpperCase()).join('+');
              return (
                <tr key={redirect.section.name} className={`${redirect.enabled ? '' : styles.off} ${touched.has(redirect.section.name) ? styles.changed : ''}`}>
                  <td>
                    <input
                      type="checkbox"
                      checked={redirect.enabled}
                      disabled={!dnat}
                      aria-label={t('uci.redirects.enabled')}
                      title={t('uci.redirects.enabled')}
                      onChange={(event) =>
                        state.change(redirectChanges(redirect, { ...redirectForm(redirect, []), enabled: event.target.checked }, state.ref()))
                      }
                    />
                  </td>
                  <td className={`${styles.name} ${styles.nowrap}`}>{redirect.name ?? <span className={styles.muted}>{fw4Name(redirect.section, state.preview!.sections)}</span>}</td>
                  <td className={styles.mono}>
                    {dnat ? (
                      <>
                        {protocols} {redirect.srcDport ?? '*'} → {redirect.destIp ?? t('uci.redirects.router')}
                        {redirect.destPort === undefined ? '' : `:${redirect.destPort}`}
                      </>
                    ) : (
                      <span className={styles.muted}>{t('uci.redirects.snat')}</span>
                    )}
                  </td>
                  <td>
                    {redirect.src ?? '–'} → {redirect.dest ?? '–'}
                    {dnat && redirect.reflection && <span className={`${styles.badge} ${styles.inlineBadge}`}>{t('uci.redirects.reflectionBadge')}</span>}
                  </td>
                  <td className={styles.numeric}>
                    {counter === undefined ? <span className={styles.muted}>–</span> : number.format(counter.packets)}
                  </td>
                  <td className={styles.actionsCell}>
                    <span className={styles.buttons}>
                      <button type="button" className="btn btn-ghost btn-sm btn-icon" title={dnat ? t('uci.edit') : t('uci.redirects.snatHint')} aria-label={t('uci.edit')} disabled={!dnat}
                        onClick={() => setDialog({ redirect, opening: Date.now() })}>
                        <EditIcon />
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm btn-icon btn-danger"
                        title={t('uci.remove')}
                        aria-label={t('uci.remove')}
                        onClick={() => {
                          if (window.confirm(t('uci.redirects.removeConfirm', { name: redirect.name ?? fw4Name(redirect.section, state.preview!.sections) }))) {
                            state.change([{ kind: 'delete', section: redirect.section.name }]);
                          }
                        }}
                      >
                        <TrashIcon />
                      </button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {dialog !== undefined && <RedirectDialog state={state} redirect={dialog.redirect} opening={dialog.opening} onClose={() => setDialog(undefined)} />}
    </div>
  );
}

type Protocol = 'tcp' | 'udp' | 'both';

function RedirectDialog({ state, redirect, opening, onClose }: { state: UciFirewallState; redirect: FirewallRedirect | undefined; opening: number; onClose(): void }) {
  const { t } = useI18n();
  const firewall = state.firewall!;
  const zones = firewall.zones.map((zone) => zone.name);
  const [form, setForm] = useState<RedirectForm>(() => redirectForm(redirect, zones));
  const [srcIps, setSrcIps] = useState(form.srcIps.join(' '));
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [revealed, setRevealed] = useState(false);
  const full: RedirectForm = { ...form, srcIps: srcIps.split(/[,\s]+/).filter((item) => item !== '') };
  const problems = redirectProblems(full);
  const { errorOf, invalid } = fieldErrors(problems, (problem) => problemText(t, problem), touched, revealed);
  const edit = (field: string, next: Partial<RedirectForm>) => {
    setTouched((current) => new Set([...current, field]));
    setForm((current) => ({ ...current, ...next }));
  };
  const protocol: Protocol = form.protocols.length === 1 && (form.protocols[0] === 'tcp' || form.protocols[0] === 'udp') ? form.protocols[0] : 'both';
  const zoneOptions = (value: string) =>
    [...new Set([...zones, ...(value === '' ? [] : [value])])].map((zone) => (
      <option key={zone} value={zone}>
        {zone}
      </option>
    ));
  const masquerading = firewall.zones.find((zone) => zone.name === form.dest)?.masquerade === true;

  return (
    <FormDialog
      open
      opening={opening}
      title={redirect === undefined ? t('uci.redirects.new') : t('uci.redirects.edit', { name: redirect.name ?? fw4Name(redirect.section, state.preview!.sections) })}
      intro={t('uci.redirects.dialogIntro')}
      onClose={onClose}
      onSave={() => {
        if (problems.length > 0) {
          setRevealed(true);
          return;
        }
        state.change(redirectChanges(redirect, full, state.ref()));
        onClose();
      }}
    >
      <Field label={t('uci.rules.name')}>
        <input className="input" value={form.name} maxLength={64} autoFocus placeholder={t('uci.redirects.namePlaceholder')} onChange={(event) => edit('name', { name: event.target.value })} />
      </Field>
      <label className={editor.option}>
        <input type="checkbox" checked={form.enabled} onChange={(event) => edit('enabled', { enabled: event.target.checked })} />
        {t('uci.redirects.enabled')}
      </label>
      <Field label={t('uci.rules.protocol')} group error={errorOf('protocols')}>
        <Segmented<Protocol>
          label={t('uci.rules.protocol')}
          value={protocol}
          onChange={(value) => edit('protocols', { protocols: value === 'both' ? ['tcp', 'udp'] : [value] })}
          options={[
            { value: 'tcp', label: 'TCP' },
            { value: 'udp', label: 'UDP' },
            { value: 'both', label: 'TCP + UDP' },
          ]}
        />
      </Field>

      <h3 className={styles.section}>{t('uci.redirects.from')}</h3>
      <Field label={t('uci.rules.zone')} error={errorOf('src')}>
        <select className="select" value={form.src} aria-invalid={invalid('src')} onChange={(event) => edit('src', { src: event.target.value })}>
          {zoneOptions(form.src)}
        </select>
      </Field>
      <Field label={t('uci.redirects.externalPort')} error={errorOf('srcDport')}>
        <input className="input mono" value={form.srcDport} spellCheck={false} placeholder="8080" aria-invalid={invalid('srcDport')}
          onChange={(event) => edit('srcDport', { srcDport: event.target.value })} />
      </Field>
      <Field label={t('uci.redirects.sources')} error={errorOf('srcIps')}>
        <input className="input mono" value={srcIps} spellCheck={false} placeholder={t('uci.rules.anyAddress')} aria-invalid={invalid('srcIps')}
          onChange={(event) => {
            setTouched((current) => new Set([...current, 'srcIps']));
            setSrcIps(event.target.value);
          }} />
      </Field>

      <h3 className={styles.section}>{t('uci.redirects.to')}</h3>
      <Field label={t('uci.rules.zone')} error={errorOf('dest')}>
        <select className="select" value={form.dest} aria-invalid={invalid('dest')} onChange={(event) => edit('dest', { dest: event.target.value })}>
          {zoneOptions(form.dest)}
        </select>
      </Field>
      <Field label={t('uci.redirects.internalIp')} error={errorOf('destIp')}>
        <input className="input mono" value={form.destIp} spellCheck={false} placeholder="192.168.1.10" aria-invalid={invalid('destIp')}
          onChange={(event) => edit('destIp', { destIp: event.target.value })} />
      </Field>
      <Field label={t('uci.redirects.internalPort')} error={errorOf('destPort')}>
        <input className="input mono" value={form.destPort} spellCheck={false} placeholder={t('uci.redirects.samePort')} aria-invalid={invalid('destPort')}
          onChange={(event) => edit('destPort', { destPort: event.target.value })} />
      </Field>

      <h3 className={styles.section}>{t('uci.redirects.how')}</h3>
      <label className={editor.option}>
        <input type="checkbox" checked={form.reflection} onChange={(event) => edit('reflection', { reflection: event.target.checked })} />
        {t('uci.redirects.reflection')}
      </label>
      <p className={editor.note}>{t('uci.redirects.reflectionHint')}</p>
      <p className={editor.note}>{t(masquerading ? 'uci.redirects.masqOn' : 'uci.redirects.masqNote', { zone: form.dest })}</p>
    </FormDialog>
  );
}
