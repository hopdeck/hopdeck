// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { TableChange } from '../hosts.ts';
import { isManaged } from './changes.ts';
import type { Family, Json, NftChain } from './nft-json.ts';
import type { Ruleset, TableNode } from './ruleset.ts';
import { chains, editableTable, newChain, newTable, renderTable, type EditableChain, type EditableRule, type EditableTable } from './table-edit.ts';

/**
 * A port of this host forwarded to another machine: DNAT on prerouting, an
 * accept in every forward chain that would drop it, and on request
 * masquerade and hairpin NAT. Every rule it makes says in its comment which
 * forward it belongs to, so the forward can be read back, changed and removed.
 */
export interface PortForward {
  /** Letters, digits, spaces, ".", "_" and "-"; the rules' comments carry it. */
  name: string;
  protocols: ('tcp' | 'udp')[];
  /** The ports of this host, as nft writes them: "8080", "8000-8010", "80, 443". */
  ports: string;
  /** Interfaces the packets come in on (iifname); none: any. */
  inInterfaces: string[];
  /** Only packets to this address of the host; undefined: to any of its addresses. */
  externalAddress?: string;
  /** The machine it goes to, IPv4 or IPv6. */
  target: string;
  /** Its port; undefined: the same port as the packet came to. */
  targetPort?: string;
  /** Interfaces towards the target, for the accept on forward (oifname); none: any. */
  outInterfaces: string[];
  /** Only from these sources: addresses, prefixes, ranges, "@set"; undefined: from anywhere. */
  sources?: string;
  /** The target sees this host as the sender, so it answers through it. */
  masquerade: boolean;
  /** Clients that reach the forward at the host's own address from inside, e.g. "192.168.1.0/24". */
  hairpin?: string;
  /** Writes new connections to the kernel log. */
  log: boolean;
  /** New connections a second at most. */
  limit?: number;
}

/** What a rule of a forward does; the main rule (the DNAT) has none. */
export type ForwardRole = 'accept' | 'masquerade' | 'hairpin';

const COMMENT_PREFIX = 'hopdeck forward: ';
/** The rule hopdeck puts first in a forward chain that let no replies through. */
export const REPLIES_COMMENT = 'hopdeck: replies of forwarded connections';

export function forwardComment(name: string, role?: ForwardRole): string {
  return `${COMMENT_PREFIX}${name}${role === undefined ? '' : ` (${role})`}`;
}

/** The forward a rule comment names, and the rule's part in it. */
export function parseForwardComment(comment: string | undefined): { name: string; role?: ForwardRole } | undefined {
  const match = /^hopdeck forward: (.+?)(?: \((accept|masquerade|hairpin)\))?$/.exec(comment ?? '');
  if (match === null) return undefined;
  return { name: match[1]!, ...(match[2] !== undefined && { role: match[2] as ForwardRole }) };
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6 = /^(?=.*:)[0-9a-fA-F:.]{2,45}$/;
const INTERFACE = /^[A-Za-z0-9_.@:+-]{1,15}\*?$/;
// Values only, as in trace filters: no line break, no space but after a comma.
const ADDRESSES = /^[\w.:/@*\[\]-]+(?:, *[\w.:/@*\[\]-]+)*$/;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,47}$/u;

/** Whether the text is an IPv4 or IPv6 address, as a forward's target must be. */
export function isIpAddress(text: string): boolean {
  return IPV4.test(text) || IPV6.test(text);
}

export function ipVersion(address: string): 'ip' | 'ip6' {
  return address.includes(':') ? 'ip6' : 'ip';
}

/** The part of a forward a problem is in, for the form to show it at that field. */
export type ForwardField = 'name' | 'protocols' | 'ports' | 'targetPort' | 'target' | 'externalAddress' | 'inInterfaces' | 'outInterfaces' | 'sources' | 'hairpin' | 'limit';

/** What is wrong with a forward, for the form to say in its language, at the field it is in. */
export interface ForwardProblem {
  field: ForwardField;
  code: 'name' | 'protocols' | 'ports' | 'targetPort' | 'targetPortRange' | 'target' | 'externalAddress' | 'interface' | 'addresses' | 'mixed' | 'limit';
  /** What was given, where the text quotes it. */
  value?: string;
  /** The target's IP version, where the field must match it. */
  version?: 'IPv4' | 'IPv6';
}

/** Everything that keeps the forward from being written as rules, at most one problem a field. */
export function portForwardProblems(forward: PortForward): ForwardProblem[] {
  const problems: ForwardProblem[] = [];
  if (!NAME.test(forward.name)) problems.push({ field: 'name', code: 'name' });
  if (forward.protocols.length === 0 || forward.protocols.some((protocol) => protocol !== 'tcp' && protocol !== 'udp')) problems.push({ field: 'protocols', code: 'protocols' });
  if (portItems(forward.ports) === undefined) problems.push({ field: 'ports', code: 'ports', value: forward.ports });
  if (forward.targetPort !== undefined && forward.targetPort.includes('-')) problems.push({ field: 'targetPort', code: 'targetPortRange' });
  else if (forward.targetPort !== undefined && portItems(forward.targetPort)?.length !== 1) problems.push({ field: 'targetPort', code: 'targetPort', value: forward.targetPort });
  const target = isIpAddress(forward.target);
  if (!target) problems.push({ field: 'target', code: 'target', value: forward.target });
  const version = ipVersion(forward.target);
  const label = version === 'ip' ? 'IPv4' : 'IPv6';
  if (target && forward.externalAddress !== undefined && !(version === 'ip' ? IPV4 : IPV6).test(forward.externalAddress)) {
    problems.push({ field: 'externalAddress', code: 'externalAddress', value: forward.externalAddress, version: label });
  }
  for (const field of ['inInterfaces', 'outInterfaces'] as const) {
    const wrong = forward[field].find((name) => !INTERFACE.test(name));
    if (wrong !== undefined) problems.push({ field, code: 'interface', value: wrong });
  }
  for (const field of ['sources', 'hairpin'] as const) {
    const value = forward[field];
    if (value === undefined) continue;
    if (!ADDRESSES.test(value.trim())) problems.push({ field, code: 'addresses', value });
    else if (target && value.split(',').some((item) => !item.trim().startsWith('@') && ipVersion(item.trim()) !== version)) problems.push({ field, code: 'mixed', version: label });
  }
  if (forward.limit !== undefined && !(Number.isInteger(forward.limit) && forward.limit > 0 && forward.limit <= 1_000_000)) problems.push({ field: 'limit', code: 'limit' });
  return problems;
}

/** The first thing that keeps the forward from being written as rules, if any. */
export function portForwardProblem(forward: PortForward): ForwardProblem | undefined {
  return portForwardProblems(forward)[0];
}

/** "80, 8000-8010" as its items; undefined when one is no port or range of ports. */
function portItems(text: string): string[] | undefined {
  const items = text.split(',').map((item) => item.trim());
  for (const item of items) {
    const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(item);
    if (match === null) return undefined;
    const [from, to] = [Number(match[1]), Number(match[2] ?? match[1])];
    if (from < 1 || to > 65535 || from > to) return undefined;
  }
  return items;
}

/** One value or a set of them, as nft writes it. */
function oneOrSet(items: readonly string[]): string {
  return items.length === 1 ? items[0]! : `{ ${items.join(', ')} }`;
}

/** The rules of a forward, by the chains they go in, as nft text for a table of `family`. */
export interface ForwardRules {
  /** A nat chain on prerouting: the DNAT, then the one for hairpin clients. */
  prerouting: string[];
  /** Every filter chain on forward that drops what it does not accept. */
  forward: string[];
  /** A nat chain on postrouting: masquerade, or that of hairpin clients. */
  postrouting: string[];
}

export function forwardRules(forward: PortForward, family: Family): ForwardRules {
  const ip = ipVersion(forward.target);
  const ports = oneOrSet(portItems(forward.ports) ?? [forward.ports]);
  const protocol = (dport: string) =>
    forward.protocols.length === 2 ? `meta l4proto { tcp, udp } th dport ${dport}` : `${forward.protocols[0]} dport ${dport}`;
  const interfaces = (key: 'iifname' | 'oifname', names: readonly string[]) =>
    names.length === 0 ? [] : [`${key} ${oneOrSet(names.map((name) => JSON.stringify(name)))}`];
  const addresses = (text: string) => oneOrSet(text.split(',').map((item) => item.trim()));
  // Without an address, the host's own: a DNAT on the port alone would also catch connections passing through.
  const toHost = forward.externalAddress === undefined ? 'fib daddr type local' : `${ip} daddr ${forward.externalAddress}`;
  const target = forward.targetPort === undefined ? forward.target : ip === 'ip6' ? `[${forward.target}]:${forward.targetPort}` : `${forward.target}:${forward.targetPort}`;
  const dnat = `dnat ${family === 'inet' ? `${ip} ` : ''}to ${target}`;
  const toTarget = `${ip} daddr ${forward.target} ${protocol(forward.targetPort ?? ports)} ct status dnat`;
  const comment = (role?: ForwardRole) => `comment ${JSON.stringify(forwardComment(forward.name, role))}`;

  const main = [
    ...interfaces('iifname', forward.inInterfaces),
    toHost,
    ...(forward.sources === undefined ? [] : [`${ip} saddr ${addresses(forward.sources)}`]),
    protocol(ports),
    ...(forward.limit === undefined ? [] : [`limit rate ${forward.limit}/second`]),
    ...(forward.log ? [`log prefix ${JSON.stringify(`hopdeck forward ${forward.name}: `)}`] : []),
    'counter',
    dnat,
    comment(),
  ];
  const prerouting = [main.join(' ')];
  const postrouting: string[] = [];
  if (forward.hairpin !== undefined) {
    // Clients inside come in on another interface than the main rule names; without one named, it takes them already.
    if (forward.inInterfaces.length > 0) prerouting.push([`${ip} saddr ${addresses(forward.hairpin)}`, toHost, protocol(ports), 'counter', dnat, comment('hairpin')].join(' '));
    // Masquerade for all covers them too.
    if (!forward.masquerade) postrouting.push([`${ip} saddr ${addresses(forward.hairpin)}`, toTarget, 'counter masquerade', comment('hairpin')].join(' '));
  }
  if (forward.masquerade) postrouting.unshift([...interfaces('oifname', forward.outInterfaces), toTarget, 'counter masquerade', comment('masquerade')].join(' '));
  return {
    prerouting,
    forward: [[...interfaces('oifname', forward.outInterfaces), toTarget, 'counter accept', comment('accept')].join(' ')],
    postrouting,
  };
}

/** A rule of a forward as the host has it. */
export interface ForwardRule {
  family: Family;
  table: string;
  chain: string;
  handle: number;
  role?: ForwardRole;
}

/** A forward found in the rules, by the comments of its rules. */
export interface FoundForward {
  name: string;
  /** What the rules say, when they are as hopdeck writes them; undefined when someone changed them by hand. */
  forward?: PortForward;
  rules: ForwardRule[];
  /** The rule whose counter tells how many connections the forward took: its DNAT. */
  main?: ForwardRule;
}

/** The forwards hopdeck made, read back from the rules of the ruleset. */
export function portForwards(ruleset: Ruleset): FoundForward[] {
  const found = new Map<string, FoundForward>();
  const exprs = new Map<ForwardRule, Json[]>();
  for (const table of ruleset.tables) {
    for (const { chain, rules } of table.chains) {
      for (const rule of rules) {
        const parsed = parseForwardComment(rule.comment);
        if (parsed === undefined) continue;
        const entry = found.get(parsed.name) ?? { name: parsed.name, rules: [] };
        const forwardRule: ForwardRule = { family: chain.family, table: chain.table, chain: chain.name, handle: rule.handle, ...(parsed.role !== undefined && { role: parsed.role }) };
        entry.rules.push(forwardRule);
        exprs.set(forwardRule, rule.expr);
        if (parsed.role === undefined) entry.main ??= forwardRule;
        found.set(parsed.name, entry);
      }
    }
  }
  for (const entry of found.values()) {
    if (entry.main === undefined) continue;
    const forward = readForward(entry.name, exprs.get(entry.main)!, entry.rules.map((rule) => ({ rule, expr: exprs.get(rule)! })));
    if (forward !== undefined) entry.forward = forward;
  }
  return [...found.values()];
}

/** The forward its main rule describes, with what its other rules add; undefined for a rule hopdeck would not write. */
function readForward(name: string, main: readonly Json[], all: readonly { rule: ForwardRule; expr: readonly Json[] }[]): PortForward | undefined {
  const forward: PortForward = { name, protocols: [], ports: '', inInterfaces: [], target: '', outInterfaces: [], masquerade: false, log: false };
  let local = false;
  let targetPort: string | undefined;
  for (const statement of main) {
    const [kind, body] = single(statement);
    if (kind === 'match') {
      const match = object(body);
      if (match === undefined) return undefined;
      const left = match['left'];
      const right = match['right']!;
      if (match['op'] !== '==') return undefined;
      const [leftKind, leftBody] = single(left!);
      const key = object(leftBody);
      if (leftKind === 'meta' && key?.['key'] === 'iifname') forward.inInterfaces = values(right);
      else if (leftKind === 'meta' && key?.['key'] === 'l4proto') {
        // nft 0.9.8 prints the protocols of a set by number.
        const protocols = values(right).map((value) => PROTOCOL_NUMBERS[value] ?? value);
        if (protocols.some((protocol) => protocol !== 'tcp' && protocol !== 'udp')) return undefined;
        forward.protocols = protocols as PortForward['protocols'];
      }
      else if (leftKind === 'fib' && right === 'local') local = true;
      else if (leftKind === 'payload' && key?.['field'] === 'daddr' && (key['protocol'] === 'ip' || key['protocol'] === 'ip6')) forward.externalAddress = valueText(right);
      else if (leftKind === 'payload' && key?.['field'] === 'saddr' && (key['protocol'] === 'ip' || key['protocol'] === 'ip6')) forward.sources = valueText(right);
      else if (leftKind === 'payload' && key?.['field'] === 'dport') {
        if (key['protocol'] === 'tcp' || key['protocol'] === 'udp') forward.protocols = [key['protocol']];
        forward.ports = valueText(right) ?? '';
      } else return undefined;
    } else if (kind === 'limit') {
      const limit = object(body);
      if (limit?.['per'] !== 'second' || typeof limit['rate'] !== 'number' || limit['inv'] === true || limit['rate_unit'] !== undefined) return undefined;
      forward.limit = limit['rate'];
    } else if (kind === 'log') {
      forward.log = true;
    } else if (kind === 'counter') {
      // Always there.
    } else if (kind === 'dnat') {
      const dnat = object(body);
      if (dnat === undefined || typeof dnat['addr'] !== 'string') return undefined;
      forward.target = dnat['addr'];
      if (dnat['port'] !== undefined) targetPort = String(dnat['port']);
    } else return undefined;
  }
  if (forward.target === '' || forward.ports === '' || forward.protocols.length === 0 || (!local && forward.externalAddress === undefined)) return undefined;
  if (targetPort !== undefined) forward.targetPort = targetPort;

  for (const { rule, expr } of all) {
    if (rule.role === 'masquerade') forward.masquerade = true;
    if (rule.role === 'accept' && forward.outInterfaces.length === 0) forward.outInterfaces = matchValues(expr, 'oifname');
    if (rule.role === 'hairpin') forward.hairpin ??= saddr(expr);
  }
  if (forward.masquerade && forward.outInterfaces.length === 0) {
    const masquerade = all.find(({ rule }) => rule.role === 'masquerade');
    if (masquerade !== undefined) forward.outInterfaces = matchValues(masquerade.expr, 'oifname');
  }
  return forward;
}

const PROTOCOL_NUMBERS: Readonly<Record<string, string>> = { '6': 'tcp', '17': 'udp' };

function matchValues(expr: readonly Json[], key: string): string[] {
  for (const statement of expr) {
    const match = object(single(statement)[1]);
    const [leftKind, leftBody] = match?.['left'] === undefined ? [] : single(match['left']);
    if (leftKind === 'meta' && object(leftBody)?.['key'] === key) return values(match!['right']!);
  }
  return [];
}

function saddr(expr: readonly Json[]): string | undefined {
  for (const statement of expr) {
    const match = object(single(statement)[1]);
    const [leftKind, leftBody] = match?.['left'] === undefined ? [] : single(match['left']);
    if (leftKind === 'payload' && object(leftBody)?.['field'] === 'saddr') return valueText(match!['right']!);
  }
  return undefined;
}

function single(statement: Json): [string, Json | undefined] {
  const body = object(statement);
  const key = body === undefined ? undefined : Object.keys(body)[0];
  return key === undefined ? ['', undefined] : [key, body![key]];
}

function object(value: Json | undefined): { [key: string]: Json } | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

function values(value: Json): string[] {
  const set = object(value)?.['set'];
  return Array.isArray(set) ? set.map((item) => valueText(item) ?? '') : [valueText(value) ?? ''];
}

/** A match's value as nft writes it: "80", "8000-8010", "10.0.0.0/24", lists joined by ", ". */
function valueText(value: Json): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  const body = object(value);
  if (body === undefined) return undefined;
  if (Array.isArray(body['set'])) return body['set'].map((item) => valueText(item) ?? '').join(', ');
  if (Array.isArray(body['range'])) return body['range'].map((item) => valueText(item) ?? '').join('-');
  const prefix = object(body['prefix']);
  if (prefix !== undefined) return `${String(prefix['addr'])}/${String(prefix['len'])}`;
  return undefined;
}

/** A table a forward's NAT rules can go in. */
export interface NatTable {
  family: Family;
  name: string;
  /** false: hopdeck creates it, managed. */
  exists: boolean;
}

/** The managed tables a forward's NAT can go in, best first, and a new one should none fit. */
export function natTables(ruleset: Ruleset, version: 'ip' | 'ip6'): NatTable[] {
  const fits = (node: TableNode) => isManaged(node.table) && (node.table.family === 'inet' || node.table.family === version);
  const rank = (node: TableNode) => (node.chains.some(({ chain }) => isNat(chain, 'prerouting')) ? 0 : node.chains.some(({ chain }) => isForwardFilter(chain)) ? 1 : 2);
  const tables: NatTable[] = ruleset.tables
    .filter(fits)
    .sort((a, b) => rank(a) - rank(b))
    .map((node) => ({ family: node.table.family, name: node.table.name, exists: true }));
  let name = 'hopdeck_forward';
  for (let count = 2; ruleset.tables.some((node) => node.table.family === 'inet' && node.table.name === name); count += 1) name = `hopdeck_forward${count}`;
  if (!tables.some((table) => table.family === 'inet' && table.name === name)) tables.push({ family: 'inet', name, exists: false });
  return tables;
}

function isNat(chain: NftChain, hook: 'prerouting' | 'postrouting'): boolean {
  return chain.type === 'nat' && chain.hook === hook;
}

function isForwardFilter(chain: NftChain): boolean {
  return chain.type === 'filter' && chain.hook === 'forward';
}

/** What a forward changes, and what it cannot. */
export interface ForwardPlan {
  changes: TableChange[];
  /** Forward chains that drop what they do not accept, where hopdeck adds the accept. */
  accepted: { family: Family; table: string; chain: string }[];
  /** Of those, the ones that let no replies through: hopdeck adds that first. */
  replies: { family: Family; table: string; chain: string }[];
  /** Forward chains that would drop the packets, in tables hopdeck does not manage: the forward will not work until their owner lets them through. */
  blocked: { family: Family; table: string; chain: string }[];
}

/**
 * The changes that put `forward` on the host, in place of the forward named
 * `replacing` if given; without `forward`, the changes that remove that one.
 * `listing` is `nft -a list ruleset`, which the changes are made from, so the
 * deployment sees exactly what changed.
 */
export function planPortForward(
  ruleset: Ruleset,
  listing: string,
  forward: PortForward | undefined,
  options: { replacing?: string; natTable?: NatTable } = {},
): ForwardPlan {
  const tables = new Map<string, { table: EditableTable; base: string | undefined; changed: boolean }>();
  const edit = (family: Family, name: string, create = false) => {
    const key = `${family} ${name}`;
    let entry = tables.get(key);
    if (entry === undefined) {
      const existing = create ? undefined : editableTable(listing, family, name);
      const table = existing ?? newTable(family, name);
      entry = { table, base: existing === undefined ? undefined : renderTable(table), changed: false };
      tables.set(key, entry);
    }
    return entry;
  };
  const plan: ForwardPlan = { changes: [], accepted: [], replies: [], blocked: [] };

  // The forward as it was goes, wherever its rules are; what the new one writes the same stays as it is, counters and all.
  const leaving = new Map<EditableChain, { entry: { changed: boolean }; rules: EditableRule[] }>();
  const old = options.replacing;
  if (old !== undefined) {
    for (const node of ruleset.tables) {
      if (!isManaged(node.table)) continue;
      const entry = edit(node.table.family, node.table.name);
      for (const chain of chains(entry.table)) {
        const rules = chain.rules.filter((rule) => parseForwardComment(ruleComment(rule))?.name === old);
        if (rules.length > 0) leaving.set(chain, { entry, rules });
      }
    }
  }
  /** Puts the rules in the chain, at `index` or at its end, but keeps an old one that is the same. */
  const place = (entry: { changed: boolean }, chain: EditableChain, texts: readonly string[], index?: number) => {
    const old = leaving.get(chain)?.rules ?? [];
    const added: EditableRule[] = [];
    for (const text of texts) {
      const same = old.findIndex((rule) => withoutCounts(rule.text) === withoutCounts(text));
      if (same === -1) added.push({ handle: undefined, text });
      else old.splice(same, 1);
    }
    if (added.length === 0) return;
    chain.rules.splice(index ?? chain.rules.length, 0, ...added);
    entry.changed = true;
  };

  if (forward !== undefined) {
    const version = ipVersion(forward.target);
    const nat = options.natTable ?? natTables(ruleset, version)[0]!;
    const natEntry = edit(nat.family, nat.name, !nat.exists);
    const rules = forwardRules(forward, nat.family);
    const natNode = ruleset.tables.find((node) => node.table.family === nat.family && node.table.name === nat.name);
    place(natEntry, natChain(natEntry.table, natNode, 'prerouting'), rules.prerouting);
    if (rules.postrouting.length > 0) place(natEntry, natChain(natEntry.table, natNode, 'postrouting'), rules.postrouting);

    // Every forward chain must let it through: an accept in one table does not get past a drop in another.
    for (const node of ruleset.tables) {
      if (node.table.family !== 'inet' && node.table.family !== version) continue;
      for (const { chain } of node.chains) {
        if (!isForwardFilter(chain) || chain.policy !== 'drop') continue;
        const where = { family: chain.family, table: chain.table, chain: chain.name };
        if (!isManaged(node.table)) {
          plan.blocked.push(where);
          continue;
        }
        const entry = edit(chain.family, chain.table);
        const editable = chains(entry.table).find((candidate) => candidate.name === chain.name);
        if (editable === undefined) continue;
        if (!editable.rules.some((rule) => /\bct state\b/.test(rule.text) && /\bestablished\b/.test(rule.text))) {
          editable.rules.unshift({ handle: undefined, text: `ct state established,related accept comment ${JSON.stringify(REPLIES_COMMENT)}` });
          entry.changed = true;
          plan.replies.push(where);
        }
        // Before what drops everything at the end, such as "Log drops": a log there would record the packets as dropped.
        place(entry, editable, forwardRules(forward, chain.family).forward, trailingCatchAll(editable.rules));
        plan.accepted.push(where);
      }
    }
  }

  for (const [chain, { entry, rules }] of leaving) {
    if (rules.length === 0) continue;
    chain.rules = chain.rules.filter((rule) => !rules.includes(rule));
    entry.changed = true;
  }

  for (const { table, base, changed } of tables.values()) {
    if (!changed) continue;
    plan.changes.push({ kind: 'replace', family: table.family, table: table.name, definition: renderTable(table), ...(base !== undefined && { base }) });
  }
  return plan;
}

/** A rule's text without the values nft prints for its counter, as hopdeck writes it. */
function withoutCounts(text: string): string {
  return text.replace(/\bcounter packets \d+ bytes \d+/g, 'counter');
}

/** The table's nat chain on the hook, as nft listed it, or a new one added to it. */
function natChain(table: EditableTable, node: TableNode | undefined, hook: 'prerouting' | 'postrouting'): EditableChain {
  const live = node?.chains.find(({ chain }) => isNat(chain, hook));
  const existing = live === undefined ? undefined : chains(table).find((chain) => chain.name === live.chain.name);
  if (existing !== undefined) return existing;
  const added = chains(table).find((chain) => chain.name === hook && chain.header.some((line) => line.includes(`type nat hook ${hook}`)));
  if (added !== undefined) return added;
  const taken = new Set(chains(table).map((chain) => chain.name));
  const name = taken.has(hook) ? `hopdeck_${hook}` : hook;
  const chain = newChain(name, { type: 'nat', hook, priority: hook === 'prerouting' ? 'dstnat' : 'srcnat', policy: 'accept' });
  // Before the table's closing line.
  table.parts.splice(table.parts.length - 1, 0, { kind: 'chain', chain });
  return chain;
}

/** A rule's comment, from its nft text. */
function ruleComment(rule: EditableRule): string | undefined {
  return /comment "([^"]*)"$/.exec(rule.text)?.[1];
}

// Statements that match nothing in particular: counting, limiting, logging, and the verdict that ends it all.
const CATCH_ALL = /^(?:(?:counter(?: packets \d+ bytes \d+)?|limit rate (?:over )?\d+(?: \w+)?\/\w+(?: burst \d+ \w+)?|log(?: prefix "[^"]*")?(?: level \w+)?|drop|reject(?: with [\w -]+)?) ?)+$/;

/** Where the rules that end a chain for every packet begin: new accepts go before them. */
function trailingCatchAll(rules: readonly EditableRule[]): number {
  let index = rules.length;
  while (index > 0 && CATCH_ALL.test(rules[index - 1]!.text.replace(/ comment "[^"]*"$/, '').trim())) index -= 1;
  return index;
}
