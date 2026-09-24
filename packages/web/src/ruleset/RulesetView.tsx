import {
  blockKey,
  chainKey,
  ruleKey,
  type ChainNode,
  type Json,
  type NftSet,
  type TableNode,
  type TableOwner,
} from '@nftm/core';
import type { ReactNode } from 'react';
import { Callout } from '../components/Callout.tsx';
import { ErrorCallout } from '../components/ErrorCallout.tsx';
import { AlertIcon, CheckIcon, RefreshIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { chainAnchor, formatBytes, priorityText, ruleCounter, tableCounts, type RulesetModel } from './model.ts';
import { NftCode } from './NftCode.tsx';
import { OwnerBadge, toolName } from './owner.tsx';
import styles from './Ruleset.module.css';
import type { RulesetState } from './useRuleset.ts';

/** Longer blocks (e.g. sets with thousands of elements) are cut; the Text tab has everything. */
const MAX_BLOCK_LINES = 200;

export function RulesetView({ state }: { state: RulesetState }) {
  const { t, locale } = useI18n();
  const { model, loading, error, reload } = state;

  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <p className={styles.summary}>
          {model !== undefined && (
            <>
              {[
                t('counts.tables', { count: model.counts.tables }),
                t('counts.chains', { count: model.counts.chains }),
                t('counts.rules', { count: model.counts.rules }),
              ].join(' · ')}
              <span className={styles.readAt}>
                {t('ruleset.readAt', { time: new Intl.DateTimeFormat(locale, { timeStyle: 'medium' }).format(model.readAt) })}
              </span>
            </>
          )}
        </p>
        <button type="button" className="btn btn-sm" onClick={reload} disabled={loading}>
          {loading ? <span className="spinner" aria-hidden="true" /> : <RefreshIcon />}
          {t('ruleset.refresh')}
        </button>
      </div>

      {error !== undefined && <ErrorCallout error={error} />}

      {model === undefined && loading && (
        <p className={styles.loading} role="status">
          <span className="spinner" aria-hidden="true" />
          {t('ruleset.loading')}
        </p>
      )}

      {model !== undefined && <Tables model={model} />}
    </div>
  );
}

function Tables({ model }: { model: RulesetModel }) {
  const { t } = useI18n();
  const { ruleset } = model;
  return (
    <>
      {ruleset.unknown.length > 0 && (
        <Callout tone="warn" icon={<AlertIcon />} title={t('ruleset.unknown', { count: ruleset.unknown.length })}>
          <pre className="details">{ruleset.unknown.map((item) => JSON.stringify(item)).join('\n')}</pre>
        </Callout>
      )}
      {ruleset.tables.length === 0 && (
        <Callout tone="info" icon={<CheckIcon />} title={t('ruleset.empty.title')}>
          {t('ruleset.empty')}
        </Callout>
      )}
      {ruleset.tables.map((node) => (
        <TableCard key={`${node.table.family} ${node.table.name}`} node={node} owner={model.owners.get(node)!} model={model} />
      ))}
    </>
  );
}

function TableCard({ node, owner, model }: { node: TableNode; owner: TableOwner; model: RulesetModel }) {
  const { t } = useI18n();
  const { family, name } = node.table;
  const counts = tableCounts(node);
  const summary = [
    t('counts.chains', { count: counts.chains }),
    t('counts.rules', { count: counts.rules }),
    counts.sets > 0 && t('counts.sets', { count: counts.sets }),
    counts.maps > 0 && t('counts.maps', { count: counts.maps }),
  ].filter(Boolean);

  return (
    <details className={`card ${styles.table}`} open>
      <summary className={styles.tableHeader}>
        <span className={styles.family}>{family}</span>
        <span className={`${styles.tableName} mono`}>{name}</span>
        <OwnerBadge owner={owner} />
        <span className={styles.tableCounts}>{summary.join(' · ')}</span>
      </summary>

      {owner.kind !== 'unknown' && <OwnerNote owner={owner} />}
      {node.table.comment && <p className={styles.comment}>{node.table.comment}</p>}

      <div className={styles.chains}>
        {node.chains.map((chain) => (
          <Chain key={chain.chain.name} chain={chain} node={node} model={model} />
        ))}
      </div>

      {(node.sets.length > 0 || node.maps.length > 0) && (
        <section className={styles.group}>
          <h3 className={styles.groupTitle}>{t('ruleset.setsAndMaps')}</h3>
          {node.sets.map((set) => (
            <SetItem key={`set ${set.name}`} kind="set" set={set} node={node} model={model} />
          ))}
          {node.maps.map((map) => (
            <SetItem key={`map ${map.name}`} kind="map" set={map} node={node} model={model} />
          ))}
        </section>
      )}

      {(node.objects.length > 0 || node.flowtables.length > 0) && (
        <section className={styles.group}>
          <h3 className={styles.groupTitle}>{t('ruleset.objects')}</h3>
          {node.flowtables.map((flowtable) => (
            <BlockItem key={`flowtable ${flowtable.name}`} kind="flowtable" name={flowtable.name} node={node} model={model} fallback={flowtable} />
          ))}
          {node.objects.map(({ kind, object }) => (
            <BlockItem key={`${kind} ${object.name}`} kind={kind} name={object.name} node={node} model={model} fallback={object} />
          ))}
        </section>
      )}
    </details>
  );
}

/** Why nftm thinks another tool owns the table: the evidence, never just a verdict. */
function OwnerNote({ owner }: { owner: Exclude<TableOwner, { kind: 'unknown' }> }) {
  const { t } = useI18n();
  if (owner.kind === 'tool') {
    return <p className={styles.ownerNote}>{t('owner.tool', { tool: toolName(owner.tool) })}</p>;
  }
  const evidence = { marker: t('owner.evidence.marker'), xt: t('owner.evidence.xt'), chains: t('owner.evidence.chains') }[owner.evidence];
  return (
    <p className={styles.ownerNote}>
      {evidence}{' '}
      {owner.users.length > 0 && `${t('owner.users', { tools: owner.users.map((tool) => toolName(tool)).join(', ') })} `}
      {t('owner.iptables')}
    </p>
  );
}

function Chain({ chain, node, model }: { chain: ChainNode; node: TableNode; model: RulesetModel }) {
  const { t, locale } = useI18n();
  const { family, name: table } = node.table;
  const { name, type, hook, policy } = chain.chain;
  const base = hook !== undefined;
  const priority = base ? priorityText(model.listing.chainHeaders.get(chainKey(family, table, name)), chain.chain) : undefined;

  return (
    <section id={chainAnchor(family, table, name)} className={styles.chain}>
      <header className={styles.chainHeader}>
        <h3 className={`${styles.chainName} mono`}>{name}</h3>
        {base ? (
          <span className={styles.chainMeta}>
            {type && <span className={styles.tag}>{type}</span>}
            <span className={styles.tag}>hook {hook}</span>
            {priority !== undefined && <span className={styles.tag}>priority {priority}</span>}
            {policy && <span className={`${styles.tag} ${policy === 'drop' ? styles.tagDrop : styles.tagAccept}`}>policy {policy}</span>}
          </span>
        ) : (
          <span className={styles.chainRegular}>{t('chain.regular')}</span>
        )}
        <span className={styles.ruleCount}>{t('counts.rules', { count: chain.rules.length })}</span>
      </header>

      {chain.rules.length === 0 ? (
        <p className={styles.noRules}>{t(base ? 'chain.noRulesBase' : 'chain.noRulesRegular')}</p>
      ) : (
        <ol className={styles.rules}>
          {chain.rules.map((rule, index) => {
            const text = model.listing.rules.get(ruleKey(family, table, rule.handle));
            const counter = ruleCounter(rule, node);
            return (
              <li key={rule.handle} className={styles.rule}>
                <span className={styles.index}>{index + 1}</span>
                {text !== undefined ? (
                  <NftCode text={text} className={styles.ruleText} />
                ) : (
                  <span className={styles.ruleMissing}>
                    {t('rule.noText')}
                    <code className="code-inline">{JSON.stringify(rule.expr)}</code>
                  </span>
                )}
                <span className={styles.ruleMeta}>
                  {counter !== undefined && (
                    <span className={styles.counter}>
                      {t('counts.packets', { count: counter.packets, n: new Intl.NumberFormat(locale).format(counter.packets) })}
                      {' · '}
                      {formatBytes(counter.bytes, locale)}
                    </span>
                  )}
                  <span className={styles.handle} title={t('rule.handle')}>
                    #{rule.handle}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function SetItem({ kind, set, node, model }: { kind: 'set' | 'map'; set: NftSet; node: TableNode; model: RulesetModel }) {
  const { t } = useI18n();
  const type = typeText(set.type) + (kind === 'map' && set.map !== undefined ? ` : ${typeText(set.map)}` : '');
  const details = [type, ...(set.flags ?? []), t('counts.elements', { count: set.elem?.length ?? 0 })].filter(Boolean);
  return (
    <BlockItem kind={kind} name={set.name} node={node} model={model} fallback={set}>
      <span className={styles.itemMeta}>{details.join(' · ')}</span>
    </BlockItem>
  );
}

interface BlockItemProps {
  kind: string;
  name: string;
  node: TableNode;
  model: RulesetModel;
  /** Shown as JSON when the listing has no block for this object. */
  fallback: unknown;
  children?: ReactNode;
}

function BlockItem({ kind, name, node, model, fallback, children }: BlockItemProps) {
  const { t } = useI18n();
  const block = model.listing.blocks.get(blockKey(node.table.family, node.table.name, kind, name));
  const lines = block?.split('\n');
  const shown = lines !== undefined && lines.length > MAX_BLOCK_LINES ? lines.slice(0, MAX_BLOCK_LINES).join('\n') : block;

  return (
    <details className={styles.item}>
      <summary className={styles.itemHeader}>
        <span className={styles.kind}>{kind}</span>
        <span className="mono">{name}</span>
        {children}
      </summary>
      {shown !== undefined ? (
        <>
          <NftCode block text={shown} className={styles.blockCode} />
          {lines !== undefined && lines.length > MAX_BLOCK_LINES && (
            <p className={styles.truncated}>{t('ruleset.truncated', { shown: MAX_BLOCK_LINES, total: lines.length })}</p>
          )}
        </>
      ) : (
        <pre className="details">{JSON.stringify(fallback, null, 2)}</pre>
      )}
    </details>
  );
}

/** "ipv4_addr", concatenations as "ipv4_addr . inet_service". */
function typeText(type: Json | undefined): string {
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return type.map(typeText).join(' . ');
  return '';
}
