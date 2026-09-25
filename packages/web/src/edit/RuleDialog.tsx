import {
  emptyRule,
  renderRule,
  TCP_FLAGS,
  type Family,
  type InterfaceMatch,
  type Limit,
  type Match,
  type Operator,
  type RuleAction,
  type RuleForm,
  type TcpFlags,
} from '@nftm/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Segmented } from '../components/Segmented.tsx';
import { Tabs } from '../components/Tabs.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/locales.ts';
import { NftCode } from '../ruleset/NftCode.tsx';
import styles from './Editor.module.css';
import { Choice, Field } from './fields.tsx';

export type RuleEdit = { form: RuleForm; text: string } | { text: string };

/** A named set or map of the table, for vmap and per-source limits. */
export interface SetInfo {
  kind: 'set' | 'map';
  name: string;
  declaration: readonly string[];
}

interface RuleDialogProps {
  /** undefined: closed; 'new': a new rule; otherwise the rule being edited. */
  rule: RuleEdit | 'new' | undefined;
  family: Family;
  chain: string;
  /** Other chains of the table, for jump and goto. */
  chains: readonly string[];
  /** Named counters of the table. */
  counters: readonly string[];
  sets: readonly SetInfo[];
  onSave(rule: RuleEdit): void;
  onClose(): void;
}

const PROTOCOLS = ['tcp', 'udp', 'icmp', 'icmpv6', 'sctp', 'udplite', 'dccp', 'gre', 'esp', 'ah'];
const PORT_PROTOCOLS = new Set(['tcp', 'udp', 'udplite', 'sctp', 'dccp']);
const CT_STATES = ['new', 'established', 'related', 'invalid', 'untracked'];
const ICMP_TYPES = ['echo-request', 'echo-reply', 'destination-unreachable', 'time-exceeded', 'parameter-problem', 'redirect', 'router-advertisement', 'router-solicitation'];
const ICMPV6_TYPES = ['echo-request', 'echo-reply', 'destination-unreachable', 'packet-too-big', 'time-exceeded', 'parameter-problem', 'nd-router-solicit', 'nd-router-advert', 'nd-neighbor-solicit', 'nd-neighbor-advert', 'mld-listener-query', 'mld-listener-report'];
/** Reject types per family, without the one plain `reject` means. */
const REJECT_WITH: Partial<Record<Family, string[]>> = {
  ip: ['tcp reset', 'icmp host-unreachable', 'icmp net-unreachable', 'icmp admin-prohibited'],
  ip6: ['tcp reset', 'icmpv6 admin-prohibited', 'icmpv6 no-route', 'icmpv6 addr-unreachable'],
  inet: ['tcp reset', 'icmpx admin-prohibited', 'icmpx host-unreachable', 'icmpx no-route'],
  bridge: ['tcp reset', 'icmpx admin-prohibited', 'icmpx host-unreachable', 'icmpx no-route'],
};
const PERIODS = ['second', 'minute', 'hour', 'day', 'week'];
const BYTE_UNITS = ['bytes', 'kbytes', 'mbytes'];
const LOG_LEVELS = ['emerg', 'alert', 'crit', 'err', 'warn', 'notice', 'info', 'debug'];
const OPERATORS: Operator[] = ['==', '!=', '<', '>', '<=', '>='];
const PACKET_TYPES = ['unicast', 'broadcast', 'multicast', 'other'];
const KEYS = ['ip saddr', 'ip6 saddr', 'ip daddr', 'ip6 daddr', 'ip saddr . tcp dport', 'iifname'];
const VMAP_KEYS = ['tcp dport', 'udp dport', 'ip saddr', 'ip daddr', 'ip6 saddr', 'iifname', 'oifname', 'meta l4proto'];
const TIMEOUTS = ['1m', '10m', '1h', '1d'];
const ACTIONS: RuleAction['kind'][] = ['accept', 'drop', 'reject', 'jump', 'goto', 'return', 'continue', 'vmap', 'masquerade', 'snat', 'dnat', 'redirect', 'none'];
const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Why the form cannot be saved yet; nft on the host checks everything else. */
function problems(form: RuleForm): MessageKey[] {
  const found: MessageKey[] = [];
  const hasPorts = form.srcPort !== undefined || form.dstPort !== undefined;
  if (hasPorts && !PORT_PROTOCOLS.has(form.protocol ?? '')) found.push('rule.problem.portProtocol');
  if (form.icmpType !== undefined && form.protocol !== 'icmp' && form.protocol !== 'icmpv6') found.push('rule.problem.icmpProtocol');
  if (form.tcpFlags !== undefined && form.protocol !== undefined && form.protocol !== 'tcp') found.push('rule.problem.tcpProtocol');
  const { action } = form;
  if ((action.kind === 'jump' || action.kind === 'goto') && action.target === '') found.push('rule.problem.target');
  if ((action.kind === 'snat' || action.kind === 'dnat') && action.to === '') found.push('rule.problem.natTo');
  if (action.kind === 'redirect' && action.port === '') found.push('rule.problem.redirect');
  if (action.kind === 'vmap' && (action.key.trim() === '' || action.map.trim() === '')) found.push('rule.problem.vmap');
  if (form.limit !== undefined && !(form.limit.rate > 0)) found.push('rule.problem.limit');
  if (form.keyedLimit !== undefined) {
    const { key, set, limit } = form.keyedLimit;
    if (!(limit.rate > 0) || key.trim() === '' || !NAME.test(set)) found.push('rule.problem.keyedLimit');
  }
  if (form.connLimit !== undefined && !(Number.isInteger(form.connLimit.count) && form.connLimit.count >= 0)) found.push('rule.problem.connLimit');
  if (form.quota !== undefined && !(form.quota.amount > 0)) found.push('rule.problem.quota');
  if (form.length !== undefined && form.length.value.trim() === '') found.push('rule.problem.length');
  if ((form.mark !== undefined && form.mark.value.trim() === '') || (form.markSet !== undefined && form.markSet.value.trim() === '')) found.push('rule.problem.mark');
  if (form.log?.group !== undefined && !(Number.isInteger(form.log.group) && form.log.group >= 0 && form.log.group <= 65535)) found.push('rule.problem.logGroup');
  if ([form.comment, form.log?.prefix].some((text) => text?.includes('"'))) found.push('rule.problem.quote');
  return found;
}

/** Values typed in the free-text choices, without stray spaces; empty ones dropped. */
function tidy(form: RuleForm): RuleForm {
  const { protocol: rawProtocol, icmpType: rawIcmpType, action, ...rest } = form;
  const clean = (text: string | undefined) => (text?.trim() ? text.trim() : undefined);
  const protocol = clean(rawProtocol);
  const icmpType = clean(rawIcmpType);
  const rejectWith = action.kind === 'reject' ? clean(action.with) : undefined;
  return {
    ...rest,
    ...(protocol !== undefined ? { protocol } : {}),
    ...(icmpType !== undefined ? { icmpType } : {}),
    action: action.kind !== 'reject' ? action : rejectWith === undefined ? { kind: 'reject' } : { kind: 'reject', with: rejectWith },
  };
}

/** Edits one rule: tabs of fields and a live preview of the nft line. */
export function RuleDialog({ rule, family, chain, chains, counters, sets, onSave, onClose }: RuleDialogProps) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState<RuleForm>(emptyRule);
  const [text, setText] = useState<string | undefined>();
  const [tab, setTab] = useState('general');
  // Each opening starts the fields afresh, including their local state.
  const [opening, setOpening] = useState(0);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (rule !== undefined && !element.open) {
      setOpening((count) => count + 1);
      setTab('general');
      if (rule === 'new') {
        setForm(emptyRule());
        setText(undefined);
      } else if ('form' in rule) {
        setForm(rule.form);
        setText(undefined);
      } else {
        setText(rule.text);
      }
      element.showModal();
    } else if (rule === undefined && element.open) {
      element.close();
    }
  }, [rule]);

  const update = (patch: Partial<RuleForm>) => setForm((current) => ({ ...current, ...patch }));
  // Ports and TCP flags need a protocol; tcp is what they usually mean, and the field shows it.
  const withTcp = (patch: Partial<RuleForm>, present: boolean) => update({ ...patch, ...(present && form.protocol === undefined && { protocol: 'tcp' }) });
  const setPort = (part: 'srcPort' | 'dstPort', match: Match | undefined) => withTcp({ [part]: match }, match !== undefined);
  const icmpv6 = form.protocol === 'icmpv6' || (form.protocol !== 'icmp' && family === 'ip6');
  const protocols = PROTOCOLS.filter((name) => !(family === 'ip' && name === 'icmpv6') && !(family === 'ip6' && name === 'icmp'));
  const verdictMaps = sets.filter((set) => set.kind === 'map' && set.declaration.some((line) => /^type .* : verdict$/.test(line))).map((set) => `@${set.name}`);
  const dynamicSets = sets.filter((set) => set.kind === 'set' && set.declaration.some((line) => /^flags .*\bdynamic\b/.test(line))).map((set) => set.name);
  const rendered = renderRule(tidy(form), family);
  const found = text === undefined ? problems(form) : text.trim() === '' || text.includes('\n') ? (['rule.problem.text'] as MessageKey[]) : [];

  function save() {
    if (found.length > 0) return;
    onSave(text === undefined ? { form: tidy(form), text: rendered } : { text: text.trim() });
  }

  const general = (
    <div className={styles.fields}>
      <p className={styles.note}>{t('rule.valuesHint')}</p>
      <Field label={t('rule.protocol')} group>
        <Choice label={t('rule.protocol')} value={form.protocol} options={protocols} empty={t('rule.any')} onChange={(protocol) => update({ protocol })} />
      </Field>
      {family === 'inet' && (
        <Field label={t('rule.ipVersion')}>
          <select className="select" value={form.ipVersion ?? 'ip'} onChange={(event) => update({ ipVersion: event.target.value as 'ip' | 'ip6' })}>
            <option value="ip">IPv4</option>
            <option value="ip6">IPv6</option>
          </select>
        </Field>
      )}
      <MatchField label={t('rule.srcAddress')} match={form.srcAddress} placeholder="10.0.0.0/24, 192.168.1.10" onChange={(srcAddress) => update({ srcAddress })} />
      <MatchField label={t('rule.dstAddress')} match={form.dstAddress} placeholder="192.168.1.10" onChange={(dstAddress) => update({ dstAddress })} />
      <MatchField label={t('rule.srcPort')} match={form.srcPort} placeholder="1024-65535" onChange={(match) => setPort('srcPort', match)} />
      <MatchField label={t('rule.dstPort')} match={form.dstPort} placeholder="80, 443" onChange={(match) => setPort('dstPort', match)} />
      <InterfaceField label={t('rule.inInterface')} match={form.inInterface} onChange={(inInterface) => update({ inInterface })} />
      <InterfaceField label={t('rule.outInterface')} match={form.outInterface} onChange={(outInterface) => update({ outInterface })} />
      <Field label={t('rule.ctState')} group>
        <Checks
          options={CT_STATES}
          value={form.ctState ?? []}
          onChange={(ctState) => update({ ctState: ctState.length > 0 ? ctState : undefined })}
        />
      </Field>
    </div>
  );

  const packet = (
    <div className={styles.fields}>
      <Field label={t('rule.tcpFlags')} group>
        <TcpFlagsField flags={form.tcpFlags} onChange={(tcpFlags) => withTcp({ tcpFlags }, tcpFlags !== undefined)} />
      </Field>
      <Field label={t('rule.icmpType')} group>
        <Choice
          label={t('rule.icmpType')}
          value={form.icmpType}
          options={icmpv6 ? ICMPV6_TYPES : ICMP_TYPES}
          empty={t('rule.any')}
          onChange={(icmpType) =>
            update({ icmpType, ...(icmpType !== undefined && form.protocol === undefined && { protocol: icmpv6 ? 'icmpv6' : 'icmp' }) })
          }
        />
      </Field>
      <Field label={t('rule.length')} group>
        <span className={styles.inline}>
          <OperatorSelect label={t('rule.length')} value={form.length?.op ?? '=='} onChange={(op) => update({ length: { op, value: form.length?.value ?? '' } })} />
          <input className="input mono" value={form.length?.value ?? ''} placeholder="1000, 0-100" aria-label={t('rule.length')}
            onChange={(event) => update({ length: event.target.value === '' ? undefined : { op: form.length?.op ?? '==', value: event.target.value } })} />
          <span className={styles.unit}>{t('rule.bytes')}</span>
        </span>
      </Field>
      <Field label={t('rule.pktType')} group>
        <span className={styles.inline}>
          <label className={styles.check} title={t('rule.negateTitle')}>
            <input type="checkbox" checked={form.pktType?.negate ?? false} disabled={form.pktType === undefined}
              onChange={(event) => form.pktType && update({ pktType: { ...form.pktType, negate: event.target.checked } })} />
            !
          </label>
          <Checks
            options={PACKET_TYPES}
            value={form.pktType?.value.split(',').map((item) => item.trim()).filter(Boolean) ?? []}
            onChange={(types) => update({ pktType: types.length === 0 ? undefined : { negate: form.pktType?.negate ?? false, value: types.join(', ') } })}
          />
        </span>
      </Field>
      <Field label={t('rule.mark')} group>
        <span className={styles.inline}>
          <select className="select select-compact" value={form.mark?.source ?? 'meta'} aria-label={t('rule.markSource')}
            onChange={(event) => form.mark && update({ mark: { ...form.mark, source: event.target.value as 'meta' | 'ct' } })}>
            <option value="meta">{t('rule.markPacket')}</option>
            <option value="ct">{t('rule.markConnection')}</option>
          </select>
          <OperatorSelect label={t('rule.mark')} value={form.mark?.op ?? '=='} onChange={(op) => form.mark && update({ mark: { ...form.mark, op } })} />
          <input className="input mono" value={form.mark?.value ?? ''} placeholder="0x1" aria-label={t('rule.mark')}
            onChange={(event) =>
              update({ mark: event.target.value === '' ? undefined : { source: form.mark?.source ?? 'meta', op: form.mark?.op ?? '==', value: event.target.value } })
            } />
        </span>
      </Field>
      <Field label={t('rule.rpfilter')} group>
        <label className={styles.option}>
          <input type="checkbox" checked={form.rpfilter ?? false} onChange={(event) => update({ rpfilter: event.target.checked || undefined })} />
          {t('rule.rpfilterOn')}
        </label>
      </Field>
      <p className={styles.note}>{t('rule.rpfilterHint')}</p>
    </div>
  );

  const limits = (
    <div className={styles.fields}>
      <Section title={t('rule.limit')} enabled={form.limit !== undefined} onToggle={(on) => update({ limit: on ? { rate: 10, per: 'second' } : undefined })}>
        <LimitFields limit={form.limit!} onChange={(limit) => update({ limit })} />
        <p className={styles.note}>{t('rule.limitHint')}</p>
      </Section>
      <Section
        title={t('rule.keyedLimit')}
        enabled={form.keyedLimit !== undefined}
        onToggle={(on) =>
          update({ keyedLimit: on ? { verb: 'meter', set: `${chain}_limit`.replace(/[^A-Za-z0-9_-]/g, '_'), key: family === 'ip6' ? 'ip6 saddr' : 'ip saddr', limit: { rate: 10, per: 'minute', over: true } } : undefined })
        }
      >
        {form.keyedLimit !== undefined && (
          <>
            <Field label={t('rule.keyedLimitKey')} group>
              <Choice label={t('rule.keyedLimitKey')} value={form.keyedLimit.key} options={KEYS} onChange={(key) => update({ keyedLimit: { ...form.keyedLimit!, key: key ?? '' } })} />
            </Field>
            <LimitFields limit={form.keyedLimit.limit} onChange={(limit) => update({ keyedLimit: { ...form.keyedLimit!, limit } })} />
            <Field label={t('rule.keyedLimitTimeout')} group>
              <Choice label={t('rule.keyedLimitTimeout')} value={form.keyedLimit.timeout} options={TIMEOUTS} empty={t('elements.timeoutNone')}
                onChange={(timeout) => {
                  const { timeout: _old, ...rest } = form.keyedLimit!;
                  update({ keyedLimit: timeout === undefined ? rest : { ...rest, timeout } });
                }} />
            </Field>
            <Field label={t('rule.keyedLimitSet')} group>
              <Choice label={t('rule.keyedLimitSet')} value={form.keyedLimit.set} options={dynamicSets}
                onChange={(set) => {
                  const name = set ?? '';
                  // An existing dynamic set is updated; nft creates a new one for `meter`.
                  const verb = dynamicSets.includes(name) ? (form.keyedLimit!.timeout !== undefined ? 'update' : 'add') : 'meter';
                  update({ keyedLimit: { ...form.keyedLimit!, set: name, verb } });
                }} />
            </Field>
            <p className={styles.note}>{t('rule.keyedLimitHint')}</p>
          </>
        )}
      </Section>
      <Section title={t('rule.connLimit')} enabled={form.connLimit !== undefined} onToggle={(on) => update({ connLimit: on ? { count: 10, over: true } : undefined })}>
        {form.connLimit !== undefined && (
          <Field label={t('rule.connLimitCount')} group>
            <span className={styles.inline}>
              <OverSelect over={form.connLimit.over} onChange={(over) => update({ connLimit: { ...form.connLimit!, over } })} />
              <input className="input" type="number" min={0} value={form.connLimit.count} aria-label={t('rule.connLimitCount')}
                onChange={(event) => update({ connLimit: { ...form.connLimit!, count: Number(event.target.value) } })} />
            </span>
          </Field>
        )}
        <p className={styles.note}>{t('rule.connLimitHint')}</p>
      </Section>
      <Section title={t('rule.quota')} enabled={form.quota !== undefined} onToggle={(on) => update({ quota: on ? { amount: 100, unit: 'mbytes', over: true } : undefined })}>
        {form.quota !== undefined && (
          <Field label={t('rule.quotaAmount')} group>
            <span className={styles.inline}>
              <OverSelect over={form.quota.over} onChange={(over) => update({ quota: { ...form.quota!, over } })} />
              <input className="input" type="number" min={1} value={form.quota.amount} aria-label={t('rule.quotaAmount')}
                onChange={(event) => update({ quota: { ...form.quota!, amount: Number(event.target.value) } })} />
              <select className="select select-compact" value={form.quota.unit} aria-label={t('rule.unit')}
                onChange={(event) => update({ quota: { ...form.quota!, unit: event.target.value } })}>
                {BYTE_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
              </select>
            </span>
          </Field>
        )}
        <p className={styles.note}>{t('rule.quotaHint')}</p>
      </Section>
    </div>
  );

  const { action } = form;
  const actionFields = (
    <div className={styles.fields}>
      <Field label={t('rule.action')}>
        <select className="select" value={action.kind}
          onChange={(event) => {
            const kind = event.target.value as RuleAction['kind'];
            const next: RuleAction =
              kind === 'jump' || kind === 'goto' ? { kind, target: chains[0] ?? '' }
              : kind === 'snat' || kind === 'dnat' ? { kind, to: '', ...(family === 'inet' && { family: 'ip' as const }) }
              : kind === 'redirect' ? { kind, port: '' }
              : kind === 'vmap' ? { kind, key: 'tcp dport', map: verdictMaps[0] ?? '' }
              : kind === 'reject' ? { kind }
              : { kind };
            update({ action: next });
          }}>
          {ACTIONS.map((kind) => <option key={kind} value={kind}>{kind === 'none' ? t('rule.actionNone') : kind === 'vmap' ? t('rule.actionVmap') : kind}</option>)}
        </select>
      </Field>
      {action.kind === 'reject' && (
        <Field label={t('rule.rejectWith')} group>
          <Choice
            label={t('rule.rejectWith')}
            value={action.with}
            options={REJECT_WITH[family] ?? []}
            empty={t('rule.rejectDefault')}
            onChange={(type) => update({ action: type === undefined ? { kind: 'reject' } : { kind: 'reject', with: type } })}
          />
        </Field>
      )}
      {(action.kind === 'jump' || action.kind === 'goto') && (
        <Field label={t('rule.target')}>
          <select className="select" value={action.target} onChange={(event) => update({ action: { kind: action.kind, target: event.target.value } })}>
            {chains.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </Field>
      )}
      {action.kind === 'vmap' && (
        <>
          <Field label={t('rule.vmapKey')} group>
            <Choice label={t('rule.vmapKey')} value={action.key} options={VMAP_KEYS} onChange={(key) => update({ action: { ...action, key: key ?? '' } })} />
          </Field>
          <Field label={t('rule.vmapMap')} group>
            <Choice label={t('rule.vmapMap')} value={action.map} options={verdictMaps} onChange={(map) => update({ action: { ...action, map: map ?? '' } })} />
          </Field>
          <p className={styles.note}>{t('rule.vmapHint')}</p>
        </>
      )}
      {(action.kind === 'snat' || action.kind === 'dnat') && (
        <>
          <Field label={t('rule.natTo')}>
            <input className="input mono" value={action.to} placeholder="10.0.0.2:8080" onChange={(event) => update({ action: { ...action, to: event.target.value } })} />
          </Field>
          {family === 'inet' && (
            <Field label={t('rule.ipVersion')}>
              <select className="select" value={action.family ?? 'ip'} onChange={(event) => update({ action: { ...action, family: event.target.value as 'ip' | 'ip6' } })}>
                <option value="ip">IPv4</option>
                <option value="ip6">IPv6</option>
              </select>
            </Field>
          )}
        </>
      )}
      {action.kind === 'redirect' && (
        <Field label={t('rule.redirectPort')}>
          <input className="input mono" value={action.port} placeholder="8080" onChange={(event) => update({ action: { kind: 'redirect', port: event.target.value.trim() } })} />
        </Field>
      )}
      <Field label={t('rule.counter')}>
        <select className="select" value={form.counterName !== undefined ? `name:${form.counterName}` : form.counter ? 'anonymous' : ''}
          onChange={(event) => {
            const value = event.target.value;
            const { counter: _counter, counterName: _name, ...rest } = form;
            setForm(value === '' ? rest : value === 'anonymous' ? { ...rest, counter: true } : { ...rest, counterName: value.slice(5) });
          }}>
          <option value="">{t('rule.none')}</option>
          <option value="anonymous">{t('rule.counterAnonymous')}</option>
          {counters.map((name) => <option key={name} value={`name:${name}`}>{t('rule.counterNamed', { name })}</option>)}
        </select>
      </Field>
      <Field label={t('rule.log')} group>
        <div className={styles.inline}>
          <label className={styles.check}>
            <input type="checkbox" checked={form.log !== undefined} onChange={(event) => update({ log: event.target.checked ? {} : undefined })} />
            {t('rule.logOn')}
          </label>
          <input className="input" value={form.log?.prefix ?? ''} placeholder={t('rule.logPrefix')} aria-label={t('rule.logPrefix')} disabled={form.log === undefined}
            onChange={(event) => {
              if (form.log === undefined) return;
              const { prefix: _prefix, ...rest } = form.log;
              update({ log: event.target.value === '' ? rest : { ...rest, prefix: event.target.value } });
            }} />
          <select className="select" value={form.log?.level ?? ''} disabled={form.log === undefined} aria-label={t('rule.logLevel')}
            onChange={(event) => {
              if (form.log === undefined) return;
              const { level: _level, ...rest } = form.log;
              update({ log: event.target.value === '' ? rest : { ...rest, level: event.target.value } });
            }}>
            <option value="">{t('rule.logLevelDefault')}</option>
            {LOG_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
          <input className="input" type="number" min={0} max={65535} value={form.log?.group ?? ''} placeholder={t('rule.logGroup')} aria-label={t('rule.logGroup')}
            title={t('rule.logGroupHint')} disabled={form.log === undefined}
            onChange={(event) => {
              if (form.log === undefined) return;
              const { group: _group, ...rest } = form.log;
              update({ log: event.target.value === '' ? rest : { ...rest, group: Number(event.target.value) } });
            }} />
        </div>
      </Field>
      <Field label={t('rule.markSet')} group>
        <span className={styles.inline}>
          <select className="select select-compact" value={form.markSet?.target ?? 'meta'} aria-label={t('rule.markSource')}
            onChange={(event) => form.markSet && update({ markSet: { ...form.markSet, target: event.target.value as 'meta' | 'ct' } })}>
            <option value="meta">{t('rule.markPacket')}</option>
            <option value="ct">{t('rule.markConnection')}</option>
          </select>
          <input className="input mono" value={form.markSet?.value ?? ''} placeholder="0x1" aria-label={t('rule.markSet')}
            onChange={(event) => update({ markSet: event.target.value === '' ? undefined : { target: form.markSet?.target ?? 'meta', value: event.target.value } })} />
        </span>
      </Field>
      <Field label="notrack" group>
        <label className={styles.option}>
          <input type="checkbox" checked={form.notrack ?? false} onChange={(event) => update({ notrack: event.target.checked || undefined })} />
          {t('rule.notrackOn')}
        </label>
      </Field>
    </div>
  );

  const comment = (
    <div className={styles.fields}>
      <Field label={t('rule.comment')}>
        <input className="input" value={form.comment ?? ''} maxLength={128} onChange={(event) => update({ comment: event.target.value || undefined })} />
      </Field>
    </div>
  );

  return (
    <dialog ref={dialog} className={`${styles.dialog} ${styles.wideDialog}`} onClose={onClose} aria-labelledby="rule-title">
      <div key={opening} className={styles.dialogBody}>
        <h2 id="rule-title" className={styles.dialogTitle}>
          {t(rule === 'new' ? 'rule.titleNew' : 'rule.titleEdit', { chain })}
        </h2>
        {text === undefined ? (
          <Tabs
            label={t('rule.tabs')}
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'general', label: t('rule.tab.general'), content: general },
              { id: 'packet', label: t('rule.tab.packet'), content: packet },
              { id: 'limits', label: t('rule.tab.limits'), content: limits },
              { id: 'action', label: t('rule.tab.action'), content: actionFields },
              { id: 'comment', label: t('rule.tab.comment'), content: comment },
            ]}
          />
        ) : (
          <div className={styles.fields}>
            {rule !== 'new' && rule !== undefined && !('form' in rule) && <p className={styles.note}>{t('rule.textOnly')}</p>}
            <Field label={t('rule.text')}>
              <input className="input mono" value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} />
            </Field>
          </div>
        )}
        <div className={styles.preview}>
          <span className={styles.previewLabel}>{t('rule.preview')}</span>
          <NftCode text={text ?? rendered} className={styles.previewCode} />
        </div>
        {found.length > 0 && (
          <ul className={styles.problems}>
            {found.map((key) => <li key={key}>{t(key)}</li>)}
          </ul>
        )}
      </div>
      <div className={styles.dialogFooter}>
        {text === undefined && (
          <button type="button" className="btn btn-ghost" onClick={() => setText(rendered)}>
            {t('rule.asText')}
          </button>
        )}
        <span className={styles.spacer} />
        <button type="button" className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={found.length > 0}>
          {t('rule.ok')}
        </button>
      </div>
    </dialog>
  );
}

/** A group of fields that is either off or filled in. */
function Section({ title, enabled, onToggle, children }: { title: string; enabled: boolean; onToggle(on: boolean): void; children: ReactNode }) {
  return (
    <fieldset className={enabled ? styles.section : styles.sectionOff}>
      <legend>
        <label className={styles.option}>
          <input type="checkbox" checked={enabled} onChange={(event) => onToggle(event.target.checked)} />
          {title}
        </label>
      </legend>
      {enabled && <div className={styles.sectionBody}>{children}</div>}
    </fieldset>
  );
}

/** Rate, unit, period and burst of a limit, and whether it matches what is within or over it. */
function LimitFields({ limit, onChange }: { limit: Limit; onChange(limit: Limit): void }) {
  const { t } = useI18n();
  const bytes = limit.unit !== undefined;
  return (
    <>
      <Field label={t('rule.limitRate')} group>
        <span className={styles.inline}>
          <OverSelect over={limit.over ?? false} onChange={(over) => {
            const { over: _over, ...rest } = limit;
            onChange(over ? { ...rest, over } : rest);
          }} />
          <input className="input" type="number" min={1} value={limit.rate} aria-label={t('rule.limitRate')}
            onChange={(event) => onChange({ ...limit, rate: Number(event.target.value) })} />
          <select className="select select-compact" value={limit.unit ?? 'packets'} aria-label={t('rule.unit')}
            onChange={(event) => {
              const { unit: _unit, burstUnit: _burstUnit, ...rest } = limit;
              onChange(event.target.value === 'packets' ? rest : { ...rest, unit: event.target.value });
            }}>
            <option value="packets">{t('rule.packets')}</option>
            {BYTE_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
          </select>
          <span>/</span>
          <select className="select select-compact" value={limit.per} aria-label={t('rule.limitPer')} onChange={(event) => onChange({ ...limit, per: event.target.value })}>
            {PERIODS.map((period) => <option key={period} value={period}>{period}</option>)}
          </select>
        </span>
      </Field>
      <Field label={t('rule.limitBurst')} group>
        <span className={styles.inline}>
          <input className="input" type="number" min={1} value={limit.burst ?? ''} placeholder={t('rule.limitBurstDefault')} aria-label={t('rule.limitBurst')}
            onChange={(event) => {
              const { burst: _burst, burstUnit: _burstUnit, ...rest } = limit;
              onChange(event.target.value === '' ? rest : { ...rest, burst: Number(event.target.value), ...(bytes && { burstUnit: limit.burstUnit ?? 'bytes' }) });
            }} />
          <span className={styles.unit}>{bytes ? '' : t('rule.packets')}</span>
          {bytes && limit.burst !== undefined && (
            <select className="select select-compact" value={limit.burstUnit ?? 'bytes'} aria-label={t('rule.unit')}
              onChange={(event) => onChange({ ...limit, burstUnit: event.target.value })}>
              {BYTE_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
            </select>
          )}
        </span>
      </Field>
    </>
  );
}

function OverSelect({ over, onChange }: { over: boolean; onChange(over: boolean): void }) {
  const { t } = useI18n();
  return (
    <select className="select select-compact" value={over ? 'over' : 'within'} aria-label={t('rule.overLabel')} onChange={(event) => onChange(event.target.value === 'over')}>
      <option value="within">{t('rule.within')}</option>
      <option value="over">{t('rule.over')}</option>
    </select>
  );
}

function OperatorSelect({ label, value, onChange }: { label: string; value: Operator; onChange(op: Operator): void }) {
  return (
    <select className="select select-compact mono" value={value} aria-label={label} onChange={(event) => onChange(event.target.value as Operator)}>
      {OPERATORS.map((op) => <option key={op} value={op}>{op}</option>)}
    </select>
  );
}

function Checks({ options, value, onChange }: { options: readonly string[]; value: readonly string[]; onChange(value: string[]): void }) {
  return (
    <span className={styles.checks}>
      {options.map((option) => (
        <label key={option} className={styles.check}>
          <input type="checkbox" checked={value.includes(option)}
            onChange={(event) => onChange(event.target.checked ? [...value, option] : value.filter((item) => item !== option))} />
          {option}
        </label>
      ))}
    </span>
  );
}

/** Each flag: any, set or clear; a click moves it along. */
function TcpFlagsField({ flags, onChange }: { flags: TcpFlags | undefined; onChange(flags: TcpFlags | undefined): void }) {
  const { t } = useI18n();
  const set = flags?.set ?? [];
  const unset = flags?.unset ?? [];
  const any = flags?.any ?? false;
  const emit = (next: TcpFlags) => onChange(next.set.length + next.unset.length === 0 ? undefined : next);
  const cycle = (flag: string) => {
    if (set.includes(flag)) {
      const without = set.filter((item) => item !== flag);
      emit(any ? { set: without, unset: [], any } : { set: without, unset: [...unset, flag] });
    } else if (unset.includes(flag)) {
      emit({ set, unset: unset.filter((item) => item !== flag), ...(any && { any }) });
    } else {
      emit({ set: [...set, flag], unset, ...(any && { any }) });
    }
  };
  const state = (flag: string) => (set.includes(flag) ? 'set' : unset.includes(flag) ? 'unset' : 'any');
  return (
    <span className={styles.flagsField}>
      <span className={styles.flags}>
        {TCP_FLAGS.map((flag) => (
          <button key={flag} type="button" className={`${styles.flag} ${styles[`flag-${state(flag)}`]}`}
            aria-label={`${flag}: ${t(`rule.flag.${state(flag)}`)}`} title={t(`rule.flag.${state(flag)}`)} onClick={() => cycle(flag)}>
            {state(flag) === 'unset' ? `!${flag}` : flag}
          </button>
        ))}
      </span>
      <span className={styles.inline}>
        <label className={styles.option}>
          <input type="checkbox" checked={any} disabled={set.length === 0}
            onChange={(event) => emit(event.target.checked ? { set, unset: [], any: true } : { set, unset })} />
          {t('rule.flagsAny')}
        </label>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => emit({ set: ['syn'], unset: ['fin', 'rst', 'ack'] })}>
          {t('rule.flagsNewConnection')}
        </button>
      </span>
      <span className={styles.note}>{t('rule.flagsHint')}</span>
    </span>
  );
}

function MatchField({ label, match, placeholder, onChange }: { label: string; match: Match | undefined; placeholder: string; onChange(match: Match | undefined): void }) {
  const { t } = useI18n();
  return (
    <Field label={label} group>
      <span className={styles.inline}>
        <label className={styles.check} title={t('rule.negateTitle')}>
          <input type="checkbox" checked={match?.negate ?? false} disabled={match === undefined}
            onChange={(event) => match && onChange({ ...match, negate: event.target.checked })} />
          !
        </label>
        <input className="input mono" value={match?.value ?? ''} placeholder={placeholder} aria-label={label}
          onChange={(event) => onChange(event.target.value.trim() === '' ? undefined : { negate: match?.negate ?? false, value: event.target.value })} />
      </span>
    </Field>
  );
}

function InterfaceField({ label, match, onChange }: { label: string; match: InterfaceMatch | undefined; onChange(match: InterfaceMatch | undefined): void }) {
  const { t } = useI18n();
  return (
    <Field label={label} group>
      <span className={styles.inline}>
        <label className={styles.check} title={t('rule.negateTitle')}>
          <input type="checkbox" checked={match?.negate ?? false} disabled={match === undefined}
            onChange={(event) => match && onChange({ ...match, negate: event.target.checked })} />
          !
        </label>
        <input className="input mono" value={match?.value ?? ''} placeholder="eth0, wg0" aria-label={label}
          onChange={(event) => onChange(event.target.value.trim() === '' ? undefined : { negate: match?.negate ?? false, byIndex: match?.byIndex ?? false, value: event.target.value.trim() })} />
        <label className={styles.check} title={t('rule.byIndexTitle')}>
          <input type="checkbox" checked={match?.byIndex ?? false} disabled={match === undefined}
            onChange={(event) => match && onChange({ ...match, byIndex: event.target.checked })} />
          {t('rule.byIndex')}
        </label>
      </span>
    </Field>
  );
}
