// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import {
  forwardRules,
  inNetwork,
  ipVersion,
  isIpAddress,
  natTables,
  networkOf,
  planPortForward,
  portForwardProblems,
  type HostKind,
  type HostNetwork,
  type HostRoute,
  type NatTable,
  type ForwardField,
  type ForwardProblem,
  type PortForward,
  type TableChange,
} from '@hopdeck/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.ts';
import { Callout } from '../../components/Callout.tsx';
import { AlertIcon, InfoIcon } from '../../components/icons.tsx';
import { Segmented } from '../../components/Segmented.tsx';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import type { MessageKey } from '../../i18n/locales.ts';
import { Field } from '../edit/fields.tsx';
import editor from '../edit/Editor.module.css';
import type { RulesetModel } from '../ruleset/model.ts';
import { NftCode } from '../ruleset/NftCode.tsx';
import { ForwardingNotice } from './ForwardingNotice.tsx';
import styles from './Forward.module.css';

interface ForwardDialogProps {
  open: boolean;
  hostId: string;
  hostKind: HostKind;
  model: RulesetModel;
  network: HostNetwork | undefined;
  onNetwork(network: HostNetwork): void;
  /** The forward being changed; undefined for a new one. */
  editing?: PortForward | undefined;
  /** Names taken by other forwards. */
  taken: readonly string[];
  onReview(changes: TableChange[]): void;
  onClose(): void;
}

type Protocol = 'tcp' | 'udp' | 'both';

/** Interface names that are tunnels, behind which a target's answers may not come back this way. */
const TUNNEL = /^(wg|tun|tap|ppp|ipsec|vti|gre|ip6tnl|sit|zt|tailscale)/;

const list = (text: string) =>
  text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/** A problem of the forward, in the viewer's language. */
function problemText(t: ReturnType<typeof useI18n>['t'], problem: ForwardProblem): string {
  return t(`forward.problem.${problem.code}` as MessageKey, { value: problem.value ?? '', version: problem.version ?? '' });
}

/**
 * The port forward wizard: what comes in where, where it goes, and how; it
 * shows the rules it writes in each table, and what it cannot change. The
 * changes then go through the usual review, apply and confirmation.
 */
export function ForwardDialog({ open, hostId, hostKind, model, network, onNetwork, editing, taken, onReview, onClose }: ForwardDialogProps) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [opening, setOpening] = useState(0);
  const [name, setName] = useState('');
  const [protocol, setProtocol] = useState<Protocol>('tcp');
  const [ports, setPorts] = useState('');
  const [inInterfaces, setInInterfaces] = useState<string[]>([]);
  const [otherIn, setOtherIn] = useState('');
  const [externalAddress, setExternalAddress] = useState('');
  const [target, setTarget] = useState('');
  const [targetPort, setTargetPort] = useState('');
  const [outInterfaces, setOutInterfaces] = useState<string[]>([]);
  const [outTouched, setOutTouched] = useState(false);
  const [sources, setSources] = useState('');
  const [masquerade, setMasquerade] = useState(false);
  const [hairpin, setHairpin] = useState(false);
  const [hairpinSources, setHairpinSources] = useState('');
  const [hairpinTouched, setHairpinTouched] = useState(false);
  const [log, setLog] = useState(false);
  const [limit, setLimit] = useState('');
  const [natKey, setNatKey] = useState<string>();
  const [route, setRoute] = useState<(HostRoute & { problem?: string }) | undefined>();
  // A field's problem shows once it was changed, or once "Review" was asked for.
  const [touched, setTouched] = useState<ReadonlySet<ForwardField>>(new Set());
  const [revealed, setRevealed] = useState(false);
  const touch = (field: ForwardField) => setTouched((current) => (current.has(field) ? current : new Set([...current, field])));

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      const known = new Set(network?.interfaces.map((entry) => entry.name) ?? []);
      const from = editing;
      setOpening((count) => count + 1);
      setName(from?.name ?? '');
      setProtocol(from === undefined ? 'tcp' : from.protocols.length === 2 ? 'both' : from.protocols[0]!);
      setPorts(from?.ports ?? '');
      setInInterfaces(from?.inInterfaces.filter((entry) => known.has(entry)) ?? []);
      setOtherIn(from?.inInterfaces.filter((entry) => !known.has(entry)).join(', ') ?? '');
      setExternalAddress(from?.externalAddress ?? '');
      setTarget(from?.target ?? '');
      setTargetPort(from?.targetPort ?? '');
      setOutInterfaces(from?.outInterfaces ?? []);
      setOutTouched(from !== undefined);
      setSources(from?.sources ?? '');
      setMasquerade(from?.masquerade ?? false);
      setHairpin(from?.hairpin !== undefined);
      setHairpinSources(from?.hairpin ?? '');
      setHairpinTouched(from?.hairpin !== undefined);
      setLog(from?.log ?? false);
      setLimit(from?.limit === undefined ? '' : String(from.limit));
      setNatKey(undefined);
      setRoute(undefined);
      setTouched(new Set());
      setRevealed(false);
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  const version = ipVersion(target.trim() || '0.0.0.0');
  const forward: PortForward = {
    name: name.trim(),
    protocols: protocol === 'both' ? ['tcp', 'udp'] : [protocol],
    ports: ports.trim(),
    inInterfaces: [...inInterfaces, ...list(otherIn)],
    ...(externalAddress !== '' && { externalAddress }),
    target: target.trim(),
    ...(targetPort.trim() !== '' && { targetPort: targetPort.trim() }),
    outInterfaces,
    ...(sources.trim() !== '' && { sources: sources.trim() }),
    masquerade,
    ...(hairpin && { hairpin: hairpinSources.trim() }),
    log,
    ...(limit.trim() !== '' && { limit: Number(limit) }),
  };
  const problems: { field: ForwardField; text: string }[] = [
    ...(taken.includes(forward.name) ? [{ field: 'name' as const, text: t('forward.problem.taken') }] : []),
    ...(hairpin && hairpinSources.trim() === '' ? [{ field: 'hairpin' as const, text: t('forward.problem.hairpin') }] : []),
    ...portForwardProblems(forward)
      .filter((found) => !(found.field === 'hairpin' && hairpinSources.trim() === ''))
      .map((found) => ({ field: found.field, text: problemText(t, found) })),
  ];
  const problem = problems[0]?.text;
  /** What is wrong with the field, once it may show: under the field, which turns red. */
  const errorOf = (field: ForwardField) =>
    revealed || touched.has(field) ? problems.filter((found) => found.field === field).map((found) => found.text).join(' ') || undefined : undefined;
  const invalid = (field: ForwardField) => (errorOf(field) === undefined ? undefined : true);

  // Where the host sends packets for the target: the interface towards it, and whether a gateway is in between.
  const routable = isIpAddress(target.trim());
  useEffect(() => {
    if (!open || !routable) {
      setRoute(undefined);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      api.get<{ route: HostRoute & { problem?: string } }>(`/hosts/${encodeURIComponent(hostId)}/route?to=${encodeURIComponent(target.trim())}`).then(
        (read) => {
          if (!current) return;
          setRoute(read.route);
          if (!outTouched && read.route.device !== undefined) setOutInterfaces([read.route.device]);
        },
        () => current && setRoute(undefined),
      );
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, routable, target]);

  // Hairpin clients: by default the network the target is on, as the host sees it.
  const targetNetwork = useMemo(() => {
    if (!routable || network === undefined) return undefined;
    for (const entry of network.interfaces) {
      for (const address of entry.addresses) {
        if (address.family !== version) continue;
        const own = networkOf(address.address, address.prefix);
        if (inNetwork(target.trim(), own)) return own;
      }
    }
    return undefined;
  }, [routable, network, target, version]);
  useEffect(() => {
    if (!hairpinTouched && targetNetwork !== undefined) setHairpinSources(targetNetwork);
  }, [targetNetwork, hairpinTouched]);

  const tables = useMemo(() => natTables(model.ruleset, version), [model, version]);
  const nat: NatTable = tables.find((table) => `${table.family} ${table.name}` === natKey) ?? tables[0]!;
  const plan = useMemo(
    () => (problem === undefined ? planPortForward(model.ruleset, model.text, forward, { ...(editing !== undefined && { replacing: editing.name }), natTable: nat }) : undefined),
    // The forward is rebuilt each render; its JSON is what matters.
    [model, JSON.stringify(forward), problem, nat.family, nat.name, editing?.name],
  );
  const rules = problem === undefined ? forwardRules(forward, nat.family) : undefined;

  const addresses = network?.interfaces.flatMap((entry) => entry.addresses.filter((address) => address.family === version && !address.address.startsWith('fe80')).map((address) => ({ ...address, name: entry.name }))) ?? [];
  const interfaces = network?.interfaces.filter((entry) => entry.name !== 'lo') ?? [];
  const tunnelHint = route !== undefined && (route.via !== undefined || (route.device !== undefined && TUNNEL.test(route.device)));
  const toggle = (names: string[], set: (next: string[]) => void, entry: string) => set(names.includes(entry) ? names.filter((other) => other !== entry) : [...names, entry]);
  const ifaceLabel = (entry: HostNetwork['interfaces'][number]) =>
    `${entry.name}${entry.addresses.length === 0 ? '' : ` (${entry.addresses.filter((address) => !address.address.startsWith('fe80')).map((address) => address.address).join(', ')})`}${entry.up ? '' : ` · ${t('forward.down')}`}`;

  return (
    <dialog ref={dialog} className={`${editor.dialog} ${styles.dialog}`} onClose={onClose} aria-labelledby="forward-title">
      <div key={opening} className={editor.dialogBody}>
        <h2 id="forward-title" className={editor.dialogTitle}>
          {t(editing === undefined ? 'forward.new' : 'forward.edit', { name: editing?.name ?? '' })}
        </h2>
        <p className={editor.note}>{t('forward.intro')}</p>

        <div className={editor.fields}>
          <h3 className={styles.section}>{t('forward.section.from')}</h3>
          <Field label={t('forward.name')} error={errorOf('name')}>
            <input className="input" value={name} maxLength={48} placeholder={t('forward.namePlaceholder')} aria-invalid={invalid('name')}
              onChange={(event) => {
                touch('name');
                setName(event.target.value);
              }}
              autoFocus />
          </Field>
          <Field label={t('forward.protocol')} group error={errorOf('protocols')}>
            <Segmented<Protocol>
              label={t('forward.protocol')}
              value={protocol}
              onChange={setProtocol}
              options={[
                { value: 'tcp', label: 'TCP' },
                { value: 'udp', label: 'UDP' },
                { value: 'both', label: t('forward.both') },
              ]}
            />
          </Field>
          <Field label={t('forward.ports')} error={errorOf('ports')}>
            <input className="input mono" value={ports} placeholder="8080, 8000-8010" spellCheck={false} aria-invalid={invalid('ports')}
              onChange={(event) => {
                touch('ports');
                setPorts(event.target.value);
              }} />
          </Field>
          <Field label={t('forward.inInterfaces')} group error={errorOf('inInterfaces')}>
            <span className={styles.stack}>
              <span className={editor.checks}>
                {interfaces.map((entry) => (
                  <label key={entry.name} className={editor.check}>
                    <input type="checkbox" checked={inInterfaces.includes(entry.name)} onChange={() => toggle(inInterfaces, setInInterfaces, entry.name)} />
                    {ifaceLabel(entry)}
                  </label>
                ))}
              </span>
              <input className="input mono" value={otherIn} placeholder={t('forward.otherInterfaces')} spellCheck={false} aria-invalid={invalid('inInterfaces')}
                onChange={(event) => {
                  touch('inInterfaces');
                  setOtherIn(event.target.value);
                }} />
              <span className={editor.note}>{t(forward.inInterfaces.length === 0 ? 'forward.anyInterface' : 'forward.someInterfaces')}</span>
            </span>
          </Field>
          <Field label={t('forward.externalAddress')} error={errorOf('externalAddress')}>
            <select className="select" value={externalAddress} aria-invalid={invalid('externalAddress')}
              onChange={(event) => {
                touch('externalAddress');
                setExternalAddress(event.target.value);
              }}>
              <option value="">{t('forward.anyAddress')}</option>
              {addresses.map((address) => (
                <option key={`${address.name} ${address.address}`} value={address.address}>
                  {address.address} ({address.name})
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('forward.sources')} error={errorOf('sources')}>
            <input className="input mono" value={sources} placeholder={t('forward.sourcesPlaceholder')} spellCheck={false} aria-invalid={invalid('sources')}
              onChange={(event) => {
                touch('sources');
                setSources(event.target.value);
              }} />
          </Field>

          <h3 className={styles.section}>{t('forward.section.to')}</h3>
          <Field label={t('forward.target')} error={errorOf('target')}>
            <input className="input mono" value={target} placeholder="192.168.1.10" spellCheck={false} aria-invalid={invalid('target')}
              onChange={(event) => {
                touch('target');
                setTarget(event.target.value);
              }} />
          </Field>
          <Field label={t('forward.targetPort')} error={errorOf('targetPort')}>
            <input className="input mono" value={targetPort} placeholder={t('forward.samePort')} spellCheck={false} aria-invalid={invalid('targetPort')}
              onChange={(event) => {
                touch('targetPort');
                setTargetPort(event.target.value);
              }} />
          </Field>
          {route !== undefined && (
            <p className={editor.note}>
              {route.problem !== undefined
                ? t('forward.routeProblem', { problem: route.problem })
                : route.via !== undefined
                  ? t('forward.routeVia', { device: route.device ?? '?', via: route.via })
                  : t('forward.routeDirect', { device: route.device ?? '?' })}
            </p>
          )}
          <Field label={t('forward.outInterfaces')} group error={errorOf('outInterfaces')}>
            <span className={editor.checks}>
              {interfaces.map((entry) => (
                <label key={entry.name} className={editor.check}>
                  <input
                    type="checkbox"
                    checked={outInterfaces.includes(entry.name)}
                    onChange={() => {
                      setOutTouched(true);
                      toggle(outInterfaces, setOutInterfaces, entry.name);
                    }}
                  />
                  {entry.name}
                </label>
              ))}
            </span>
          </Field>

          <h3 className={styles.section}>{t('forward.section.how')}</h3>
          <label className={editor.option}>
            <input type="checkbox" checked={masquerade} onChange={(event) => setMasquerade(event.target.checked)} />
            {t('forward.masquerade')}
          </label>
          <p className={editor.note}>{t('forward.masqueradeHint')}</p>
          {tunnelHint && !masquerade && (
            <Callout tone="info" icon={<InfoIcon />} title={t('forward.masqueradeSuggested')}>
              {t('forward.masqueradeSuggestedHint', { device: route?.device ?? '' })}
            </Callout>
          )}
          <label className={editor.option}>
            <input type="checkbox" checked={hairpin} onChange={(event) => setHairpin(event.target.checked)} />
            {t('forward.hairpin')}
          </label>
          <p className={editor.note}>{t('forward.hairpinHint')}</p>
          {hairpin && (
            <Field label={t('forward.hairpinSources')} error={errorOf('hairpin')}>
              <input
                className="input mono"
                value={hairpinSources}
                placeholder="192.168.1.0/24"
                spellCheck={false}
                aria-invalid={invalid('hairpin')}
                onChange={(event) => {
                  setHairpinTouched(true);
                  touch('hairpin');
                  setHairpinSources(event.target.value);
                }}
              />
            </Field>
          )}
          <label className={editor.option}>
            <input type="checkbox" checked={log} onChange={(event) => setLog(event.target.checked)} />
            {t('forward.log')}
          </label>
          <Field label={t('forward.limit')} error={errorOf('limit')}>
            <input className="input mono" value={limit} inputMode="numeric" placeholder={t('forward.noLimit')} aria-invalid={invalid('limit')}
              onChange={(event) => {
                touch('limit');
                setLimit(event.target.value);
              }} />
          </Field>
          <Field label={t('forward.natTable')}>
            <select className="select" value={`${nat.family} ${nat.name}`} onChange={(event) => setNatKey(event.target.value)}>
              {tables.map((table) => (
                <option key={`${table.family} ${table.name}`} value={`${table.family} ${table.name}`}>
                  {table.exists ? `${table.family} ${table.name}` : t('forward.newTable', { table: `${table.family} ${table.name}` })}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {network !== undefined && routable && <ForwardingNotice hostId={hostId} hostKind={hostKind} version={version} network={network} onNetwork={onNetwork} />}

        {plan !== undefined && rules !== undefined && (
          <div className={styles.plan}>
            {plan.blocked.length > 0 && (
              <Callout tone="warn" icon={<AlertIcon />} title={t('forward.blocked')}>
                <p>{t('forward.blockedHint')}</p>
                <ul className={styles.chains}>
                  {plan.blocked.map((chain) => (
                    <li key={`${chain.family} ${chain.table} ${chain.chain}`} className="mono">
                      {chain.family} {chain.table} › {chain.chain}
                    </li>
                  ))}
                </ul>
              </Callout>
            )}
            <p className={editor.note}>
              {plan.accepted.length === 0
                ? t('forward.noDrop')
                : t('forward.accepted', { chains: plan.accepted.map((chain) => `${chain.family} ${chain.table} › ${chain.chain}`).join(', ') })}
              {plan.replies.length > 0 && ` ${t('forward.replies')}`}
            </p>
            <div className={editor.preview}>
              <span className={editor.previewLabel}>{t('forward.preview', { table: `${nat.family} ${nat.name}` })}</span>
              <NftCode block className={editor.previewCode} text={[...rules.prerouting, ...rules.postrouting].join('\n')} />
              {plan.accepted.length > 0 && (
                <>
                  <span className={editor.previewLabel}>{t('forward.previewForward')}</span>
                  <NftCode block className={editor.previewCode} text={rules.forward.join('\n')} />
                </>
              )}
            </div>
          </div>
        )}
      </div>
      <div className={editor.dialogFooter}>
        <span className={editor.spacer} />
        <button type="button" className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={plan !== undefined && plan.changes.length === 0}
          title={plan !== undefined && plan.changes.length === 0 ? t('forward.unchanged') : undefined}
          onClick={() => {
            if (plan !== undefined) {
              onReview(plan.changes);
              return;
            }
            // Show what is wrong, each at its field, and go to the first.
            setRevealed(true);
            requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
          }}
        >
          {t('forward.review')}
        </button>
      </div>
    </dialog>
  );
}
