import { emptyRule, renderRule, type Family, type InterfaceMatch, type Match, type RuleAction, type RuleForm } from '@nftm/core';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Tabs } from '../components/Tabs.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/locales.ts';
import { NftCode } from '../ruleset/NftCode.tsx';
import styles from './Editor.module.css';

export type RuleEdit = { form: RuleForm; text: string } | { text: string };

interface RuleDialogProps {
  /** undefined: closed; 'new': a new rule; otherwise the rule being edited. */
  rule: RuleEdit | 'new' | undefined;
  family: Family;
  chain: string;
  /** Other chains of the table, for jump and goto. */
  chains: readonly string[];
  /** Named counters of the table. */
  counters: readonly string[];
  onSave(rule: RuleEdit): void;
  onClose(): void;
}

const PROTOCOLS = ['tcp', 'udp', 'icmp', 'icmpv6', 'sctp', 'udplite', 'dccp', 'gre', 'esp', 'ah'];
const PORT_PROTOCOLS = new Set(['tcp', 'udp', 'udplite', 'sctp', 'dccp']);
const CT_STATES = ['new', 'established', 'related', 'invalid', 'untracked'];
const ICMP_TYPES = ['echo-request', 'echo-reply', 'destination-unreachable', 'time-exceeded', 'parameter-problem', 'nd-neighbor-solicit', 'nd-neighbor-advert', 'nd-router-solicit', 'nd-router-advert'];
const LIMIT_UNITS = ['second', 'minute', 'hour', 'day', 'week'];
const LOG_LEVELS = ['emerg', 'alert', 'crit', 'err', 'warn', 'notice', 'info', 'debug'];
const REJECT_WITH = ['tcp reset', 'icmpx port-unreachable', 'icmpx admin-prohibited', 'icmp port-unreachable', 'icmp host-unreachable', 'icmpv6 admin-prohibited'];
const ACTIONS: RuleAction['kind'][] = ['accept', 'drop', 'reject', 'jump', 'goto', 'return', 'continue', 'masquerade', 'snat', 'dnat', 'redirect', 'none'];

/** Why the form cannot be saved yet; nft on the host checks everything else. */
function problems(form: RuleForm): MessageKey[] {
  const found: MessageKey[] = [];
  const hasPorts = form.srcPort !== undefined || form.dstPort !== undefined;
  if (hasPorts && !PORT_PROTOCOLS.has(form.protocol ?? '')) found.push('rule.problem.portProtocol');
  if (form.icmpType !== undefined && form.protocol !== 'icmp' && form.protocol !== 'icmpv6') found.push('rule.problem.icmpProtocol');
  const { action } = form;
  if ((action.kind === 'jump' || action.kind === 'goto') && action.target === '') found.push('rule.problem.target');
  if ((action.kind === 'snat' || action.kind === 'dnat') && action.to === '') found.push('rule.problem.natTo');
  if (action.kind === 'redirect' && action.port === '') found.push('rule.problem.redirect');
  if (form.limit !== undefined && !(form.limit.rate > 0)) found.push('rule.problem.limit');
  const strings = [form.comment, form.log?.prefix, form.inInterface?.value, form.outInterface?.value];
  if (strings.some((text) => text?.includes('"'))) found.push('rule.problem.quote');
  return found;
}

/** Edits one rule, MikroTik style: tabs of fields and a live preview of the nft line. */
export function RuleDialog({ rule, family, chain, chains, counters, onSave, onClose }: RuleDialogProps) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState<RuleForm>(emptyRule);
  const [text, setText] = useState<string | undefined>();
  const [tab, setTab] = useState('general');

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (rule !== undefined && !element.open) {
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
  const rendered = renderRule(form, family);
  const found = text === undefined ? problems(form) : text.trim() === '' || text.includes('\n') ? (['rule.problem.text'] as MessageKey[]) : [];

  function save() {
    if (found.length > 0) return;
    onSave(text === undefined ? { form, text: rendered } : { text: text.trim() });
  }

  const general = (
    <div className={styles.fields}>
      <Field label={t('rule.protocol')}>
        <input className="input" list="rule-protocols" value={form.protocol ?? ''} placeholder={t('rule.any')}
          onChange={(event) => update({ protocol: event.target.value.trim() || undefined })} />
        <datalist id="rule-protocols">{PROTOCOLS.map((name) => <option key={name} value={name} />)}</datalist>
      </Field>
      {family === 'inet' && (
        <Field label={t('rule.ipVersion')}>
          <select className="select" value={form.ipVersion ?? 'ip'} onChange={(event) => update({ ipVersion: event.target.value as 'ip' | 'ip6' })}>
            <option value="ip">IPv4</option>
            <option value="ip6">IPv6</option>
          </select>
        </Field>
      )}
      <MatchField label={t('rule.srcAddress')} match={form.srcAddress} placeholder="10.0.0.0/24, @set" onChange={(srcAddress) => update({ srcAddress })} />
      <MatchField label={t('rule.dstAddress')} match={form.dstAddress} placeholder="192.168.1.10" onChange={(dstAddress) => update({ dstAddress })} />
      <MatchField label={t('rule.srcPort')} match={form.srcPort} placeholder="1024-65535" onChange={(srcPort) => update({ srcPort })} />
      <MatchField label={t('rule.dstPort')} match={form.dstPort} placeholder="22, { 80, 443 }" onChange={(dstPort) => update({ dstPort })} />
      <InterfaceField label={t('rule.inInterface')} match={form.inInterface} onChange={(inInterface) => update({ inInterface })} />
      <InterfaceField label={t('rule.outInterface')} match={form.outInterface} onChange={(outInterface) => update({ outInterface })} />
      <Field label={t('rule.ctState')} group>
        <div className={styles.checks}>
          {CT_STATES.map((state) => (
            <label key={state} className={styles.check}>
              <input type="checkbox" checked={form.ctState?.includes(state) ?? false}
                onChange={(event) => {
                  const next = (form.ctState ?? []).filter((item) => item !== state);
                  if (event.target.checked) next.push(state);
                  update({ ctState: next.length > 0 ? next : undefined });
                }} />
              {state}
            </label>
          ))}
        </div>
      </Field>
    </div>
  );

  const advanced = (
    <div className={styles.fields}>
      <Field label={t('rule.icmpType')}>
        <input className="input" list="rule-icmp" value={form.icmpType ?? ''} onChange={(event) => update({ icmpType: event.target.value.trim() || undefined })} />
        <datalist id="rule-icmp">{ICMP_TYPES.map((name) => <option key={name} value={name} />)}</datalist>
      </Field>
      <Field label={t('rule.limit')} group>
        <div className={styles.inline}>
          <input className="input" type="number" min={1} value={form.limit?.rate ?? ''} placeholder={t('rule.none')} aria-label={t('rule.limit')}
            onChange={(event) => update({ limit: event.target.value === '' ? undefined : { per: 'second', ...form.limit, rate: Number(event.target.value) } })} />
          <span>/</span>
          <select className="select" value={form.limit?.per ?? 'second'} disabled={form.limit === undefined} aria-label={t('rule.limitPer')}
            onChange={(event) => form.limit && update({ limit: { ...form.limit, per: event.target.value } })}>
            {LIMIT_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
          </select>
          <input className="input" type="number" min={1} value={form.limit?.burst ?? ''} placeholder="burst" aria-label="burst" disabled={form.limit === undefined}
            onChange={(event) => {
              if (form.limit === undefined) return;
              const { burst: _burst, ...rest } = form.limit;
              update({ limit: event.target.value === '' ? rest : { ...rest, burst: Number(event.target.value) } });
            }} />
        </div>
      </Field>
      <Field label={t('rule.counter')}>
        <div className={styles.inline}>
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
        </div>
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
        </div>
      </Field>
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
              : kind === 'reject' ? { kind }
              : { kind };
            update({ action: next });
          }}>
          {ACTIONS.map((kind) => <option key={kind} value={kind}>{kind === 'none' ? t('rule.actionNone') : kind}</option>)}
        </select>
      </Field>
      {action.kind === 'reject' && (
        <Field label={t('rule.rejectWith')}>
          <input className="input" list="rule-reject" value={action.with ?? ''} placeholder={t('rule.rejectDefault')}
            onChange={(event) => update({ action: event.target.value.trim() === '' ? { kind: 'reject' } : { kind: 'reject', with: event.target.value } })} />
          <datalist id="rule-reject">{REJECT_WITH.map((name) => <option key={name} value={name} />)}</datalist>
        </Field>
      )}
      {(action.kind === 'jump' || action.kind === 'goto') && (
        <Field label={t('rule.target')}>
          <select className="select" value={action.target} onChange={(event) => update({ action: { kind: action.kind, target: event.target.value } })}>
            {chains.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </Field>
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
    <dialog ref={dialog} className={styles.dialog} onClose={onClose} aria-labelledby="rule-title">
      <div className={styles.dialogBody}>
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
              { id: 'advanced', label: t('rule.tab.advanced'), content: advanced },
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

/** A labelled row; `group` for several controls, which cannot share one <label>. */
function Field({ label, group = false, children }: { label: string; group?: boolean; children: ReactNode }) {
  const id = useId();
  if (group) {
    return (
      <div className={styles.field} role="group" aria-labelledby={id}>
        <span id={id} className={styles.fieldLabel}>{label}</span>
        <span className={styles.fieldControl}>{children}</span>
      </div>
    );
  }
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.fieldControl}>{children}</span>
    </label>
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
        <input className="input mono" value={match?.value ?? ''} placeholder="eth0, wg*" aria-label={label}
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
