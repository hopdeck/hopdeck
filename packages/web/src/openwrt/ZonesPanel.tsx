// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { deleteZoneChanges, ZONE_POLICIES, zoneChanges, zoneForm, zoneProblems, type FirewallZone, type UciFormProblem, type ZoneForm } from '@hopdeck/core';
import { useState } from 'react';
import { EditIcon, PlusIcon, TrashIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/locales.ts';
import { Field } from '../firewall/edit/fields.tsx';
import editor from '../firewall/edit/Editor.module.css';
import { fieldErrors, FormDialog } from './FormDialog.tsx';
import styles from './OpenWrt.module.css';
import { touchedSections, type UciFirewallState } from './useUciFirewall.ts';

/** ACCEPT, REJECT or DROP, coloured as the nft view colours verdicts. */
export function Policy({ value }: { value: string | undefined }) {
  if (value === undefined) return <span className={styles.muted}>–</span>;
  const tone = value === 'ACCEPT' ? styles.accept : value === 'DROP' ? styles.drop : value === 'REJECT' ? styles.reject : '';
  return <span className={`${styles.policy} ${tone}`}>{value}</span>;
}

export function problemText(t: ReturnType<typeof useI18n>['t'], problem: UciFormProblem): string {
  return t(`uci.problem.${problem.code}` as MessageKey, { value: problem.value ?? '' });
}

/**
 * The firewall's zones, as LuCI shows them: the networks in each, what the
 * zone lets in, out and through, masquerading, and the zones it forwards to.
 */
export function ZonesPanel({ state }: { state: UciFirewallState }) {
  const { t } = useI18n();
  const [dialog, setDialog] = useState<{ zone?: FirewallZone; opening: number }>();
  const firewall = state.firewall!;
  const touched = touchedSections(state.pending);

  return (
    <div className={styles.panel}>
      <p className={styles.note}>{t('uci.zones.intro')}</p>
      <div className={styles.bar}>
        <button type="button" className="btn btn-primary" onClick={() => setDialog({ opening: Date.now() })}>
          <PlusIcon />
          {t('uci.zones.add')}
        </button>
      </div>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>{t('uci.zones.zone')}</th>
            <th>{t('uci.zones.networks')}</th>
            <th>{t('uci.zones.input')}</th>
            <th>{t('uci.zones.output')}</th>
            <th>{t('uci.zones.forward')}</th>
            <th>{t('uci.zones.forwardsTo')}</th>
            <th />
            <th />
          </tr>
        </thead>
        <tbody>
          {firewall.zones.map((zone) => {
            const forwardsTo = firewall.forwardings.filter((forwarding) => forwarding.src === zone.name);
            const changed = touched.has(zone.section.name) || forwardsTo.some((forwarding) => touched.has(forwarding.section.name));
            return (
              <tr key={zone.section.name} className={`${zone.enabled ? '' : styles.off} ${changed ? styles.changed : ''}`}>
                <td className={`${styles.name} ${styles.nowrap}`}>{zone.name}</td>
                <td className={styles.mono}>{[...zone.networks, ...zone.devices, ...zone.subnets].join(' ') || <span className={styles.muted}>–</span>}</td>
                <td>
                  <Policy value={zone.input ?? firewall.defaults?.input} />
                </td>
                <td>
                  <Policy value={zone.output ?? firewall.defaults?.output} />
                </td>
                <td>
                  <Policy value={zone.forward ?? firewall.defaults?.forward} />
                </td>
                <td className={styles.mono}>{forwardsTo.map((forwarding) => forwarding.dest).join(' ') || <span className={styles.muted}>–</span>}</td>
                <td>
                  <span className={styles.badges}>
                    {zone.masquerade && <span className={styles.badge}>{t('uci.zones.masq')}</span>}
                    {zone.mtuFix && <span className={styles.badge}>{t('uci.zones.mtuFix')}</span>}
                    {zone.log && <span className={styles.badge}>log</span>}
                  </span>
                </td>
                <td className={styles.actionsCell}>
                  <span className={styles.buttons}>
                    <button type="button" className="btn btn-ghost btn-sm btn-icon" title={t('uci.edit')} aria-label={t('uci.edit')} onClick={() => setDialog({ zone, opening: Date.now() })}>
                      <EditIcon />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-icon btn-danger"
                      title={t('uci.remove')}
                      aria-label={t('uci.remove')}
                      onClick={() => {
                        const removal = deleteZoneChanges(firewall, zone);
                        if (removal.usedBy.length > 0) {
                          window.alert(t('uci.zones.inUse', { zone: zone.name, names: removal.usedBy.join(', ') }));
                          return;
                        }
                        if (window.confirm(t('uci.zones.removeConfirm', { zone: zone.name }))) state.change(removal.changes);
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
      {dialog !== undefined && <ZoneDialog state={state} zone={dialog.zone} opening={dialog.opening} onClose={() => setDialog(undefined)} />}
    </div>
  );
}

function ZoneDialog({ state, zone, opening, onClose }: { state: UciFirewallState; zone: FirewallZone | undefined; opening: number; onClose(): void }) {
  const { t } = useI18n();
  const firewall = state.firewall!;
  const [form, setForm] = useState<ZoneForm>(() => zoneForm(firewall, zone));
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [revealed, setRevealed] = useState(false);
  const problems = zoneProblems(firewall, zone, form);
  const { errorOf, invalid } = fieldErrors(problems, (problem) => problemText(t, problem), touched, revealed);
  const edit = (field: string, next: Partial<ZoneForm>) => {
    setTouched((current) => new Set([...current, field]));
    setForm((current) => ({ ...current, ...next }));
  };
  // The interfaces of /etc/config/network, besides loopback; ones the zone names that are not there stay listed.
  const known = state.network?.sections.filter((section) => section.type === 'interface' && section.name !== 'loopback').map((section) => section.name) ?? [];
  const networks = [...new Set([...known, ...form.networks])];
  const others = firewall.zones.filter((other) => other !== zone).map((other) => other.name);
  const toggle = (list: string[], item: string) => (list.includes(item) ? list.filter((other) => other !== item) : [...list, item]);

  return (
    <FormDialog
      open
      opening={opening}
      title={zone === undefined ? t('uci.zones.new') : t('uci.zones.edit', { zone: zone.name })}
      onClose={onClose}
      onSave={() => {
        if (problems.length > 0) {
          setRevealed(true);
          return;
        }
        state.change(zoneChanges(firewall, zone, form, state.ref()));
        onClose();
      }}
    >
      <Field label={t('uci.zones.name')} error={errorOf('name')}>
        <input className="input mono" value={form.name} maxLength={11} spellCheck={false} aria-invalid={invalid('name')} autoFocus
          onChange={(event) => edit('name', { name: event.target.value })} />
      </Field>
      {zone !== undefined && form.name !== zone.name && <p className={editor.note}>{t('uci.zones.renameNote')}</p>}
      <Field label={t('uci.zones.networks')} group>
        <span className={editor.checks}>
          {networks.map((network) => (
            <label key={network} className={editor.check}>
              <input type="checkbox" checked={form.networks.includes(network)} onChange={() => edit('networks', { networks: toggle(form.networks, network) })} />
              {network}
            </label>
          ))}
        </span>
      </Field>
      {(['input', 'output', 'forward'] as const).map((field) => (
        <Field key={field} label={t(`uci.zones.${field}`)}>
          <select className="select" value={form[field]} onChange={(event) => edit(field, { [field]: event.target.value })}>
            {ZONE_POLICIES.map((policy) => (
              <option key={policy} value={policy}>
                {policy}
              </option>
            ))}
          </select>
        </Field>
      ))}
      <p className={editor.note}>{t('uci.zones.policiesHint')}</p>
      <label className={editor.option}>
        <input type="checkbox" checked={form.masquerade} onChange={(event) => edit('masquerade', { masquerade: event.target.checked })} />
        {t('uci.zones.masquerade')}
      </label>
      <label className={editor.option}>
        <input type="checkbox" checked={form.mtuFix} onChange={(event) => edit('mtuFix', { mtuFix: event.target.checked })} />
        {t('uci.zones.mtuFixLong')}
      </label>
      <label className={editor.option}>
        <input type="checkbox" checked={form.log} onChange={(event) => edit('log', { log: event.target.checked })} />
        {t('uci.zones.log')}
      </label>
      <Field label={t('uci.zones.forwardsTo')} group>
        <span className={editor.checks}>
          {others.length === 0 && <span className={editor.note}>{t('uci.zones.noOthers')}</span>}
          {others.map((other) => (
            <label key={other} className={editor.check}>
              <input type="checkbox" checked={form.forwardTo.includes(other)} onChange={() => edit('forwardTo', { forwardTo: toggle(form.forwardTo, other) })} />
              {other}
            </label>
          ))}
        </span>
      </Field>
      <p className={editor.note}>{t('uci.zones.forwardsToHint')}</p>
    </FormDialog>
  );
}
