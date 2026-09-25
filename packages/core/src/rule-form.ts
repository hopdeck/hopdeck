import type { Family, Json, NftRule } from './nft-json.ts';

/**
 * A rule as the form editor sees it. Values are nft syntax as typed ("10.0.0.0/24",
 * "@admins", "1000-2000"); several values are separated by commas ("80, 443")
 * and get the braces of an anonymous set when rendered. nft on the host
 * validates them.
 */
export interface RuleForm {
  /** Layer 4 protocol. Ports and ICMP types need one; on its own it is `meta l4proto`. */
  protocol?: string;
  /** The rule also says `meta l4proto`, not only through ports or ICMP types. */
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
  limit?: { rate: number; per: string; burst?: number };
  counter?: boolean;
  counterName?: string;
  log?: { prefix?: string; level?: string };
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

export type RuleAction =
  | { kind: 'none' | 'accept' | 'drop' | 'return' | 'continue' | 'masquerade' }
  | { kind: 'reject'; with?: string }
  | { kind: 'jump' | 'goto'; target: string }
  | { kind: 'snat' | 'dnat'; family?: 'ip' | 'ip6'; to: string }
  | { kind: 'redirect'; port: string };

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
  | 'limit'
  | 'counter'
  | 'log'
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
  'limit',
  'counter',
  'log',
  'action',
];

const PORT_PROTOCOLS = new Set(['tcp', 'udp', 'udplite', 'sctp', 'dccp']);
// nft prints ct states in bit order.
const CT_STATES = ['invalid', 'established', 'related', 'new', 'untracked'];

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
    default:
      return form[part] !== undefined;
  }
}

/** Ports and ICMP types carry the protocol themselves ("tcp dport 22"). */
function usesProtocol(form: RuleForm): boolean {
  return form.srcPort !== undefined || form.dstPort !== undefined || form.icmpType !== undefined;
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
    case 'limit': {
      const { rate, per, burst } = form.limit!;
      return `limit rate ${rate}/${per}${burst !== undefined ? ` burst ${burst} packets` : ''}`;
    }
    case 'counter':
      return form.counterName !== undefined ? `counter name ${quote(form.counterName)}` : 'counter';
    case 'log': {
      const { prefix, level } = form.log!;
      return ['log', prefix !== undefined && `prefix ${quote(prefix)}`, level !== undefined && `level ${level}`].filter(Boolean).join(' ');
    }
    case 'action':
      return renderAction(form.action, family);
  }
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
    default:
      return action.kind;
  }
}

function quote(text: string): string {
  return `"${text}"`;
}

function withoutCounterValues(text: string): string {
  return text.replace(/counter packets \d+ bytes \d+/g, 'counter');
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
  const op = match['op'];
  if (op !== '==' && op !== '!=' && op !== 'in') throw new Unsupported();
  const negate = op === '!=';
  const [leftKind, leftBody] = single(match['left']!);
  const left = object(leftBody);
  const right = match['right']!;

  if (leftKind === 'payload') {
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
    if (key === 'l4proto' && !negate && typeof right === 'string') {
      setProtocol(form, right);
      form.protocolExplicit = true;
      add('protocol');
      return;
    }
    if (['iif', 'iifname', 'oif', 'oifname'].includes(key)) {
      const part = key.startsWith('i') ? 'inInterface' : 'outInterface';
      add(part);
      form[part] = { value: interfaces(right), negate, byIndex: !key.endsWith('name') };
      return;
    }
    throw new Unsupported();
  }

  if (leftKind === 'ct' && left['key'] === 'state' && !negate) {
    add('ctState');
    form.ctState = Array.isArray(right) ? right.map(string) : [string(right)];
    return;
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
    case 'limit': {
      const limit = object(body);
      if (Object.keys(limit).some((key) => !['rate', 'burst', 'per'].includes(key))) throw new Unsupported();
      add('limit');
      form.limit = { rate: number(limit['rate']), per: string(limit['per']), ...(limit['burst'] !== undefined && { burst: number(limit['burst']) }) };
      return;
    }
    case 'log': {
      const log = object(body);
      if (Object.keys(log).some((key) => !['prefix', 'level'].includes(key))) throw new Unsupported();
      add('log');
      form.log = {
        ...(log['prefix'] !== undefined && { prefix: string(log['prefix']) }),
        ...(log['level'] !== undefined && { level: string(log['level']) }),
      };
      return;
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
      if (Object.keys(nat).some((key) => !['family', 'addr', 'port'].includes(key))) throw new Unsupported();
      const addr = value(nat['addr']!);
      const port = nat['port'] === undefined ? '' : `:${value(nat['port'])}`;
      const to = port !== '' && addr.includes(':') ? `[${addr}]${port}` : `${addr}${port}`;
      const natFamily = nat['family'] === undefined ? undefined : (string(nat['family']) as 'ip' | 'ip6');
      return setAction(form, { kind, to, ...(natFamily !== undefined && { family: natFamily }) }, add);
    }
    case 'redirect': {
      const redirect = object(body);
      if (Object.keys(redirect).some((key) => key !== 'port')) throw new Unsupported();
      return setAction(form, { kind: 'redirect', port: value(redirect['port']!) }, add);
    }
    default:
      throw new Unsupported();
  }
}

function setAction(form: RuleForm, action: RuleAction, add: (part: RulePart) => void): void {
  add('action');
  form.action = action;
}

function setProtocol(form: RuleForm, protocol: string): void {
  if (form.protocol !== undefined && form.protocol !== protocol) throw new Unsupported();
  form.protocol = protocol;
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
