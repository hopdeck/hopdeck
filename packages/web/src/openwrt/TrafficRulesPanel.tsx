// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import {
  ipSetReference,
  movedSections,
  RULE_TARGETS,
  trafficRuleChanges,
  trafficRuleForm,
  trafficRuleProblems,
  typeOrder,
  type FirewallRule,
  type TrafficRuleForm,
} from '@hopdeck/core';
import { useState } from 'react';
import { ArrowDownIcon, ArrowUpIcon, EditIcon, PlusIcon, TrashIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { Field } from '../firewall/edit/fields.tsx';
import editor from '../firewall/edit/Editor.module.css';
import type { RulesetModel } from '../firewall/ruleset/model.ts';
import type { LiveInfo } from '../firewall/ruleset/useLive.ts';
import { fw4Counters, fw4Name } from './counters.ts';
import { fieldErrors, FormDialog } from './FormDialog.tsx';
import styles from './OpenWrt.module.css';
import { touchedSections, type UciFirewallState } from './useUciFirewall.ts';
import { Policy, problemText } from './ZonesPanel.tsx';

interface TrafficRulesPanelProps {
  state: UciFirewallState;
  model: RulesetModel | undefined;
  live: LiveInfo | undefined;
}

/**
 * The firewall's traffic rules in the order fw4 follows them, which is UCI's:
 * dragged, or moved with the arrows, into another. Each shows what fw4 counted
 * for it.
 */
export function TrafficRulesPanel({ state, model, live }: TrafficRulesPanelProps) {
  const { t, locale } = useI18n();
  const [dialog, setDialog] = useState<{ rule?: FirewallRule; opening: number }>();
  const [dragged, setDragged] = useState<number>();
  const [over, setOver] = useState<{ index: number; after: boolean }>();
  const firewall = state.firewall!;
  const rules = firewall.rules;
  const touched = touchedSections(state.pending);
  // A dragged rule is marked as changed, not the ones it passed.
  const moved = movedSections(
    state.base?.sections.filter((section) => section.type === 'rule').map((section) => section.name) ?? [],
    rules.map((rule) => rule.section.name),
  );
  const counters = model === undefined ? undefined : fw4Counters(model, live, 'rule');
  const number = new Intl.NumberFormat(locale);

  /** Puts the rule at `from` before the one at `to`, or after it. */
  const move = (from: number, to: number, after: boolean) => {
    const names = rules.map((rule) => rule.section.name);
    const [moved] = names.splice(from, 1);
    const target = to > from ? to - 1 : to;
    names.splice(after ? target + 1 : target, 0, moved!);
    if (names.every((name, index) => name === rules[index]!.section.name)) return;
    state.change([typeOrder(state.preview!, 'rule', names)]);
  };
  const zoneText = (zone: string | undefined) => (zone === undefined || zone === '' ? t('uci.rules.device') : zone === '*' ? t('uci.rules.anyZone') : zone);

  return (
    <div className={styles.panel}>
      <p className={styles.note}>{t('uci.rules.intro')}</p>
      <div className={styles.bar}>
        <button type="button" className="btn btn-primary" onClick={() => setDialog({ opening: Date.now() })}>
          <PlusIcon />
          {t('uci.rules.add')}
        </button>
      </div>
      <table className={styles.table}>
        <thead>
          <tr>
            <th aria-label={t('uci.rules.order')} />
            <th aria-label={t('uci.rules.enabled')} />
            <th>{t('uci.rules.name')}</th>
            <th>{t('uci.rules.from')}</th>
            <th>{t('uci.rules.to')}</th>
            <th>{t('uci.rules.match')}</th>
            <th>{t('uci.rules.action')}</th>
            <th className={styles.numeric}>{t('uci.rules.packets')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rules.map((rule, index) => {
            const committed = state.base?.sections.find((section) => section.name === rule.section.name);
            const counter = committed === undefined ? undefined : counters?.get(fw4Name(committed, state.base!.sections));
            const match = [
              rule.protocols.length === 0 ? 'tcp udp' : rule.protocols.join(' '),
              rule.destPort === undefined ? '' : t('uci.rules.port', { port: rule.destPort }),
              rule.icmpTypes.join(' '),
              rule.ipset === undefined ? '' : `${ipSetReference(rule.ipset).not ? '!' : ''}@${ipSetReference(rule.ipset).name}`,
            ].filter((part) => part !== '');
            const rowClass = [
              rule.enabled ? '' : styles.off,
              touched.has(rule.section.name) || moved.has(rule.section.name) ? styles.changed : '',
              dragged === index ? styles.dragging : '',
              over?.index === index ? (over.after ? styles.dropAfter : styles.dropBefore) : '',
            ].join(' ');
            return (
              <tr
                key={rule.section.name}
                className={rowClass}
                onDragOver={(event) => {
                  if (dragged === undefined) return;
                  event.preventDefault();
                  const box = event.currentTarget.getBoundingClientRect();
                  setOver({ index, after: event.clientY > box.top + box.height / 2 });
                }}
                onDragLeave={() => setOver((current) => (current?.index === index ? undefined : current))}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragged !== undefined && over !== undefined) move(dragged, over.index, over.after);
                  setDragged(undefined);
                  setOver(undefined);
                }}
              >
                <td>
                  <span
                    className={styles.handle}
                    draggable
                    title={t('uci.rules.drag')}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move';
                      // Firefox starts a drag only with some data.
                      event.dataTransfer.setData('text/plain', rule.section.name);
                      setDragged(index);
                    }}
                    onDragEnd={() => {
                      setDragged(undefined);
                      setOver(undefined);
                    }}
                  >
                    ⠿
                  </span>
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    aria-label={t('uci.rules.enabled')}
                    title={t('uci.rules.enabled')}
                    onChange={(event) => state.change(trafficRuleChanges(rule, { ...trafficRuleForm(rule), enabled: event.target.checked }, state.ref()))}
                  />
                </td>
                <td className={`${styles.name} ${styles.nowrap}`}>{rule.name ?? <span className={styles.muted}>{fw4Name(rule.section, state.preview!.sections)}</span>}</td>
                <td className={styles.nowrap}>
                  {zoneText(rule.src)}
                  {(rule.srcIps.length > 0 || rule.srcPort !== undefined) && (
                    <div className={styles.mono}>{[...rule.srcIps, ...(rule.srcPort === undefined ? [] : [t('uci.rules.port', { port: rule.srcPort })])].join(' ')}</div>
                  )}
                </td>
                <td className={styles.nowrap}>
                  {zoneText(rule.dest)}
                  {rule.destIps.length > 0 && <div className={styles.mono}>{rule.destIps.join(' ')}</div>}
                </td>
                <td className={styles.mono}>
                  {match.join(' · ')}
                  {rule.family !== undefined && <span className={`${styles.badge} ${styles.inlineBadge}`}>{rule.family}</span>}
                </td>
                <td>
                  <Policy value={rule.target} />
                </td>
                <td className={styles.numeric} title={counter === undefined ? undefined : t('uci.rules.bytes', { bytes: number.format(counter.bytes) })}>
                  {counter === undefined ? <span className={styles.muted}>–</span> : number.format(counter.packets)}
                  {counter?.rate !== undefined && counter.rate > 0 && <div className={styles.muted}>{t('uci.rules.rate', { rate: number.format(Math.round(counter.rate)) })}</div>}
                </td>
                <td className={styles.actionsCell}>
                  <span className={styles.buttons}>
                    <button type="button" className="btn btn-ghost btn-sm btn-icon" title={t('editor.up')} aria-label={t('editor.up')} disabled={index === 0} onClick={() => move(index, index - 1, false)}>
                      <ArrowUpIcon />
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm btn-icon" title={t('editor.down')} aria-label={t('editor.down')} disabled={index === rules.length - 1} onClick={() => move(index, index + 1, true)}>
                      <ArrowDownIcon />
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm btn-icon" title={t('uci.edit')} aria-label={t('uci.edit')} onClick={() => setDialog({ rule, opening: Date.now() })}>
                      <EditIcon />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-icon btn-danger"
                      title={t('uci.remove')}
                      aria-label={t('uci.remove')}
                      onClick={() => {
                        if (window.confirm(t('uci.rules.removeConfirm', { name: rule.name ?? fw4Name(rule.section, state.preview!.sections) }))) {
                          state.change([{ kind: 'delete', section: rule.section.name }]);
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
      {rules.length === 0 && <p className={styles.note}>{t('uci.rules.none')}</p>}
      {dialog !== undefined && <TrafficRuleDialog state={state} rule={dialog.rule} opening={dialog.opening} onClose={() => setDialog(undefined)} />}
    </div>
  );
}

/** "a, b c" as a list. */
const list = (text: string) => text.split(/[,\s]+/).filter((item) => item !== '');

const PROTOCOLS: Record<string, string[]> = { 'tcp udp': [], tcp: ['tcp'], udp: ['udp'], icmp: ['icmp'], all: ['all'] };

function TrafficRuleDialog({ state, rule, opening, onClose }: { state: UciFirewallState; rule: FirewallRule | undefined; opening: number; onClose(): void }) {
  const { t } = useI18n();
  const firewall = state.firewall!;
  const [form, setForm] = useState<TrafficRuleForm>(() => trafficRuleForm(rule));
  const [srcIps, setSrcIps] = useState(form.srcIps.join(' '));
  const [destIps, setDestIps] = useState(form.destIps.join(' '));
  const [icmpTypes, setIcmpTypes] = useState(form.icmpTypes.join(' '));
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [revealed, setRevealed] = useState(false);
  const full: TrafficRuleForm = { ...form, srcIps: list(srcIps), destIps: list(destIps), icmpTypes: list(icmpTypes) };
  const problems = trafficRuleProblems(full, firewall.ipsets.map((set) => set.name));
  const reference = ipSetReference(form.ipset);
  const setOptions = [...new Set([...firewall.ipsets.map((set) => set.name), ...(reference.name === '' ? [] : [reference.name])])];
  const setIpset = (name: string, not: boolean) => edit('ipset', { ipset: name === '' ? '' : `${not ? '!' : ''}${name}${reference.rest}` });
  const { errorOf, invalid } = fieldErrors(problems, (problem) => problemText(t, problem), touched, revealed);
  const edit = (field: string, next: Partial<TrafficRuleForm>) => {
    setTouched((current) => new Set([...current, field]));
    setForm((current) => ({ ...current, ...next }));
  };
  const protocolKey = Object.entries(PROTOCOLS).find(([, value]) => value.join(' ') === form.protocols.join(' '))?.[0];
  const [otherProtocol, setOtherProtocol] = useState(protocolKey === undefined);
  const zones = firewall.zones.map((zone) => zone.name);
  const targets = RULE_TARGETS.includes(form.target as (typeof RULE_TARGETS)[number]) || form.target === '' ? RULE_TARGETS : [...RULE_TARGETS, form.target];
  const icmp = full.protocols.some((protocol) => protocol.startsWith('icmp'));

  const zoneSelect = (field: 'src' | 'dest') => (
    <select className="select" value={form[field]} onChange={(event) => edit(field, { [field]: event.target.value })}>
      <option value="">{t('uci.rules.device')}</option>
      <option value="*">{t('uci.rules.anyZone')}</option>
      {[...new Set([...zones, ...(form[field] === '' || form[field] === '*' ? [] : [form[field]])])].map((zone) => (
        <option key={zone} value={zone}>
          {zone}
        </option>
      ))}
    </select>
  );

  return (
    <FormDialog
      open
      opening={opening}
      title={rule === undefined ? t('uci.rules.new') : t('uci.rules.edit', { name: rule.name ?? fw4Name(rule.section, state.preview!.sections) })}
      onClose={onClose}
      onSave={() => {
        if (problems.length > 0) {
          setRevealed(true);
          return;
        }
        state.change(trafficRuleChanges(rule, full, state.ref()));
        onClose();
      }}
    >
      <Field label={t('uci.rules.name')}>
        <input className="input" value={form.name} maxLength={64} autoFocus onChange={(event) => edit('name', { name: event.target.value })} />
      </Field>
      <label className={editor.option}>
        <input type="checkbox" checked={form.enabled} onChange={(event) => edit('enabled', { enabled: event.target.checked })} />
        {t('uci.rules.enabled')}
      </label>
      <Field label={t('uci.rules.family')}>
        <select className="select" value={form.family} onChange={(event) => edit('family', { family: event.target.value as TrafficRuleForm['family'] })}>
          <option value="">{t('uci.rules.bothFamilies')}</option>
          <option value="ipv4">IPv4</option>
          <option value="ipv6">IPv6</option>
        </select>
      </Field>
      <Field label={t('uci.rules.protocol')} error={errorOf('protocols')}>
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
            <option value="tcp udp">TCP + UDP</option>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
            <option value="icmp">ICMP</option>
            <option value="all">{t('uci.rules.anyProtocol')}</option>
            <option value="other">{t('rule.other')}</option>
          </select>
          {otherProtocol && (
            <input className="input mono" value={form.protocols.join(' ')} spellCheck={false} placeholder="esp gre"
              onChange={(event) => edit('protocols', { protocols: list(event.target.value) })} />
          )}
        </span>
      </Field>

      <h3 className={styles.section}>{t('uci.rules.from')}</h3>
      <Field label={t('uci.rules.zone')}>{zoneSelect('src')}</Field>
      <Field label={t('uci.rules.addresses')} error={errorOf('srcIps')}>
        <input className="input mono" value={srcIps} spellCheck={false} placeholder={t('uci.rules.anyAddress')} aria-invalid={invalid('srcIps')}
          onChange={(event) => {
            setTouched((current) => new Set([...current, 'srcIps']));
            setSrcIps(event.target.value);
          }} />
      </Field>
      <Field label={t('uci.rules.srcPort')} error={errorOf('srcPort')}>
        <input className="input mono" value={form.srcPort} spellCheck={false} placeholder={t('uci.rules.anyPort')} aria-invalid={invalid('srcPort')}
          onChange={(event) => edit('srcPort', { srcPort: event.target.value })} />
      </Field>

      <h3 className={styles.section}>{t('uci.rules.to')}</h3>
      <Field label={t('uci.rules.zone')}>{zoneSelect('dest')}</Field>
      <Field label={t('uci.rules.addresses')} error={errorOf('destIps')}>
        <input className="input mono" value={destIps} spellCheck={false} placeholder={t('uci.rules.anyAddress')} aria-invalid={invalid('destIps')}
          onChange={(event) => {
            setTouched((current) => new Set([...current, 'destIps']));
            setDestIps(event.target.value);
          }} />
      </Field>
      <Field label={t('uci.rules.destPort')} error={errorOf('destPort')}>
        <input className="input mono" value={form.destPort} spellCheck={false} placeholder={t('uci.rules.anyPort')} aria-invalid={invalid('destPort')}
          onChange={(event) => edit('destPort', { destPort: event.target.value })} />
      </Field>
      {(icmp || icmpTypes !== '') && (
        <Field label={t('uci.rules.icmpTypes')} error={errorOf('icmpTypes')}>
          <input className="input mono" value={icmpTypes} spellCheck={false} placeholder="echo-request" aria-invalid={invalid('icmpTypes')}
            onChange={(event) => {
              setTouched((current) => new Set([...current, 'icmpTypes']));
              setIcmpTypes(event.target.value);
            }} />
        </Field>
      )}
      <p className={editor.note}>{t('uci.rules.zonesHint')}</p>
      <Field label={t('uci.rules.ipset')} error={errorOf('ipset')}>
        <span className={editor.inline}>
          <select className="select" value={reference.name} aria-invalid={invalid('ipset')} onChange={(event) => setIpset(event.target.value, reference.not)}>
            <option value="">{t('uci.rules.noSet')}</option>
            {setOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {reference.name !== '' && (
            <label className={editor.check}>
              <input type="checkbox" checked={reference.not} onChange={(event) => setIpset(reference.name, event.target.checked)} />
              {t('uci.rules.notInSet')}
            </label>
          )}
        </span>
      </Field>
      {reference.name !== '' && form.protocols.length === 0 && <p className={editor.note}>{t('uci.rules.setProtocolHint')}</p>}

      <h3 className={styles.section}>{t('uci.rules.action')}</h3>
      <Field label={t('uci.rules.action')}>
        <select className="select" value={form.target} onChange={(event) => edit('target', { target: event.target.value })}>
          {form.target === '' && <option value="">{t('uci.rules.defaultTarget')}</option>}
          {targets.map((target) => (
            <option key={target} value={target}>
              {target}
            </option>
          ))}
        </select>
      </Field>
    </FormDialog>
  );
}
