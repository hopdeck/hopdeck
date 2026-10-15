// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { newChain, type BaseChainSpec, type Family } from '@hopdeck/core';
import { useEffect, useRef, useState } from 'react';
import { Segmented } from '../../components/Segmented.tsx';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import type { MessageKey } from '../../i18n/locales.ts';
import { NftCode } from '../ruleset/NftCode.tsx';
import styles from './Editor.module.css';
import { Choice, Field } from './fields.tsx';

interface ChainDialogProps {
  open: boolean;
  family: Family;
  /** Chains the table already has; a new one needs another name. */
  existing: readonly string[];
  onAdd(name: string, base: BaseChainSpec | undefined): void;
  onClose(): void;
}

const INET_HOOKS = ['prerouting', 'input', 'forward', 'output', 'postrouting'];
const HOOKS: Record<Family, string[]> = {
  ip: INET_HOOKS,
  ip6: INET_HOOKS,
  inet: [...INET_HOOKS, 'ingress'],
  arp: ['input', 'output'],
  bridge: INET_HOOKS,
  netdev: ['ingress', 'egress'],
};
/** Hooks each chain type can use; nat and route exist only for IP. */
const TYPE_HOOKS: Record<string, string[]> = {
  filter: [...INET_HOOKS, 'ingress', 'egress'],
  nat: ['prerouting', 'input', 'output', 'postrouting'],
  route: ['output'],
};
const IP_FAMILIES: readonly Family[] = ['ip', 'ip6', 'inet'];

/** Standard priority names nft knows for the family. */
function priorities(family: Family): string[] {
  if (family === 'bridge') return ['dstnat', 'filter', 'out', 'srcnat'];
  if (family === 'netdev') return ['filter'];
  return ['raw', 'mangle', 'dstnat', 'filter', 'security', 'srcnat'];
}

/** The priority chains of this type and hook usually get. */
function defaultPriority(type: string, hook: string): string {
  if (type === 'nat') return hook === 'prerouting' || hook === 'output' ? 'dstnat' : 'srcnat';
  if (type === 'route') return 'mangle';
  return 'filter';
}

const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Adds a chain to the table: a base chain on a hook, or a regular one to jump to. */
export function ChainDialog({ open, family, existing, onAdd, onClose }: ChainDialogProps) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [opening, setOpening] = useState(0);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'base' | 'regular'>('base');
  const [type, setType] = useState('filter');
  const [hook, setHook] = useState('input');
  const [priority, setPriority] = useState<string | undefined>();
  const [device, setDevice] = useState('');
  const [policy, setPolicy] = useState<'accept' | 'drop'>('accept');

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      setOpening((count) => count + 1);
      setName('');
      setKind('base');
      setType('filter');
      setHook(HOOKS[family][0] === 'prerouting' ? 'input' : HOOKS[family][0]!);
      setPriority(undefined);
      setDevice('');
      setPolicy('accept');
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  const types = IP_FAMILIES.includes(family) ? ['filter', 'nat', 'route'] : ['filter'];
  const hooks = HOOKS[family].filter((candidate) => TYPE_HOOKS[type]?.includes(candidate) ?? true);
  const needsDevice = family === 'netdev' || hook === 'ingress';
  const base: BaseChainSpec | undefined =
    kind === 'regular'
      ? undefined
      : {
          type,
          hook,
          priority: priority?.trim() || defaultPriority(type, hook),
          policy,
          ...(needsDevice && { device: device.trim() }),
        };

  const found: MessageKey[] = [];
  if (!NAME.test(name)) found.push('chain.problem.name');
  if (existing.includes(name)) found.push('chain.problem.taken');
  if (base !== undefined && needsDevice && base.device === '') found.push('chain.problem.device');
  const chain = newChain(name || '…', base);
  const preview = [chain.opening.trim(), ...chain.header.map((line) => `\t${line.trim()}`), '}'].join('\n');

  return (
    <dialog ref={dialog} className={styles.dialog} onClose={onClose} aria-labelledby="chain-title">
      <div key={opening} className={styles.dialogBody}>
        <h2 id="chain-title" className={styles.dialogTitle}>
          {t('chain.add')}
        </h2>
        <div className={styles.fields}>
          <Field label={t('chain.name')}>
            <input className="input mono" value={name} onChange={(event) => setName(event.target.value.trim())} spellCheck={false} autoFocus />
          </Field>
          <Field label={t('chain.kind')} group>
            <Segmented<'base' | 'regular'>
              label={t('chain.kind')}
              value={kind}
              onChange={setKind}
              options={[
                { value: 'base', label: t('chain.kindBase') },
                { value: 'regular', label: t('chain.kindRegular') },
              ]}
            />
          </Field>
          <p className={styles.note}>{t(kind === 'base' ? 'chain.kindBaseHint' : 'chain.kindRegularHint')}</p>
          {kind === 'base' && (
            <>
              <Field label={t('chain.type')}>
                <select className="select" value={type}
                  onChange={(event) => {
                    const next = event.target.value;
                    setType(next);
                    if (!TYPE_HOOKS[next]!.includes(hook)) setHook(HOOKS[family].find((candidate) => TYPE_HOOKS[next]!.includes(candidate))!);
                  }}>
                  {types.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </Field>
              <Field label={t('chain.hook')}>
                <select className="select" value={hook} onChange={(event) => setHook(event.target.value)}>
                  {hooks.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </Field>
              {needsDevice && (
                <Field label={t('chain.device')}>
                  <input className="input mono" value={device} placeholder="eth0" onChange={(event) => setDevice(event.target.value)} spellCheck={false} />
                </Field>
              )}
              <Field label={t('chain.priority')} group>
                <Choice label={t('chain.priority')} value={priority ?? defaultPriority(type, hook)} options={priorities(family)} onChange={setPriority} />
              </Field>
              <Field label={t('chain.policy')}>
                <select className="select" value={policy} onChange={(event) => setPolicy(event.target.value as 'accept' | 'drop')}>
                  <option value="accept">accept</option>
                  <option value="drop">drop</option>
                </select>
              </Field>
            </>
          )}
        </div>
        <div className={styles.preview}>
          <span className={styles.previewLabel}>{t('rule.preview')}</span>
          <NftCode text={preview} block className={styles.previewCode} />
        </div>
        {found.length > 0 && name !== '' && (
          <ul className={styles.problems}>
            {found.map((key) => <li key={key}>{t(key)}</li>)}
          </ul>
        )}
      </div>
      <div className={styles.dialogFooter}>
        <span className={styles.spacer} />
        <button type="button" className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="button" className="btn btn-primary" disabled={found.length > 0} onClick={() => onAdd(name, base)}>
          {t('chain.addOk')}
        </button>
      </div>
    </dialog>
  );
}
