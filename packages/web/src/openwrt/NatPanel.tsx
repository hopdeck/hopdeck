// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { NAT_TARGETS, natChanges, natForm, natProblems, type FirewallNat, type NatForm } from '@hopdeck/core';
import { useState } from 'react';
import { EditIcon, PlusIcon, TrashIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/locales.ts';
import { Field } from '../firewall/edit/fields.tsx';
import editor from '../firewall/edit/Editor.module.css';
import type { RulesetModel } from '../firewall/ruleset/model.ts';
import type { LiveInfo } from '../firewall/ruleset/useLive.ts';
import { fw4Counters, fw4Name } from './counters.ts';
import { fieldErrors, FormDialog } from './FormDialog.tsx';
import styles from './OpenWrt.module.css';
import { useSectionOrder } from './useSectionOrder.tsx';
import { touchedSections, type UciFirewallState } from './useUciFirewall.ts';
import { problemText } from './ZonesPanel.tsx';

interface NatPanelProps {
  state: UciFirewallState;
  model: RulesetModel | undefined;
  live: LiveInfo | undefined;
}

/**
 * The firewall's NAT rules, LuCI's NAT Rules: the source address what
 * leaves through a zone gets, in the order fw4 follows them, before the
 * masquerading of the zones. Each shows what fw4 counted for it.
 */
export function NatPanel({ state, model, live }: NatPanelProps) {
  const { t, locale } = useI18n();
  const [dialog, setDialog] = useState<{ nat?: FirewallNat; opening: number }>();
  const firewall = state.firewall!;
  const nats = firewall.nats;
  const touched = touchedSections(state.pending);
  const order = useSectionOrder(state, 'nat', nats.map((nat) => nat.section.name));
  const counters = model === undefined ? undefined : fw4Counters(model, live, 'nat');
  const number = new Intl.NumberFormat(locale);
  const masquerading = firewall.zones.filter((zone) => zone.enabled && zone.masquerade).map((zone) => zone.name);
  const matched = (address: string | undefined, port: string | undefined) =>
    [address, port === undefined ? undefined : t('uci.rules.port', { port })].filter((part) => part !== undefined).join(' ');

  return (
    <div className={styles.panel}>
      <p className={styles.note}>{t('uci.nat.intro')}</p>
      <p className={styles.note}>{masquerading.length > 0 ? t('uci.nat.zonesMasq', { zones: masquerading.join(', ') }) : t('uci.nat.noZonesMasq')}</p>
      <div className={styles.bar}>
        <button type="button" className="btn btn-primary" onClick={() => setDialog({ opening: Date.now() })}>
          <PlusIcon />
          {t('uci.nat.add')}
        </button>
      </div>
      {nats.length === 0 ? (
        <p className={styles.note}>{t('uci.nat.none')}</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th aria-label={t('uci.rules.order')} />
              <th aria-label={t('uci.rules.enabled')} />
              <th>{t('uci.rules.name')}</th>
              <th>{t('uci.nat.outThrough')}</th>
              <th>{t('uci.rules.match')}</th>
              <th>{t('uci.rules.action')}</th>
              <th className={styles.numeric}>{t('uci.rules.packets')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {nats.map((nat, index) => {
              const committed = state.base?.sections.find((section) => section.name === nat.section.name);
              const counter = committed === undefined ? undefined : counters?.get(fw4Name(committed, state.base!.sections));
              const from = matched(nat.srcIp, nat.srcPort);
              const to = matched(nat.destIp, nat.destPort);
              const match = [
                nat.protocols.length === 0 ? t('uci.nat.allProtocols') : nat.protocols.join(' '),
                from === '' ? '' : t('uci.nat.fromMatch', { what: from }),
                to === '' ? '' : t('uci.nat.toMatch', { what: to }),
              ].filter((part) => part !== '');
              const rowClass = [nat.enabled ? '' : styles.off, touched.has(nat.section.name) || order.moved.has(nat.section.name) ? styles.changed : '', order.rowClass(index)].join(' ');
              return (
                <tr key={nat.section.name} className={rowClass} {...order.rowEvents(index)}>
                  <td>{order.handle(index)}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={nat.enabled}
                      aria-label={t('uci.rules.enabled')}
                      title={t('uci.rules.enabled')}
                      onChange={(event) => state.change(natChanges(nat, { ...natForm(nat, []), enabled: event.target.checked }, state.ref()))}
                    />
                  </td>
                  <td className={`${styles.name} ${styles.nowrap}`}>{nat.name ?? <span className={styles.muted}>{fw4Name(nat.section, state.preview!.sections)}</span>}</td>
                  <td className={styles.nowrap}>
                    {nat.src === undefined || nat.src === '*' ? t('uci.rules.anyZone') : nat.src}
                    {nat.device !== undefined && <div className={styles.mono}>{nat.device}</div>}
                  </td>
                  <td className={styles.mono}>
                    {match.join(' · ')}
                    {nat.family !== undefined && <span className={`${styles.badge} ${styles.inlineBadge}`}>{nat.family === 'any' ? t('uci.rules.bothFamilies') : nat.family}</span>}
                  </td>
                  <td className={styles.nowrap}>
                    <span className={styles.policy}>{nat.target}</span>
                    <div className={nat.target === 'SNAT' ? styles.mono : styles.muted}>{rewriteText(t, nat)}</div>
                  </td>
                  <td className={styles.numeric} title={counter === undefined ? undefined : t('uci.rules.bytes', { bytes: number.format(counter.bytes) })}>
                    {counter === undefined ? <span className={styles.muted}>–</span> : number.format(counter.packets)}
                    {counter?.rate !== undefined && counter.rate > 0 && <div className={styles.muted}>{t('uci.rules.rate', { rate: number.format(Math.round(counter.rate)) })}</div>}
                  </td>
                  <td className={styles.actionsCell}>
                    <span className={styles.buttons}>
                      {order.arrows(index)}
                      <button type="button" className="btn btn-ghost btn-sm btn-icon" title={t('uci.edit')} aria-label={t('uci.edit')} onClick={() => setDialog({ nat, opening: Date.now() })}>
                        <EditIcon />
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm btn-icon btn-danger"
                        title={t('uci.remove')}
                        aria-label={t('uci.remove')}
                        onClick={() => {
                          if (window.confirm(t('uci.nat.removeConfirm', { name: nat.name ?? fw4Name(nat.section, state.preview!.sections) }))) {
                            state.change([{ kind: 'delete', section: nat.section.name }]);
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
      {dialog !== undefined && <NatDialog state={state} nat={dialog.nat} opening={dialog.opening} onClose={() => setDialog(undefined)} />}
    </div>
  );
}

/** What the rule writes as the source: the outgoing interface's address, the one given, or none. */
function rewriteText(t: ReturnType<typeof useI18n>['t'], nat: FirewallNat): string {
  if (nat.target === 'MASQUERADE') return t('uci.nat.masqShort');
  if (nat.target === 'ACCEPT') return t('uci.nat.acceptShort');
  if (nat.target !== 'SNAT') return '';
  const address = nat.snatIp?.includes(':') && nat.snatPort !== undefined ? `[${nat.snatIp}]` : nat.snatIp;
  if (address === undefined) return t('uci.rules.port', { port: nat.snatPort ?? '' });
  return nat.snatPort === undefined ? address : `${address}:${nat.snatPort}`;
}

/** None for all, as fw4 takes a NAT rule without protocols. */
const PROTOCOLS: Record<string, string[]> = { all: [], 'tcp udp': ['tcp', 'udp'], tcp: ['tcp'], udp: ['udp'] };

function NatDialog({ state, nat, opening, onClose }: { state: UciFirewallState; nat: FirewallNat | undefined; opening: number; onClose(): void }) {
  const { t } = useI18n();
  const firewall = state.firewall!;
  const zones = firewall.zones.map((zone) => zone.name);
  const [form, setForm] = useState<NatForm>(() => natForm(nat, zones));
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [revealed, setRevealed] = useState(false);
  const problems = natProblems(form);
  const { errorOf, invalid } = fieldErrors(problems, (problem) => problemText(t, problem), touched, revealed);
  const edit = (field: string, next: Partial<NatForm>) => {
    setTouched((current) => new Set([...current, field]));
    setForm((current) => ({ ...current, ...next }));
  };
  const protocolKey = form.protocols.join(' ') === 'all' ? 'all' : Object.entries(PROTOCOLS).find(([, value]) => value.join(' ') === form.protocols.join(' '))?.[0];
  const [otherProtocol, setOtherProtocol] = useState(protocolKey === undefined);
  const targets: string[] = NAT_TARGETS.includes(form.target as (typeof NAT_TARGETS)[number]) ? [...NAT_TARGETS] : [...NAT_TARGETS, form.target];
  const snat = form.target === 'SNAT';
  // A rule without a zone is for any, as "*" is.
  const zone = form.src === '' ? '*' : form.src;

  return (
    <FormDialog
      open
      opening={opening}
      title={nat === undefined ? t('uci.nat.new') : t('uci.nat.edit', { name: nat.name ?? fw4Name(nat.section, state.preview!.sections) })}
      intro={t('uci.nat.dialogIntro')}
      onClose={onClose}
      onSave={() => {
        if (problems.length > 0) {
          setRevealed(true);
          return;
        }
        state.change(natChanges(nat, form, state.ref()));
        onClose();
      }}
    >
      <Field label={t('uci.rules.name')}>
        <input className="input" value={form.name} maxLength={64} autoFocus placeholder={t('uci.nat.namePlaceholder')} onChange={(event) => edit('name', { name: event.target.value })} />
      </Field>
      <label className={editor.option}>
        <input type="checkbox" checked={form.enabled} onChange={(event) => edit('enabled', { enabled: event.target.checked })} />
        {t('uci.rules.enabled')}
      </label>
      <Field label={t('uci.rules.family')} error={errorOf('family')}>
        <select className="select" value={form.family} aria-invalid={invalid('family')} onChange={(event) => edit('family', { family: event.target.value as NatForm['family'] })}>
          <option value="">{t('uci.nat.autoFamily')}</option>
          <option value="ipv4">IPv4</option>
          <option value="ipv6">IPv6</option>
          <option value="any">{t('uci.rules.bothFamilies')}</option>
        </select>
      </Field>
      <Field label={t('uci.rules.protocol')}>
        <span className={editor.inline}>
          <select
            className="select"
            value={otherProtocol ? 'other' : protocolKey}
            onChange={(event) => {
              const key = event.target.value;
              setOtherProtocol(key === 'other');
              if (key !== 'other') edit('protocols', { protocols: PROTOCOLS[key]! });
            }}
          >
            <option value="all">{t('uci.rules.anyProtocol')}</option>
            <option value="tcp udp">TCP + UDP</option>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
            <option value="other">{t('rule.other')}</option>
          </select>
          {otherProtocol && (
            <input className="input mono" value={form.protocols.join(' ')} spellCheck={false} placeholder="icmp"
              onChange={(event) => edit('protocols', { protocols: event.target.value.split(/[,\s]+/).filter((item) => item !== '') })} />
          )}
        </span>
      </Field>

      <h3 className={styles.section}>{t('uci.nat.traffic')}</h3>
      <Field label={t('uci.nat.outZone')}>
        <select className="select" value={zone} onChange={(event) => edit('src', { src: event.target.value })}>
          <option value="*">{t('uci.rules.anyZone')}</option>
          {[...new Set([...zones, ...(zone === '*' ? [] : [zone])])].map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('uci.nat.outDevice')} error={errorOf('device')}>
        <input className="input mono" value={form.device} spellCheck={false} placeholder={t('uci.nat.anyDevice')} aria-invalid={invalid('device')}
          onChange={(event) => edit('device', { device: event.target.value })} />
      </Field>
      <Field label={t('uci.nat.srcIp')} error={errorOf('srcIp')}>
        <input className="input mono" value={form.srcIp} spellCheck={false} placeholder={t('uci.nat.anyAddress')} aria-invalid={invalid('srcIp')}
          onChange={(event) => edit('srcIp', { srcIp: event.target.value })} />
      </Field>
      <Field label={t('uci.rules.srcPort')} error={errorOf('srcPort')}>
        <input className="input mono" value={form.srcPort} spellCheck={false} placeholder={t('uci.rules.anyPort')} aria-invalid={invalid('srcPort')}
          onChange={(event) => edit('srcPort', { srcPort: event.target.value })} />
      </Field>
      <Field label={t('uci.nat.destIp')} error={errorOf('destIp')}>
        <input className="input mono" value={form.destIp} spellCheck={false} placeholder={t('uci.nat.anyAddress')} aria-invalid={invalid('destIp')}
          onChange={(event) => edit('destIp', { destIp: event.target.value })} />
      </Field>
      <Field label={t('uci.nat.destPort')} error={errorOf('destPort')}>
        <input className="input mono" value={form.destPort} spellCheck={false} placeholder={t('uci.rules.anyPort')} aria-invalid={invalid('destPort')}
          onChange={(event) => edit('destPort', { destPort: event.target.value })} />
      </Field>
      <p className={editor.note}>{t('uci.nat.trafficHint')}</p>

      <h3 className={styles.section}>{t('uci.rules.action')}</h3>
      <Field label={t('uci.rules.action')}>
        <select className="select" value={form.target} onChange={(event) => edit('target', { target: event.target.value })}>
          {targets.map((target) => (
            <option key={target} value={target}>
              {NAT_TARGETS.includes(target as (typeof NAT_TARGETS)[number]) ? t(`uci.nat.target.${target}` as MessageKey) : target}
            </option>
          ))}
        </select>
      </Field>
      {snat && (
        <>
          <Field label={t('uci.nat.snatIp')} error={errorOf('snatIp')}>
            <input className="input mono" value={form.snatIp} spellCheck={false} placeholder="203.0.113.5" aria-invalid={invalid('snatIp')}
              onChange={(event) => edit('snatIp', { snatIp: event.target.value })} />
          </Field>
          <Field label={t('uci.nat.snatPort')} error={errorOf('snatPort')}>
            <input className="input mono" value={form.snatPort} spellCheck={false} placeholder={t('uci.nat.samePort')} aria-invalid={invalid('snatPort')}
              onChange={(event) => edit('snatPort', { snatPort: event.target.value })} />
          </Field>
        </>
      )}
      <p className={editor.note}>{t(`uci.nat.targetHint.${NAT_TARGETS.includes(form.target as (typeof NAT_TARGETS)[number]) ? form.target : 'MASQUERADE'}` as MessageKey)}</p>
    </FormDialog>
  );
}
