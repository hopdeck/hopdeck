import { chainKey, hasPath, packetPath, type HookStage, type PathKind, type Traffic } from '@nftm/core';
import { Fragment, useState } from 'react';
import { Callout } from '../components/Callout.tsx';
import { AlertIcon, ChevronRightIcon, GlobeIcon, InfoIcon, RouteIcon, TerminalIcon } from '../components/icons.tsx';
import { Segmented } from '../components/Segmented.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/locales.ts';
import { chainAnchor, priorityText, type RulesetModel } from './model.ts';
import { OwnerBadge } from './owner.tsx';
import styles from './PacketPath.module.css';
import rulesetStyles from './Ruleset.module.css';

interface PacketPathViewProps {
  model: RulesetModel;
  /** Called with a chain's DOM id (chainAnchor) to show its rules. */
  onShowChain(anchor: string): void;
}

/** The base chains of all tables that a packet meets, hook by hook, in the order the kernel runs them. */
export function PacketPathView({ model, onShowChain }: PacketPathViewProps) {
  const { t } = useI18n();
  const [traffic, setTraffic] = useState<Traffic>('ipv4');
  const [chosenPath, setPath] = useState<PathKind>('incoming');
  const path = hasPath(traffic, chosenPath) ? chosenPath : 'incoming';
  // ingress and egress are rare; they appear only when a chain runs there.
  const stages = packetPath(model.ruleset, traffic, path)!.filter(
    (stage) => stage.chains.length > 0 || (stage.hook !== 'ingress' && stage.hook !== 'egress'),
  );

  const from = path === 'outgoing' ? 'local' : 'network';
  const to = path === 'incoming' ? 'local' : 'network';
  const decision: MessageKey | undefined =
    traffic === 'arp' ? undefined : traffic === 'bridge' ? 'path.decision.bridge' : 'path.decision.routing';
  // Where the decision falls: after prerouting for arriving packets, before output for local ones.
  const decisionBefore = path === 'outgoing' ? 'output' : stages.find((stage) => stage.hook !== 'ingress' && stage.hook !== 'prerouting')?.hook;

  return (
    <div className={styles.view}>
      <div className={styles.controls}>
        <Segmented<Traffic>
          label={t('path.traffic.label')}
          value={traffic}
          onChange={setTraffic}
          options={[
            { value: 'ipv4', label: 'IPv4' },
            { value: 'ipv6', label: 'IPv6' },
            { value: 'arp', label: 'ARP' },
            { value: 'bridge', label: t('path.traffic.bridge') },
          ]}
        />
        <Segmented<PathKind>
          label={t('path.kind.label')}
          value={path}
          onChange={setPath}
          options={[
            { value: 'incoming', label: t('path.kind.incoming') },
            {
              value: 'forwarded',
              label: t('path.kind.forwarded'),
              disabled: !hasPath(traffic, 'forwarded'),
              ...(!hasPath(traffic, 'forwarded') && { title: t('path.noForwardArp') }),
            },
            { value: 'outgoing', label: t('path.kind.outgoing') },
          ]}
        />
      </div>

      <Callout tone="info" icon={<InfoIcon />} title={t('path.howTo.title')}>
        {t('path.howTo')}
      </Callout>

      <ol className={styles.pipeline}>
        <Endpoint kind={from} />
        {stages.map((stage) => (
          <Fragment key={stage.hook}>
            {decision !== undefined && stage.hook === decisionBefore && (
              <li className={styles.decision}>
                <RouteIcon />
                {t(decision)}
              </li>
            )}
            <Stage stage={stage} model={model} onShowChain={onShowChain} />
          </Fragment>
        ))}
        <Endpoint kind={to} />
      </ol>
    </div>
  );
}

function Endpoint({ kind }: { kind: 'network' | 'local' }) {
  const { t } = useI18n();
  return (
    <li className={styles.endpoint}>
      {kind === 'network' ? <GlobeIcon /> : <TerminalIcon />}
      {t(kind === 'network' ? 'path.node.network' : 'path.node.local')}
    </li>
  );
}

function Stage({ stage, model, onShowChain }: { stage: HookStage; model: RulesetModel; onShowChain(anchor: string): void }) {
  const { t } = useI18n();
  return (
    <li className={`card ${styles.stage}`}>
      <h3 className={styles.hook}>
        <span className="mono">{stage.hook}</span>
      </h3>
      {stage.chains.length === 0 ? (
        <p className={styles.empty}>{t('path.empty')}</p>
      ) : (
        <ol className={styles.chains}>
          {stage.chains.map(({ node, chain, priority, tie }, index) => {
            const { family, name: table } = node.table;
            const { name, type, policy, dev } = chain.chain;
            const priorityLabel = priorityText(model.listing.chainHeaders.get(chainKey(family, table, name)), chain.chain);
            const devices = typeof dev === 'string' ? [dev] : dev;
            return (
              <li key={`${family} ${table} ${name}`}>
                <button
                  type="button"
                  className={styles.chain}
                  onClick={() => onShowChain(chainAnchor(family, table, name))}
                  title={t('path.showChain', { chain: name })}
                >
                  <span className={styles.order}>{index + 1}</span>
                  <span className={styles.priority} title={String(priority)}>
                    {tie && <AlertIcon className={styles.tieIcon} aria-label={t('path.tie')} />}
                    <span className="mono">{priorityLabel}</span>
                  </span>
                  <span className={styles.where}>
                    <span className={styles.table}>
                      <span className={rulesetStyles.family}>{family}</span>
                      <span className="mono">{table}</span>
                      <OwnerBadge owner={model.owners.get(node)!} />
                    </span>
                    <span className={styles.chainName}>
                      <span className="mono">{name}</span>
                      {devices !== undefined && <span className={styles.note}>{t('path.devices', { devices: devices.join(', ') })}</span>}
                      {type === 'nat' && <span className={styles.note}>{t('path.natNote')}</span>}
                    </span>
                  </span>
                  <span className={styles.tags}>
                    {type && <span className={rulesetStyles.tag}>{type}</span>}
                    {policy && (
                      <span className={`${rulesetStyles.tag} ${policy === 'drop' ? rulesetStyles.tagDrop : rulesetStyles.tagAccept}`}>
                        policy {policy}
                      </span>
                    )}
                  </span>
                  <span className={styles.rules}>{t('counts.rules', { count: chain.rules.length })}</span>
                  <ChevronRightIcon className={styles.chevron} />
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {stage.chains.some((entry) => entry.tie) && (
        <p className={styles.tieNote}>
          <AlertIcon />
          {t('path.tie')}
        </p>
      )}
    </li>
  );
}
