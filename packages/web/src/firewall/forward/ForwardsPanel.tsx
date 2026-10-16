// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { ipVersion, planPortForward, portForwards, ruleKey, type FoundForward, type HostKind, type PortForward, type TableChange } from '@hopdeck/core';
import { useMemo, useState } from 'react';
import { ErrorCallout } from '../../components/ErrorCallout.tsx';
import { EditIcon, PlusIcon, TrashIcon } from '../../components/icons.tsx';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import { chainAnchor, ruleCounter, type RulesetModel } from '../ruleset/model.ts';
import type { LiveInfo } from '../ruleset/useLive.ts';
import { ForwardDialog } from './ForwardDialog.tsx';
import { ForwardingNotice, useNetwork } from './ForwardingNotice.tsx';
import styles from './Forward.module.css';

interface ForwardsPanelProps {
  hostId: string;
  hostKind: HostKind;
  model: RulesetModel;
  live: LiveInfo | undefined;
  /** Opens the review of changes, as the rules tab does. */
  onChange(changes: TableChange[]): void;
  onShowChain(anchor: string): void;
}

/**
 * The host's port forwards, read from the rules hopdeck wrote for them, with
 * how many connections each took; a wizard adds, changes and removes them.
 * The host has to forward packets at all: when it does not, this says so.
 */
export function ForwardsPanel({ hostId, hostKind, model, live, onChange, onShowChain }: ForwardsPanelProps) {
  const { t, locale } = useI18n();
  const network = useNetwork(hostId);
  const found = useMemo(() => portForwards(model.ruleset), [model]);
  const [dialog, setDialog] = useState<{ editing?: PortForward } | undefined>();

  const connections = (entry: FoundForward): number | undefined => {
    const main = entry.main;
    if (main === undefined) return undefined;
    const counted = live?.state.rules[ruleKey(main.family, main.table, main.handle)];
    if (counted !== undefined) return counted.packets;
    const table = model.ruleset.tables.find((node) => node.table.family === main.family && node.table.name === main.table);
    const rule = table?.chains.find((node) => node.chain.name === main.chain)?.rules.find((candidate) => candidate.handle === main.handle);
    return rule === undefined || table === undefined ? undefined : ruleCounter(rule, table)?.packets;
  };
  const versions = new Set(found.flatMap((entry) => (entry.forward === undefined ? [] : [ipVersion(entry.forward.target)])));

  return (
    <div className={styles.panel}>
      <p className={styles.note}>{t('forward.panelIntro')}</p>
      {network.error !== undefined && <ErrorCallout error={network.error} />}
      {network.network !== undefined &&
        (['ip', 'ip6'] as const)
          .filter((version) => version === 'ip' || versions.has('ip6'))
          .map((version) => <ForwardingNotice key={version} hostId={hostId} hostKind={hostKind} version={version} network={network.network!} onNetwork={network.set} />)}

      <div className={styles.bar}>
        <button type="button" className="btn btn-primary" onClick={() => setDialog({})}>
          <PlusIcon />
          {t('forward.add')}
        </button>
      </div>

      {found.length === 0 ? (
        <p className={styles.note}>{t('forward.none')}</p>
      ) : (
        <ul className={styles.list}>
          {found.map((entry) => {
            const forward = entry.forward;
            const count = connections(entry);
            return (
              <li key={entry.name} className={styles.item}>
                <span className={styles.name}>{entry.name}</span>
                <span className={styles.what}>
                  {forward === undefined ? (
                    <span className={styles.details}>{t('forward.byHand')}</span>
                  ) : (
                    <>
                      <span className="mono">
                        {forward.protocols.map((protocol) => protocol.toUpperCase()).join('+')} {forward.ports} →{' '}
                        {forward.target.includes(':') && forward.targetPort !== undefined ? `[${forward.target}]` : forward.target}
                        {forward.targetPort === undefined ? '' : `:${forward.targetPort}`}
                      </span>
                      <span className={styles.details}>
                        {forward.inInterfaces.length === 0 ? t('forward.fromAny') : t('forward.from', { interfaces: forward.inInterfaces.join(', ') })}
                        {forward.externalAddress === undefined ? '' : ` · ${forward.externalAddress}`}
                        {forward.outInterfaces.length === 0 ? '' : ` · ${t('forward.through', { interfaces: forward.outInterfaces.join(', ') })}`}
                        {forward.sources === undefined ? '' : ` · ${t('forward.onlyFrom', { sources: forward.sources })}`}
                      </span>
                    </>
                  )}
                  <span className={styles.badges}>
                    {forward === undefined && <span className={`${styles.badge} ${styles.hand}`}>{t('forward.badge.hand')}</span>}
                    {forward?.masquerade === true && <span className={styles.badge}>masquerade</span>}
                    {forward?.hairpin !== undefined && <span className={styles.badge}>hairpin {forward.hairpin}</span>}
                    {forward?.log === true && <span className={styles.badge}>log</span>}
                    {forward?.limit !== undefined && <span className={styles.badge}>≤ {forward.limit}/s</span>}
                    {entry.main !== undefined && (
                      <button type="button" className={styles.chainLink} onClick={() => onShowChain(chainAnchor(entry.main!.family, entry.main!.table, entry.main!.chain))}>
                        {entry.main.family} {entry.main.table} › {entry.main.chain}
                      </button>
                    )}
                  </span>
                </span>
                <span className={styles.count}>{count === undefined ? '' : t('forward.connections', { count, formatted: count.toLocaleString(locale) })}</span>
                <span className={styles.buttons}>
                  <button type="button" className="btn btn-sm" disabled={forward === undefined} title={forward === undefined ? t('forward.byHand') : undefined} onClick={() => setDialog({ editing: forward! })}>
                    <EditIcon />
                    {t('forward.editButton')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => {
                      if (window.confirm(t('forward.removeConfirm', { name: entry.name }))) {
                        onChange(planPortForward(model.ruleset, model.text, undefined, { replacing: entry.name }).changes);
                      }
                    }}
                  >
                    <TrashIcon />
                    {t('forward.remove')}
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <ForwardDialog
        open={dialog !== undefined}
        hostId={hostId}
        hostKind={hostKind}
        model={model}
        network={network.network}
        onNetwork={network.set}
        editing={dialog?.editing}
        taken={found.map((entry) => entry.name).filter((name) => name !== dialog?.editing?.name)}
        onReview={(changes) => {
          setDialog(undefined);
          onChange(changes);
        }}
        onClose={() => setDialog(undefined)}
      />
    </div>
  );
}
