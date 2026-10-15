// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { Family, Json, NftRule } from './nft-json.ts';

/**
 * A rule as the form editor sees it. Values are nft syntax as typed ("10.0.0.0/24",
 * "@admins", "1000-2000"); several values are separated by commas ("80, 443")
 * and get the braces of an anonymous set when rendered. nft on the host
 * validates them.
 */
export interface RuleForm {
  /** Layer 4 protocol. Ports, ICMP types and TCP flags need one; on its own it is `meta l4proto`. */
  protocol?: string;
  /** The rule also says `meta l4proto`, not only through ports, ICMP types or TCP flags. */
  protocolExplicit?: boolean;
  /** IPv4 or IPv6 for the address fields. */
  ipVersion?: 'ip' | 'ip6';
  srcAddress?: Match;
  dstAddress?: Match;
  srcPort?: Match;
  dstPort?: Match;
  icmpType?: string;
  inInterface?: InterfaceMatch;
  outInterface?: InterfaceMatch;
  /** Connection states: new, established, related, invalid, untracked. */
  ctState?: string[];
  tcpFlags?: TcpFlags;
  /** Packet length in bytes. */
  length?: Comparison;
  /** Link-layer packet type: unicast, broadcast, multicast, other. */
  pktType?: Match;
  /** The packet's or the connection's mark. */
  mark?: MarkMatch;
  /** The source address would not be routed back out of the interface the packet came in on. */
  rpfilter?: boolean;
  /** Concurrent connections: `ct count [over] N`. */
  connLimit?: { count: number; over: boolean };
  limit?: Limit;
  /** A rate limit per source address (or another key), kept in a dynamic set. */
  keyedLimit?: KeyedLimit;
  /** Bytes before the quota is used up: `quota [over] N unit`. */
  quota?: { amount: number; unit: string; over: boolean };
  counter?: boolean;
  counterName?: string;
  log?: { prefix?: string; level?: string; group?: number };
  markSet?: { target: 'meta' | 'ct'; value: string };
  notrack?: boolean;
  action: RuleAction;
  comment?: string;
  /** Order of the parts as the rule had them; nft keeps it, so the form does too. */
  order: RulePart[];
}

export interface Match {
  value: string;
  negate: boolean;
}

export interface InterfaceMatch extends Match {
  /** iif/oif match the interface index (it must exist when the rule loads); iifname/oifname the name. */
  byIndex: boolean;
}

export type Operator = '==' | '!=' | '<' | '>' | '<=' | '>=';

export interface Comparison {
  op: Operator;
  value: string;
}

export interface MarkMatch extends Comparison {
  source: 'meta' | 'ct';
}

/**
 * TCP flags: those in `set` must be set and those in `unset` clear; the others
 * do not matter. With `any`, one flag of `set` is enough.
 */
export interface TcpFlags {
  set: string[];
  unset: string[];
  any?: boolean;
}

export interface Limit {
  rate: number;
  per: string;
  /** Bytes instead of packets. */
  unit?: string;
  burst?: number;
  burstUnit?: string;
  /** Match what goes over the rate instead of what stays within it. */
  over?: boolean;
}

export interface KeyedLimit {
  /** `meter` creates the set itself; add and update need an existing dynamic set. */
  verb: 'add' | 'update' | 'meter';
  set: string;
  /** What is counted separately, e.g. "ip saddr". */
  key: string;
  /** How long an idle key is remembered, e.g. "1m". */
  timeout?: string;
  limit: Limit;
}

export type RuleAction =
  | { kind: 'none' | 'accept' | 'drop' | 'return' | 'continue' | 'masquerade' }
  | { kind: 'reject'; with?: string }
  | { kind: 'jump' | 'goto'; target: string }
  | { kind: 'snat' | 'dnat'; family?: 'ip' | 'ip6'; to: string }
  | { kind: 'redirect'; port: string }
  /** The verdict comes from a map: a named one ("@ports") or elements ("22 : accept, 80 : drop"). */
  | { kind: 'vmap'; key: string; map: string };

export type RulePart =
  | 'protocol'
  | 'inInterface'
  | 'outInterface'
  | 'srcAddress'
  | 'dstAddress'
  | 'srcPort'
  | 'dstPort'
  | 'icmpType'
  | 'ctState'
  | 'tcpFlags'
  | 'length'
  | 'pktType'
  | 'mark'
  | 'rpfilter'
  | 'connLimit'
  | 'limit'
  | 'keyedLimit'
  | 'quota'
  | 'counter'
  | 'log'
  | 'markSet'
  | 'notrack'
  | 'action';

/** Where new parts go: matches first, then statements, the verdict last. */
const CANONICAL: readonly RulePart[] = [
  'ctState',
  'inInterface',
  'outInterface',
  'protocol',
  'srcAddress',
  'dstAddress',
  'srcPort',
  'dstPort',
  'icmpType',
  'tcpFlags',
  'length',
  'pktType',
  'mark',
  'rpfilter',
  'connLimit',
  'limit',
  'keyedLimit',
  'quota',
  'counter',
  'log',
  'markSet',
  'notrack',
  'action',
];

const PORT_PROTOCOLS = new Set(['tcp', 'udp', 'udplite', 'sctp', 'dccp']);
// nft prints ct states and TCP flags in bit order.
const CT_STATES = ['invalid', 'established', 'related', 'new', 'untracked'];
export const TCP_FLAGS = ['fin', 'syn', 'rst', 'psh', 'ack', 'urg', 'ecn', 'cwr'];
const OPERATORS: readonly Operator[] = ['==', '!=', '<', '>', '<=', '>='];
const SIMPLE_VERDICTS = ['accept', 'drop', 'return', 'continue'];

/** A plain `reject` is stored with the family's default type; nft prints it back as plain `reject`. */
const DEFAULT_REJECT: Partial<Record<Family, string>> = {
  ip: 'icmp port-unreachable',
  ip6: 'icmpv6 port-unreachable',
  inet: 'icmpx port-unreachable',
  bridge: 'icmpx port-unreachable',
};

/**
 * The form of a rule, or undefined when the form cannot show all of it; such a
 * rule is edited as text. A form is only offered when rendering it gives back
 * exactly the text nft printed, so editing in the form never loses anything.
 */
export function ruleForm(rule: NftRule, printed: string): RuleForm | undefined {
  const form = parseRule(rule.expr, rule.family);
  if (form === undefined) return undefined;
  if (rule.comment !== undefined) form.comment = rule.comment;
  return withoutCounterValues(renderRule(form, rule.family)) === withoutCounterValues(printed) ? form : undefined;
}

export function emptyRule(): RuleForm {
  return { action: { kind: 'accept' }, order: [] };
}

/** The rule as nft text, parts in the order the rule had them; new parts in canonical places. */
export function renderRule(form: RuleForm, family: Family): string {
  const parts: string[] = [];
  for (const part of partOrder(form)) {
    const text = renderPart(form, part, family);
    if (text !== undefined) parts.push(text);
  }
  if (form.comment !== undefined && form.comment !== '') parts.push(`comment ${quote(form.comment)}`);
  return parts.join(' ');
}

/** A limit as nft writes it, e.g. "limit rate over 10/second burst 5 packets". */
export function renderLimit(limit: Limit): string {
  const { rate, per, unit, burst, burstUnit, over } = limit;
  const burstText = burst ? ` burst ${burst} ${unit ? (burstUnit ?? 'bytes') : 'packets'}` : '';
  return `limit rate ${over ? 'over ' : ''}${rate}${unit ? ` ${unit}` : ''}/${per}${burstText}`;
}

function partOrder(form: RuleForm): RulePart[] {
  const present = CANONICAL.filter((part) => isPresent(form, part));
  const order = form.order.filter((part) => present.includes(part));
  for (const part of present) {
    if (order.includes(part)) continue;
    const rank = CANONICAL.indexOf(part);
    const before = order.findIndex((other) => CANONICAL.indexOf(other) > rank);
    order.splice(before === -1 ? order.length : before, 0, part);
  }
  return order;
}

function isPresent(form: RuleForm, part: RulePart): boolean {
  switch (part) {
    case 'protocol':
      return form.protocol !== undefined && (form.protocolExplicit === true || !usesProtocol(form));
    case 'counter':
      return form.counter === true || form.counterName !== undefined;
    case 'action':
      return form.action.kind !== 'none';
    case 'ctState':
      return (form.ctState?.length ?? 0) > 0;
    case 'tcpFlags':
      return form.tcpFlags !== undefined && form.tcpFlags.set.length + form.tcpFlags.unset.length > 0;
    case 'rpfilter':
    case 'notrack':
      return form[part] === true;
    default:
      return form[part] !== undefined;
  }
}

/** Ports, ICMP types and TCP flags carry the protocol themselves ("tcp dport 22"). */
function usesProtocol(form: RuleForm): boolean {
  return form.srcPort !== undefined || form.dstPort !== undefined || form.icmpType !== undefined || isPresent(form, 'tcpFlags');
}

function renderPart(form: RuleForm, part: RulePart, family: Family): string | undefined {
  const ip = form.ipVersion ?? (family === 'ip6' ? 'ip6' : 'ip');
  switch (part) {
    case 'protocol':
      return `meta l4proto ${form.protocol}`;
    case 'inInterface':
      return renderInterface('i', form.inInterface!);
    case 'outInterface':
      return renderInterface('o', form.outInterface!);
    case 'srcAddress':
      return `${ip} saddr ${renderMatch(form.srcAddress!)}`;
    case 'dstAddress':
      return `${ip} daddr ${renderMatch(form.dstAddress!)}`;
    case 'srcPort':
      return `${form.protocol ?? 'tcp'} sport ${renderMatch(form.srcPort!)}`;
    case 'dstPort':
      return `${form.protocol ?? 'tcp'} dport ${renderMatch(form.dstPort!)}`;
    case 'icmpType':
      return `${form.protocol === 'icmpv6' ? 'icmpv6' : 'icmp'} type ${list(form.icmpType!)}`;
    case 'ctState':
      return `ct state ${[...form.ctState!].sort((a, b) => CT_STATES.indexOf(a) - CT_STATES.indexOf(b)).join(',')}`;
    case 'tcpFlags':
      return renderTcpFlags(form.tcpFlags!);
    case 'length':
      return `meta length ${renderComparison(form.length!)}`;
    case 'pktType':
      return `meta pkttype ${renderMatch(form.pktType!)}`;
    case 'mark':
      return `${form.mark!.source} mark ${renderComparison(form.mark!)}`;
    case 'rpfilter':
      return 'fib saddr . iif oif missing';
    case 'connLimit':
      return `ct count ${form.connLimit!.over ? 'over ' : ''}${form.connLimit!.count}`;
    case 'limit':
      return renderLimit(form.limit!);
    case 'keyedLimit': {
      const { verb, set, key, timeout, limit } = form.keyedLimit!;
      const inside = `{ ${key}${timeout ? ` timeout ${timeout}` : ''} ${renderLimit(limit)} }`;
      return verb === 'meter' ? `meter ${set} ${inside}` : `${verb} @${set} ${inside}`;
    }
    case 'quota': {
      const { amount, unit, over } = form.quota!;
      return `quota ${over ? 'over ' : ''}${amount} ${unit}`;
    }
    case 'counter':
      return form.counterName !== undefined ? `counter name ${quote(form.counterName)}` : 'counter';
    case 'log': {
      const { prefix, level, group } = form.log!;
      return ['log', prefix !== undefined && `prefix ${quote(prefix)}`, level !== undefined && `level ${level}`, group !== undefined && `group ${group}`]
        .filter(Boolean)
        .join(' ');
    }
    case 'markSet':
      return `${form.markSet!.target} mark set ${form.markSet!.value.trim()}`;
    case 'notrack':
      return 'notrack';
    case 'action':
      return renderAction(form.action, family);
  }
}

function renderTcpFlags({ set, unset, any }: TcpFlags): string {
  const order = (flags: readonly string[]) => [...flags].sort((a, b) => TCP_FLAGS.indexOf(a) - TCP_FLAGS.indexOf(b));
  if (any) return `tcp flags ${order(set).join(',')}`;
  if (set.length === 0) return `tcp flags ! ${order(unset).join(',')}`;
  const mask = order([...set, ...unset]);
  // With every flag in the mask, nft says it shorter: a single flag by name, several as a number.
  if (mask.length === TCP_FLAGS.length) {
    const bits = set.reduce((sum, flag) => sum | (1 << TCP_FLAGS.indexOf(flag)), 0);
    return `tcp flags == ${set.length === 1 ? set[0] : `0x${bits.toString(16)}`}`;
  }
  return `tcp flags & ${mask.length > 1 ? `(${mask.join(' | ')})` : mask[0]} == ${order(set).join(' | ')}`;
}

function renderComparison({ op, value }: Comparison): string {
  return `${op === '==' ? '' : `${op} `}${list(value)}`;
}

function renderInterface(direction: 'i' | 'o', match: InterfaceMatch): string {
  const key = match.byIndex ? `${direction}if` : `${direction}ifname`;
  const value = match.value.trim();
  const names = value.startsWith('{') ? value : list(value.split(',').map((name) => quote(name.trim().replace(/^"(.*)"$/, '$1'))).join(', '));
  return `${key} ${match.negate ? '!= ' : ''}${names}`;
}

function renderMatch(match: Match): string {
  return `${match.negate ? '!= ' : ''}${list(match.value)}`;
}

/** Several comma-separated values become an anonymous set: "80, 443" is `{ 80, 443 }`. */
function list(value: string): string {
  const text = value.trim();
  if (!text.includes(',') || text.startsWith('{')) return text;
  const items = text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return items.length > 1 ? `{ ${items.join(', ')} }` : (items[0] ?? '');
}

function renderAction(action: RuleAction, family: Family): string | undefined {
  switch (action.kind) {
    case 'none':
      return undefined;
    case 'reject':
      return action.with === undefined || action.with === DEFAULT_REJECT[family] ? 'reject' : `reject with ${action.with}`;
    case 'jump':
    case 'goto':
      return `${action.kind} ${action.target}`;
    case 'snat':
    case 'dnat':
      return `${action.kind} ${action.family !== undefined ? `${action.family} ` : ''}to ${action.to}`;
    case 'redirect':
      return `redirect to :${action.port}`;
    case 'vmap': {
      const map = action.map.trim();
      return `${action.key.trim()} vmap ${map.startsWith('@') || map.startsWith('{') ? map : `{ ${map} }`}`;
    }
    default:
      return action.kind;
  }
}

function quote(text: string): string {
  return `"${text}"`;
}

/** What changes on its own: counter values and the use of quotas. */
function withoutCounterValues(text: string): string {
  return text.replace(/counter packets \d+ bytes \d+/g, 'counter').replace(/ used \d+ \w+/g, '');
}

type JsonObject = { [key: string]: Json };

/** Recognises the statements the form covers; anything else means the rule stays text. */
function parseRule(expr: readonly Json[], family: Family): RuleForm | undefined {
  const form: RuleForm = { action: { kind: 'none' }, order: [] };
  const add = (part: RulePart) => {
    if (form.order.includes(part)) throw new Unsupported();
    form.order.push(part);
  };
  try {
    for (const statement of expr) {
      const [kind, body] = single(statement);
      if (kind === 'match') parseMatch(form, object(body), add);
      else parseStatement(form, kind, body, family, add);
    }
  } catch (error) {
    if (error instanceof Unsupported) return undefined;
    throw error;
  }
  return form;
}

class Unsupported extends Error {}

function parseMatch(form: RuleForm, match: JsonObject, add: (part: RulePart) => void): void {
  const op = string(match['op']);
  const [leftKind, leftBody] = single(match['left']!);
  const right = match['right']!;

  // TCP flags come in four shapes: any of (in), none of (!), exact (==) and under a mask (&).
  if (leftKind === '&') {
    const [flagsField, mask] = pair(leftBody);
    if (!isTcpFlags(flagsField) || op !== '==') throw new Unsupported();
    const masked = flagList(mask);
    const set = flagList(right);
    if (set.some((flag) => !masked.includes(flag))) throw new Unsupported();
    return setTcpFlags(form, { set, unset: masked.filter((flag) => !set.includes(flag)) }, add);
  }
  if (isTcpFlags(match['left']!)) {
    if (op === 'in') return setTcpFlags(form, { set: flagList(right), unset: [], any: true }, add);
    if (op === '!') return setTcpFlags(form, { set: [], unset: flagList(right) }, add);
    if (op === '==') {
      const set = flagList(right);
      return setTcpFlags(form, { set, unset: TCP_FLAGS.filter((flag) => !set.includes(flag)) }, add);
    }
    throw new Unsupported();
  }

  if (op !== '==' && op !== '!=' && op !== 'in' && !OPERATORS.includes(op as Operator)) throw new Unsupported();
  const negate = op === '!=';
  const equality = op === '==' || op === '!=' || op === 'in';
  const left = object(leftBody);

  if (leftKind === 'payload' && equality) {
    const protocol = string(left['protocol']);
    const field = string(left['field']);
    if ((protocol === 'ip' || protocol === 'ip6') && (field === 'saddr' || field === 'daddr')) {
      if (form.ipVersion !== undefined && form.ipVersion !== protocol) throw new Unsupported();
      form.ipVersion = protocol;
      const part = field === 'saddr' ? 'srcAddress' : 'dstAddress';
      add(part);
      form[part] = { value: value(right), negate };
      return;
    }
    if (PORT_PROTOCOLS.has(protocol) && (field === 'sport' || field === 'dport')) {
      setProtocol(form, protocol);
      const part = field === 'sport' ? 'srcPort' : 'dstPort';
      add(part);
      form[part] = { value: value(right), negate };
      return;
    }
    if ((protocol === 'icmp' || protocol === 'icmpv6') && field === 'type' && !negate) {
      setProtocol(form, protocol);
      add('icmpType');
      form.icmpType = value(right);
      return;
    }
    throw new Unsupported();
  }

  if (leftKind === 'meta') {
    const key = string(left['key']);
    if (key === 'l4proto' && op === '==' && typeof right === 'string') {
      setProtocol(form, right);
      form.protocolExplicit = true;
      add('protocol');
      return;
    }
    if (['iif', 'iifname', 'oif', 'oifname'].includes(key) && equality) {
      const part = key.startsWith('i') ? 'inInterface' : 'outInterface';
      add(part);
      form[part] = { value: interfaces(right), negate, byIndex: !key.endsWith('name') };
      return;
    }
    if (key === 'length') {
      add('length');
      form.length = { op: comparison(op), value: value(right) };
      return;
    }
    if (key === 'pkttype' && equality) {
      add('pktType');
      form.pktType = { value: value(right), negate };
      return;
    }
    if (key === 'mark') {
      add('mark');
      form.mark = { source: 'meta', op: comparison(op), value: mark(right) };
      return;
    }
    throw new Unsupported();
  }

  if (leftKind === 'ct') {
    const key = string(left['key']);
    if (key === 'state' && (op === 'in' || op === '==')) {
      add('ctState');
      form.ctState = Array.isArray(right) ? right.map(string) : [string(right)];
      return;
    }
    if (key === 'mark') {
      add('mark');
      form.mark = { source: 'ct', op: comparison(op), value: mark(right) };
      return;
    }
    throw new Unsupported();
  }

  // Reverse path filter: `fib saddr . iif oif missing`.
  if (leftKind === 'fib' && op === '==' && right === false) {
    const flags = left['flags'];
    if (left['result'] === 'oif' && Array.isArray(flags) && flags.length === 2 && flags[0] === 'saddr' && flags[1] === 'iif') {
      add('rpfilter');
      form.rpfilter = true;
      return;
    }
  }
  throw new Unsupported();
}

function parseStatement(form: RuleForm, kind: string, body: Json, family: Family, add: (part: RulePart) => void): void {
  switch (kind) {
    case 'counter':
      add('counter');
      if (typeof body === 'string') form.counterName = body;
      else form.counter = true;
      return;
    case 'limit':
      add('limit');
      form.limit = parseLimit(body);
      return;
    case 'ct count': {
      const count = object(body);
      only(count, ['val', 'inv']);
      add('connLimit');
      form.connLimit = { count: number(count['val']), over: count['inv'] === true };
      return;
    }
    case 'quota': {
      const quota = object(body);
      only(quota, ['val', 'val_unit', 'inv', 'used', 'used_unit']);
      add('quota');
      form.quota = { amount: number(quota['val']), unit: string(quota['val_unit']), over: quota['inv'] === true };
      return;
    }
    case 'set': {
      const update = object(body);
      only(update, ['op', 'elem', 'set', 'stmt']);
      const verb = string(update['op']);
      const stmts = update['stmt'];
      if ((verb !== 'add' && verb !== 'update') || !Array.isArray(stmts) || stmts.length !== 1) throw new Unsupported();
      const [stmtKind, stmtBody] = single(stmts[0]!);
      if (stmtKind !== 'limit') throw new Unsupported();
      const set = string(update['set']);
      if (!set.startsWith('@')) throw new Unsupported();
      let elem = update['elem']!;
      let timeout: string | undefined;
      const [elemKind, elemBody] = single(elem);
      if (elemKind === 'elem') {
        const wrapper = object(elemBody);
        only(wrapper, ['val', 'timeout']);
        elem = wrapper['val']!;
        if (wrapper['timeout'] !== undefined) timeout = duration(number(wrapper['timeout']));
      }
      add('keyedLimit');
      form.keyedLimit = { verb, set: set.slice(1), key: selector(elem), ...(timeout !== undefined && { timeout }), limit: parseLimit(stmtBody) };
      return;
    }
    case 'log': {
      const log = object(body);
      only(log, ['prefix', 'level', 'group']);
      add('log');
      form.log = {
        ...(log['prefix'] !== undefined && { prefix: string(log['prefix']) }),
        ...(log['level'] !== undefined && { level: string(log['level']) }),
        ...(log['group'] !== undefined && { group: number(log['group']) }),
      };
      return;
    }
    case 'mangle': {
      const mangle = object(body);
      const [targetKind, targetBody] = single(mangle['key']!);
      if ((targetKind !== 'meta' && targetKind !== 'ct') || object(targetBody)['key'] !== 'mark') throw new Unsupported();
      add('markSet');
      form.markSet = { target: targetKind, value: mark(mangle['value']!) };
      return;
    }
    case 'notrack':
      if (body !== null) throw new Unsupported();
      add('notrack');
      form.notrack = true;
      return;
    case 'vmap': {
      const vmap = object(body);
      only(vmap, ['key', 'data']);
      const key = selector(vmap['key']!);
      const data = vmap['data']!;
      if (typeof data === 'string') {
        if (!data.startsWith('@')) throw new Unsupported();
        return setAction(form, { kind: 'vmap', key, map: data }, add);
      }
      const [dataKind, elements] = single(data);
      if (dataKind !== 'set' || !Array.isArray(elements)) throw new Unsupported();
      const quoted = /ifname$/.test(key);
      const items = elements.map((element) => {
        if (!Array.isArray(element) || element.length !== 2) throw new Unsupported();
        const elementKey = value(element[0]!);
        return `${quoted ? quote(elementKey) : elementKey} : ${verdict(element[1]!)}`;
      });
      return setAction(form, { kind: 'vmap', key, map: `{ ${items.join(', ')} }` }, add);
    }
    case 'accept':
    case 'drop':
    case 'return':
    case 'continue':
    case 'masquerade':
      if (body !== null) throw new Unsupported();
      return setAction(form, { kind }, add);
    case 'reject': {
      if (body === null) return setAction(form, { kind: 'reject' }, add);
      const reject = object(body);
      const type = [reject['type'], reject['expr']].filter((part) => part !== undefined).map(string).join(' ');
      return setAction(form, type === DEFAULT_REJECT[family] ? { kind: 'reject' } : { kind: 'reject', with: type }, add);
    }
    case 'jump':
    case 'goto':
      return setAction(form, { kind, target: string(object(body)['target']) }, add);
    case 'snat':
    case 'dnat': {
      const nat = object(body);
      only(nat, ['family', 'addr', 'port']);
      const addr = value(nat['addr']!);
      const port = nat['port'] === undefined ? '' : `:${value(nat['port'])}`;
      const to = port !== '' && addr.includes(':') ? `[${addr}]${port}` : `${addr}${port}`;
      const natFamily = nat['family'] === undefined ? undefined : (string(nat['family']) as 'ip' | 'ip6');
      return setAction(form, { kind, to, ...(natFamily !== undefined && { family: natFamily }) }, add);
    }
    case 'redirect': {
      const redirect = object(body);
      only(redirect, ['port']);
      return setAction(form, { kind: 'redirect', port: value(redirect['port']!) }, add);
    }
    default:
      throw new Unsupported();
  }
}

function parseLimit(body: Json): Limit {
  const limit = object(body);
  only(limit, ['rate', 'burst', 'per', 'inv', 'rate_unit', 'burst_unit']);
  const unit = limit['rate_unit'] === undefined || limit['rate_unit'] === 'packets' ? undefined : string(limit['rate_unit']);
  const burst = limit['burst'] === undefined ? 0 : number(limit['burst']);
  return {
    rate: number(limit['rate']),
    per: string(limit['per']),
    ...(unit !== undefined && { unit }),
    ...(burst > 0 && { burst }),
    ...(burst > 0 && unit !== undefined && limit['burst_unit'] !== undefined && { burstUnit: string(limit['burst_unit']) }),
    ...(limit['inv'] === true && { over: true }),
  };
}

function setTcpFlags(form: RuleForm, flags: TcpFlags, add: (part: RulePart) => void): void {
  setProtocol(form, 'tcp');
  add('tcpFlags');
  form.tcpFlags = flags;
}

function isTcpFlags(json: Json): boolean {
  const [kind, body] = single(json);
  if (kind !== 'payload') return false;
  const payload = object(body);
  return payload['protocol'] === 'tcp' && payload['field'] === 'flags';
}

/** "syn", ["syn", "ack"], {"|": ["syn", "ack"]} or the bits as a number: the flags named. */
function flagList(json: Json): string[] {
  if (typeof json === 'string') return [known(json)];
  if (typeof json === 'number') {
    if (json <= 0 || json > 0xff) throw new Unsupported();
    return TCP_FLAGS.filter((_, bit) => (json & (1 << bit)) !== 0);
  }
  if (Array.isArray(json)) return json.map((flag) => known(string(flag)));
  const [kind, body] = single(json);
  if (kind !== '|' || !Array.isArray(body)) throw new Unsupported();
  return body.flatMap(flagList);
}

function known(flag: string): string {
  if (!TCP_FLAGS.includes(flag)) throw new Unsupported();
  return flag;
}

function setAction(form: RuleForm, action: RuleAction, add: (part: RulePart) => void): void {
  add('action');
  form.action = action;
}

function setProtocol(form: RuleForm, protocol: string): void {
  if (form.protocol !== undefined && form.protocol !== protocol) throw new Unsupported();
  form.protocol = protocol;
}

function comparison(op: string): Operator {
  if (!OPERATORS.includes(op as Operator)) throw new Unsupported();
  return op as Operator;
}

/** Marks as nft prints them: hexadecimal, eight digits. */
function mark(json: Json): string {
  if (typeof json !== 'number') throw new Unsupported();
  return `0x${json.toString(16).padStart(8, '0')}`;
}

/** Seconds the way nft prints durations: 90 is "1m30s". */
function duration(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds <= 0) throw new Unsupported();
  let rest = seconds;
  let text = '';
  for (const [unit, size] of [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ] as const) {
    if (rest >= size) {
      text += `${Math.floor(rest / size)}${unit}`;
      rest %= size;
    }
  }
  return text;
}

/** An expression that selects a packet field, as nft writes it: "tcp dport", "iifname", "ip saddr . tcp dport". */
function selector(json: Json): string {
  const [kind, body] = single(json);
  if (kind === 'payload') {
    const payload = object(body);
    return `${string(payload['protocol'])} ${string(payload['field'])}`;
  }
  if (kind === 'meta') {
    const key = string(object(body)['key']);
    return ['iif', 'iifname', 'oif', 'oifname'].includes(key) ? key : `meta ${key}`;
  }
  if (kind === 'ct') return `ct ${string(object(body)['key'])}`;
  if (kind === 'concat' && Array.isArray(body)) return body.map(selector).join(' . ');
  throw new Unsupported();
}

function verdict(json: Json): string {
  const [kind, body] = single(json);
  if (SIMPLE_VERDICTS.includes(kind) && body === null) return kind;
  if (kind === 'jump' || kind === 'goto') return `${kind} ${string(object(body)['target'])}`;
  throw new Unsupported();
}

/** A match's right side in nft syntax: addresses, prefixes, ranges, sets, set references. */
function value(right: Json): string {
  if (typeof right === 'string') return right;
  if (typeof right === 'number') return String(right);
  const [kind, body] = single(right);
  if (kind === 'prefix') {
    const prefix = object(body);
    return `${string(prefix['addr'])}/${number(prefix['len'])}`;
  }
  if (kind === 'range' && Array.isArray(body) && body.length === 2) return `${value(body[0]!)}-${value(body[1]!)}`;
  // nft prints a set of one element as the element, so a set here has several.
  if (kind === 'set' && Array.isArray(body)) return body.map(value).join(', ');
  throw new Unsupported();
}

/** Interface names, one or a set of them, without quotes: "eth0" or "eth0, wg0". */
function interfaces(right: Json): string {
  if (typeof right === 'string') return right;
  const [kind, body] = single(right);
  if (kind === 'set' && Array.isArray(body)) return body.map(string).join(', ');
  throw new Unsupported();
}

function single(json: Json): [string, Json] {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Unsupported();
  const keys = Object.keys(json);
  if (keys.length !== 1) throw new Unsupported();
  return [keys[0]!, json[keys[0]!]!];
}

function pair(json: Json): [Json, Json] {
  if (!Array.isArray(json) || json.length !== 2) throw new Unsupported();
  return [json[0]!, json[1]!];
}

function only(json: JsonObject, keys: readonly string[]): void {
  if (Object.keys(json).some((key) => !keys.includes(key))) throw new Unsupported();
}

function object(json: Json): JsonObject {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Unsupported();
  return json;
}

function string(json: Json | undefined): string {
  if (typeof json !== 'string') throw new Unsupported();
  return json;
}

function number(json: Json | undefined): number {
  if (typeof json !== 'number') throw new Unsupported();
  return json;
}
