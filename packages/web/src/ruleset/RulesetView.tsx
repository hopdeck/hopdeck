import {
  blockKey,
  chainKey,
  isManaged,
  parseSetBlock,
  ruleKey,
  userComment,
  type TableChange,
  type ChainNode,
  type Family,
  type Json,
  type NftSet,
  type TableNode,
  type TableOwner,
} from '@nftm/core';
import { useState, type ReactNode } from 'react';
import { Callout } from '../components/Callout.tsx';
import { ElementsDialog } from '../edit/ElementsDialog.tsx';
import type { EditorMode } from '../edit/TableEditor.tsx';
import { ErrorCallout, type ErrorInfo } from '../components/ErrorCallout.tsx';
import { AlertIcon, CheckIcon, PlusIcon, RefreshIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { chainAnchor, counterSource, formatBytes, priorityText, ruleCounter, tableCounts, type RulesetModel } from './model.ts';
import type { LiveInfo } from './useLive.ts';
import { NftCode } from './NftCode.tsx';
import { OwnerBadge, toolName } from './owner.tsx';
import styles from './Ruleset.module.css';
import type { RulesetState } from './useRuleset.ts';

/** Longer blocks (e.g. sets with thousands of elements) are cut; the Text tab has everything. */
const MAX_BLOCK_LINES = 200;

/** Changes the rules view may start; present only when nft can run as root on the host. */
export interface RulesetActions {
  manualOverride: boolean;
  onChange(changes: TableChange[]): void;
  onEdit(family: Family, table: string, mode: EditorMode): void;
  onCreate(): void;
}

/** Live counters and change detection; present when nft can run as root on the host. */
export interface LiveControls {
  info: LiveInfo | undefined;
  error: ErrorInfo | undefined;
  /** Seconds between looks; 0 is off. */
  seconds: number;
  onSeconds(seconds: number): void;
  /** Tables that differ on the host from what the view shows, as "family name"; empty while nftm itself changes them. */
  changed: readonly string[];
}

const LIVE_INTERVALS = [0, 2, 5, 15];

export function RulesetView({ state, actions, live }: { state: RulesetState; actions?: RulesetActions | undefined; live?: LiveControls | undefined }) {
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
        {actions !== undefined && model !== undefined && (
          <button type="button" className="btn btn-sm btn-primary" onClick={actions.onCreate}>
            <PlusIcon />
            {t('newTable.button')}
          </button>
        )}
        {live !== undefined && (
          <label className={styles.live} title={live.error?.message ?? t('live.hint')}>
            <span className={`dot ${live.error !== undefined ? 'dot-danger' : live.seconds > 0 && live.info !== undefined ? 'dot-ok' : ''}`} aria-hidden="true" />
            {t('live.label')}
            <select className="select select-compact" value={live.seconds} onChange={(event) => live.onSeconds(Number(event.target.value))}>
              {LIVE_INTERVALS.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds === 0 ? t('live.off') : t('live.every', { count: seconds })}
                </option>
              ))}
            </select>
          </label>
        )}
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

      {live?.error !== undefined && live.seconds > 0 && (
        <Callout tone="warn" icon={<AlertIcon />} title={t('live.failed')}>
          <pre className="details">{live.error.message}</pre>
        </Callout>
      )}

      {live !== undefined && live.changed.length > 0 && (
        <Callout tone="warn" icon={<AlertIcon />} title={t('live.changed')} role="status">
          <p>{t('live.changedTables', { tables: live.changed.join(', ') })}</p>
          <p>
            <button type="button" className="btn btn-sm" onClick={reload} disabled={loading}>
              <RefreshIcon />
              {t('ruleset.refresh')}
            </button>
          </p>
        </Callout>
      )}

      {model !== undefined && <Tables model={model} actions={actions} live={live?.seconds ? live.info : undefined} />}
    </div>
  );
}

function Tables({ model, actions, live }: { model: RulesetModel; actions: RulesetActions | undefined; live: LiveInfo | undefined }) {
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
          <p>{t('ruleset.empty')}</p>
          {actions !== undefined && (
            <p>
              <button type="button" className="btn btn-sm btn-primary" onClick={actions.onCreate}>
                <PlusIcon />
                {t('newTable.button')}
              </button>
            </p>
          )}
        </Callout>
      )}
      {ruleset.tables.map((node) => (
        <TableCard
          key={`${node.table.family} ${node.table.name}`}
          node={node}
          owner={model.owners.get(node)!}
          model={model}
          actions={actions}
          live={live}
        />
      ))}
    </>
  );
}

interface TableCardProps {
  node: TableNode;
  owner: TableOwner;
  model: RulesetModel;
  live: LiveInfo | undefined;
  actions: RulesetActions | undefined;
}

function TableCard({ node, owner, model, actions, live }: TableCardProps) {
  const { t } = useI18n();
  const { family, name } = node.table;
  const managed = isManaged(node.table);
  // xt expressions cannot be recreated by nft, whatever the mode.
  const frozen = owner.kind === 'iptables-nft' && owner.evidence === 'xt';
  const canAdopt = actions !== undefined && !managed && owner.kind === 'unknown';
  const canDelete = actions !== undefined && !frozen && (managed || actions.manualOverride);
  // Editing follows the same rules as deleting: what nftm manages, or anything under Manual override.
  const canEdit = canDelete;
  const [elements, setElements] = useState<{ kind: 'set' | 'map'; name: string }>();
  const elementsBlock = elements && model.listing.blocks.get(blockKey(family, name, elements.kind, elements.name));
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
        {managed && (
          <span className={`${styles.badge} ${styles.badgeManaged}`} title={t('table.managedTitle')}>
            nftm
          </span>
        )}
        <OwnerBadge owner={owner} />
        <span className={styles.tableCounts}>{summary.join(' · ')}</span>
      </summary>

      {(canAdopt || canDelete) && (
        <div className={styles.tableActions}>
          {canEdit && (
            <>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => actions.onEdit(family, name, 'visual')}>
                {t('table.edit')}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => actions.onEdit(family, name, 'text')}>
                {t('table.editText')}
              </button>
            </>
          )}
          {canAdopt && (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => actions.onChange([{ kind: 'adopt', family, table: name }])}>
              {t('table.adopt')}
            </button>
          )}
          {canAdopt && <span className={styles.actionHint}>{t('table.adoptHint')}</span>}
          {canDelete && (
            <button
              type="button"
              className="btn btn-sm btn-ghost btn-danger"
              onClick={() => actions.onChange([{ kind: 'delete', family, table: name }])}
            >
              {t('table.delete')}
            </button>
          )}
        </div>
      )}

      {owner.kind !== 'unknown' && <OwnerNote owner={owner} />}
      {userComment(node.table.comment) !== undefined && <p className={styles.comment}>{userComment(node.table.comment)}</p>}

      <div className={styles.chains}>
        {node.chains.map((chain) => (
          <Chain key={chain.chain.name} chain={chain} node={node} model={model} live={live} />
        ))}
      </div>

      {(node.sets.length > 0 || node.maps.length > 0) && (
        <section className={styles.group}>
          <h3 className={styles.groupTitle}>{t('ruleset.setsAndMaps')}</h3>
          {node.sets.map((set) => (
            <SetItem key={`set ${set.name}`} kind="set" set={set} node={node} model={model}
              onElements={canEdit ? () => setElements({ kind: 'set', name: set.name }) : undefined} />
          ))}
          {node.maps.map((map) => (
            <SetItem key={`map ${map.name}`} kind="map" set={map} node={node} model={model}
              onElements={canEdit ? () => setElements({ kind: 'map', name: map.name }) : undefined} />
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
      {actions !== undefined && (
        <ElementsDialog
          family={family}
          table={name}
          set={elementsBlock === undefined ? undefined : parseSetBlock(elementsBlock)}
          chains={node.chains.filter((chain) => chain.chain.hook === undefined).map((chain) => chain.chain.name)}
          onReview={(change) => {
            setElements(undefined);
            actions.onChange([change]);
          }}
          onClose={() => setElements(undefined)}
        />
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

function Chain({ chain, node, model, live }: { chain: ChainNode; node: TableNode; model: RulesetModel; live: LiveInfo | undefined }) {
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
            const source = counterSource(rule, node);
            const liveCounter = source === undefined || live === undefined ? undefined : (source.kind === 'rule' ? live.state.rules : live.state.counters)[source.key];
            const rate = source === undefined || live === undefined ? undefined : (source.kind === 'rule' ? live.rates.rules : live.rates.counters)[source.key];
            const counter = liveCounter ?? ruleCounter(rule, node);
            const listed = model.listing.rules.get(ruleKey(family, table, rule.handle));
            // nft printed the values of the moment it was read; show the live ones in the text too.
            const text = liveCounter !== undefined && source?.kind === 'rule' ? listed?.replace(/counter packets \d+ bytes \d+/, `counter packets ${liveCounter.packets} bytes ${liveCounter.bytes}`) : listed;
            const busy = rate !== undefined && rate.packets > 0;
            return (
              <li key={rule.handle} className={`${styles.rule} ${busy ? styles.ruleBusy : ''}`}>
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
                  {busy && (
                    <span className={styles.rate} title={t('live.rateTitle')}>
                      {t('live.rate', { packets: formatRate(rate.packets, locale), bytes: formatBytes(Math.round(rate.bytes), locale) })}
                    </span>
                  )}
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

interface SetItemProps {
  kind: 'set' | 'map';
  set: NftSet;
  node: TableNode;
  model: RulesetModel;
  /** Opens the element editor; absent when the table cannot be changed. */
  onElements: (() => void) | undefined;
}

function SetItem({ kind, set, node, model, onElements }: SetItemProps) {
  const { t } = useI18n();
  const type = typeText(set.type) + (kind === 'map' && set.map !== undefined ? ` : ${typeText(set.map)}` : '');
  const details = [type, ...(set.flags ?? []), t('counts.elements', { count: set.elem?.length ?? 0 })].filter(Boolean);
  return (
    <BlockItem kind={kind} name={set.name} node={node} model={model} fallback={set}>
      <span className={styles.itemMeta}>{details.join(' · ')}</span>
      {onElements !== undefined && (
        <button
          type="button"
          className={`btn btn-sm ${styles.itemAction}`}
          onClick={(event) => {
            // The button sits in the summary; it must not fold the block.
            event.preventDefault();
            onElements();
          }}
        >
          {t('elements.button')}
        </button>
      )}
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

/** Packets a second: whole numbers from 10 up, one decimal below. */
function formatRate(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value);
}
