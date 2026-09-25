import {
  chainKey,
  chainPolicy,
  editableTable,
  emptyRule,
  newChain,
  newTable,
  renderRule,
  renderTable,
  ruleForm,
  withPolicy,
  type BaseChainSpec,
  type EditableBlock,
  type EditableChain,
  type EditableTable,
  type Family,
  type RuleForm,
  type TableNode,
} from '@nftm/core';
import { priorityText, ruleCounter, type RulesetModel } from '../ruleset/model.ts';

export interface RuleRow {
  /** Stable React key. */
  key: string;
  /** Handle of the live rule; undefined for a new one. */
  handle: number | undefined;
  text: string;
  /** undefined: the rule is edited as text. */
  form: RuleForm | undefined;
  status: 'same' | 'new' | 'edited';
}

export interface ChainState {
  chain: EditableChain;
  /** Where a base chain hooks in, as nft shows it; undefined for a regular chain. */
  base: { type: string | undefined; hook: string; priority: string | undefined } | undefined;
  policy: 'accept' | 'drop' | undefined;
  /** Added in the editor; not on the host yet. */
  isNew: boolean;
  rows: RuleRow[];
}

/** A named set or map of the table. */
export interface SetState {
  block: EditableBlock;
  /** Added in the editor; not on the host yet. */
  isNew: boolean;
  /** Changed in the editor. */
  edited?: boolean;
}

/** What the editor starts from: the table on the host, or a new one. */
export interface EditorSource {
  table: EditableTable;
  chains: ChainState[];
  sets: SetState[];
  /** The definition the host has now; empty for a table being created. */
  original: string;
  creating: boolean;
  /** Named counters of the table. */
  counters: string[];
  counterOf(handle: number): { packets: number; bytes: number } | undefined;
}

/** How a new table starts. */
export interface NewTableSpec {
  template: 'empty' | 'host';
  /** The host template also lets SSH in. */
  ssh: boolean;
}

let nextKey = 0;
export const newRowKey = () => `new-${(nextKey += 1)}`;

/** The table as the host has it now; undefined when nft's listing lacks it. */
export function liveSource(model: RulesetModel, node: TableNode): EditorSource | undefined {
  const table = editableTable(model.text, node.table.family, node.table.name);
  if (table === undefined) return undefined;
  const rules = node.chains.flatMap((chain) => chain.rules);
  return {
    table,
    chains: initialChains(table, node, model),
    sets: table.parts.flatMap((part) =>
      part.kind === 'block' && (part.block.kind === 'set' || part.block.kind === 'map') ? [{ block: part.block, isNew: false }] : [],
    ),
    original: renderTable(table),
    creating: false,
    counters: node.objects.filter((object) => object.kind === 'counter').map((object) => object.object.name),
    counterOf: (handle) => {
      const rule = rules.find((candidate) => candidate.handle === handle);
      return rule && ruleCounter(rule, node);
    },
  };
}

/** A table that does not exist yet, from one of the templates. */
export function newTableSource(family: Family, name: string, spec: NewTableSpec): EditorSource {
  return {
    table: newTable(family, name),
    chains: spec.template === 'host' ? [hostInput(family, spec.ssh)] : [],
    sets: [],
    original: '',
    creating: true,
    counters: [],
    counterOf: () => undefined,
  };
}

/** The families the host template is for. */
export const HOST_TEMPLATE_FAMILIES: readonly Family[] = ['inet', 'ip', 'ip6'];

/**
 * Incoming traffic is dropped, except replies to the host's own connections,
 * loopback, ping, IPv6 neighbour discovery and, optionally, SSH. ICMP errors
 * about existing connections count as related and pass too.
 */
function hostInput(family: Family, ssh: boolean): ChainState {
  const rule = (form: Partial<RuleForm>): RuleRow => {
    const full: RuleForm = { ...emptyRule(), ...form };
    return { key: newRowKey(), handle: undefined, text: renderRule(full, family), form: full, status: 'new' };
  };
  const rows = [
    rule({ ctState: ['established', 'related'] }),
    rule({ ctState: ['invalid'], action: { kind: 'drop' } }),
    rule({ inInterface: { value: 'lo', negate: false, byIndex: true } }),
  ];
  if (family !== 'ip6') rows.push(rule({ protocol: 'icmp', icmpType: 'echo-request' }));
  if (family !== 'ip') {
    rows.push(rule({ protocol: 'icmpv6', icmpType: 'echo-request, nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert' }));
  }
  if (ssh) rows.push(rule({ protocol: 'tcp', dstPort: { value: '22', negate: false }, comment: 'SSH' }));
  return addedChain('input', { type: 'filter', hook: 'input', priority: 'filter', policy: 'drop' }, rows);
}

/** A chain added in the editor. */
export function addedChain(name: string, base: BaseChainSpec | undefined, rows: RuleRow[] = []): ChainState {
  return {
    chain: newChain(name, base),
    base: base && { type: base.type, hook: base.hook, priority: base.priority },
    policy: base?.policy,
    isNew: true,
    rows,
  };
}

/** The chains of a table with their rules, ready for the visual editor. */
export function initialChains(table: EditableTable, node: TableNode, model: RulesetModel): ChainState[] {
  return table.parts.flatMap((part) => {
    if (part.kind !== 'chain') return [];
    const json = node.chains.find((chain) => chain.chain.name === part.chain.name);
    const header = model.listing.chainHeaders.get(chainKey(node.table.family, node.table.name, part.chain.name));
    const hook = json?.chain.hook;
    return [
      {
        chain: part.chain,
        base: hook === undefined ? undefined : { type: json!.chain.type, hook, priority: priorityText(header, json!.chain) },
        policy: chainPolicy(part.chain),
        isNew: false,
        rows: part.chain.rules.map((rule, index) => {
          const live = json?.rules.find((candidate) => candidate.handle === rule.handle);
          return {
            key: `h${rule.handle ?? `x${index}`}`,
            handle: rule.handle,
            text: rule.text,
            form: live === undefined ? undefined : ruleForm(live, rule.text),
            status: 'same' as const,
          };
        }),
      },
    ];
  });
}

/**
 * The definition the chains and sets describe, and the line of each rule in it
 * (1-based). Chains and sets missing from the lists were deleted; new sets go
 * before the first chain, new chains last.
 */
export function definitionOf(table: EditableTable, chains: ChainState[], sets: SetState[]): { text: string; lines: Map<string, number> } {
  const byName = new Map(chains.map((state) => [state.chain.name, state]));
  const keptSets = new Map(sets.filter((state) => !state.isNew).map((state) => [`${state.block.kind} ${state.block.name}`, state]));
  const output: string[] = [];
  const lines = new Map<string, number>();
  let setsPlaced = false;

  const write = (state: ChainState) => {
    const chain = state.policy === undefined ? state.chain : withPolicy(state.chain, state.policy);
    output.push(chain.opening, ...chain.header);
    for (const row of state.rows) {
      output.push(`\t\t${row.text}`);
      lines.set(row.key, output.length);
    }
    output.push('\t}');
  };
  // nft separates blocks with an empty line.
  const separate = () => {
    if (output.at(-1) === '\t}') output.push('');
  };
  const placeNewSets = (chainFollows: boolean) => {
    if (setsPlaced) return;
    setsPlaced = true;
    const added = sets.filter((state) => state.isNew);
    for (const state of added) {
      separate();
      output.push(...state.block.lines);
    }
    if (added.length > 0 && chainFollows) output.push('');
  };
  const skip = () => {
    // A deleted block takes the empty line before it along.
    if (output.at(-1) === '') output.pop();
  };

  const closing = table.parts.length - 1;
  table.parts.forEach((part, index) => {
    if (part.kind === 'chain') placeNewSets(true);
    if (index === closing) {
      const added = chains.filter((candidate) => candidate.isNew);
      placeNewSets(added.length > 0);
      for (const state of added) {
        separate();
        write(state);
      }
    }
    if (part.kind === 'line') {
      output.push(part.text);
    } else if (part.kind === 'block') {
      const { kind, name, lines: blockLines } = part.block;
      const kept = keptSets.get(`${kind} ${name}`);
      if (kind !== 'set' && kind !== 'map') output.push(...blockLines);
      else if (kept !== undefined) output.push(...kept.block.lines);
      else skip();
    } else {
      const state = byName.get(part.chain.name);
      if (state !== undefined && !state.isNew) write(state);
      else skip();
    }
  });
  return { text: `${output.join('\n')}\n`, lines };
}
