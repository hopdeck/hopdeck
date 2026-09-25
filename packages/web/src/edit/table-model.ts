import { chainKey, chainPolicy, renderTable, ruleForm, withPolicy, type EditableChain, type EditableTable, type NftChain, type RuleForm, type TableNode } from '@nftm/core';
import { priorityText, type RulesetModel } from '../ruleset/model.ts';

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
  /** The chain in nft's JSON, for its type, hook and priority. */
  json: NftChain | undefined;
  priority: string | undefined;
  policy: 'accept' | 'drop' | undefined;
  rows: RuleRow[];
}

/** The chains of a table with their rules, ready for the visual editor. */
export function initialChains(table: EditableTable, node: TableNode, model: RulesetModel): ChainState[] {
  return table.parts.flatMap((part) => {
    if (part.kind !== 'chain') return [];
    const json = node.chains.find((chain) => chain.chain.name === part.chain.name);
    const header = model.listing.chainHeaders.get(chainKey(node.table.family, node.table.name, part.chain.name));
    return [
      {
        chain: part.chain,
        json: json?.chain,
        priority: json === undefined || json.chain.hook === undefined ? undefined : priorityText(header, json.chain),
        policy: chainPolicy(part.chain),
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

/** The definition the chains describe, and the line of each rule in it (1-based). */
export function definitionOf(table: EditableTable, chains: ChainState[]): { text: string; lines: Map<string, number> } {
  const byName = new Map(chains.map((state) => [state.chain.name, state]));
  const edited: EditableTable = {
    ...table,
    parts: table.parts.map((part) => {
      if (part.kind !== 'chain') return part;
      const state = byName.get(part.chain.name)!;
      const chain = state.policy === undefined ? part.chain : withPolicy(part.chain, state.policy);
      return { kind: 'chain', chain: { ...chain, rules: state.rows.map((row) => ({ handle: row.handle, text: row.text })) } };
    }),
  };
  const lines = new Map<string, number>();
  let line = 0;
  for (const part of edited.parts) {
    if (part.kind === 'line') {
      line += 1;
      continue;
    }
    line += 1 + part.chain.header.length;
    for (const row of byName.get(part.chain.name)!.rows) lines.set(row.key, (line += 1));
    line += 1;
  }
  return { text: renderTable(edited), lines };
}
