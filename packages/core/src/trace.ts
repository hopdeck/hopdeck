/**
 * Packet tracing: nft marks packets with `meta nftrace set 1`, and
 * `nft -a monitor trace` prints one line per chain and rule they pass. nft
 * prints these lines as text even with -j, so they are parsed here.
 */

import { emptyRule, renderRule, type RuleForm } from './rule-form.ts';

/** Tables hopdeck creates to mark the packets it traces. */
export const TRACE_TABLE_PREFIX = 'hopdeck_trace_';

/** Which packets to trace; every field is optional. */
export interface TraceFilter {
  protocol?: string;
  saddr?: string;
  daddr?: string;
  sport?: string;
  dport?: string;
  /** Input interface; packets the host sends itself have none. */
  iif?: string;
}

export const TRACE_PROTOCOLS = ['tcp', 'udp', 'icmp', 'icmpv6', 'sctp', 'udplite', 'dccp', 'gre', 'esp', 'ah'];
const PORT_PROTOCOLS = ['tcp', 'udp', 'sctp', 'udplite', 'dccp'];
// Values only: addresses, prefixes, ranges, lists, set references. No spaces but after commas,
// so a value cannot smuggle in a statement such as a verdict.
const VALUE = /^[\w.:/@*\[\]{}-]+(?:,\s*[\w.:/@*\[\]{}-]+)*$/;

/** Why the filter cannot be used; undefined when it can. */
export function traceFilterProblem(filter: TraceFilter): string | undefined {
  if (filter.protocol !== undefined && !TRACE_PROTOCOLS.includes(filter.protocol)) return `unknown protocol "${filter.protocol}"`;
  for (const key of ['saddr', 'daddr', 'sport', 'dport', 'iif'] as const) {
    const value = filter[key]?.trim();
    if (value !== undefined && value !== '' && !VALUE.test(value)) return `"${value}" is not a value nft can match (${key})`;
  }
  if ((filter.sport || filter.dport) && !PORT_PROTOCOLS.includes(filter.protocol ?? '')) return 'ports need the protocol tcp, udp, sctp, udplite or dccp';
  const versions = new Set([filter.saddr, filter.daddr].filter(Boolean).map((address) => (address!.includes(':') ? 'ip6' : 'ip')));
  if (versions.size > 1) return 'the source and destination addresses must both be IPv4 or both IPv6';
  return undefined;
}

/**
 * The table that marks matching packets for tracing: chains before every other
 * at prerouting (arriving and forwarded packets) and output (sent by the host),
 * with policy accept, so it never changes what happens to a packet.
 */
export function traceTable(name: string, filter: TraceFilter, perSecond: number): string {
  const value = (text: string | undefined) => (text?.trim() ? { value: text.trim(), negate: false } : undefined);
  const address = filter.saddr?.trim() || filter.daddr?.trim();
  const form: RuleForm = {
    ...emptyRule(),
    action: { kind: 'none' },
    ...(filter.protocol !== undefined && { protocol: filter.protocol, protocolExplicit: !(filter.sport || filter.dport) }),
    ...(address !== undefined && { ipVersion: address.includes(':') ? ('ip6' as const) : ('ip' as const) }),
  };
  const matches = (withInterface: boolean): RuleForm => ({
    ...form,
    ...(value(filter.saddr) && { srcAddress: value(filter.saddr)! }),
    ...(value(filter.daddr) && { dstAddress: value(filter.daddr)! }),
    ...(value(filter.sport) && { srcPort: value(filter.sport)! }),
    ...(value(filter.dport) && { dstPort: value(filter.dport)! }),
    ...(withInterface && value(filter.iif) && { inInterface: { ...value(filter.iif)!, byIndex: false } }),
  });
  const mark = (rule: RuleForm) => [renderRule(rule, 'inet'), `limit rate ${perSecond}/second meta nftrace set 1`].filter(Boolean).join(' ');
  const chain = (hook: string, rule: string | undefined) =>
    [`\tchain ${hook === 'prerouting' ? 'pre' : 'out'} {`, `\t\ttype filter hook ${hook} priority -350; policy accept;`, ...(rule === undefined ? [] : [`\t\t${rule}`]), '\t}'];
  // Packets the host sends have no input interface; with one in the filter, only arriving packets match.
  const out = filter.iif?.trim() ? undefined : mark(matches(false));
  return [`table inet ${name} {`, ...chain('prerouting', mark(matches(true))), ...chain('output', out), '}', ''].join('\n');
}

export interface TraceEvent {
  /** The same for every line about one packet on one pass through the hooks. */
  id: string;
  family: string;
  table: string;
  chain: string;
  kind: 'packet' | 'rule' | 'policy' | 'other';
  /** For `packet`: the fields nft printed, e.g. `iif "eth0" ip saddr 10.0.0.1 ...`. */
  packet?: string;
  /** For `rule`: the rule as nft printed it, without the handle. */
  rule?: string;
  handle?: number;
  /** For `rule` and `policy`: accept, drop, continue, jump NAME, ... */
  verdict?: string;
  raw: string;
}

export interface PacketSummary {
  /** The IP header's identification; the halves of one packet sent over lo share it. */
  ipId?: string;
  iif?: string;
  oif?: string;
  saddr?: string;
  daddr?: string;
  protocol?: string;
  sport?: string;
  dport?: string;
  tcpFlags?: string;
  icmpType?: string;
  length?: string;
}

export interface TracedPacket {
  /** Unique within the trace. */
  key: string;
  /** nft's trace id; the kernel may give it to a later packet again. */
  id: string;
  /** How hopdeck caught it: arriving (prerouting) or sent by the host itself (output). */
  direction: 'in' | 'out' | undefined;
  summary: PacketSummary;
  /** The chains and rules it passed, hopdeck's own tracing table left out. */
  steps: TraceEvent[];
  /**
   * drop as soon as any chain dropped it; accept when every chain that decided
   * let it through, or when no chain saw it at all (nothing stops a packet by default).
   */
  verdict: 'accept' | 'drop' | undefined;
  /** The step that dropped it, or the last one that accepted it; undefined when no chain decided. */
  decidedBy: TraceEvent | undefined;
}

const PREFIX = /^trace id (\S+) (\S+) (\S+) (\S+) (.*)$/;
const RULE = /^rule (.*?)(?: # handle (\d+))? \(verdict (.+)\)$/;

/** One line of `nft -a monitor trace`; undefined for anything else. */
export function parseTraceLine(line: string): TraceEvent | undefined {
  const match = PREFIX.exec(line.trimEnd());
  if (match === null) return undefined;
  const [, id, family, table, chain, rest] = match as unknown as [string, string, string, string, string, string];
  const base = { id, family, table: unquote(table), chain: unquote(chain), raw: line.trimEnd() };
  if (rest.startsWith('packet: ')) return { ...base, kind: 'packet', packet: rest.slice('packet: '.length).trim() };
  const rule = RULE.exec(rest);
  if (rule !== null) {
    return { ...base, kind: 'rule', rule: rule[1]!, ...(rule[2] !== undefined && { handle: Number(rule[2]) }), verdict: rule[3]! };
  }
  if (rest.startsWith('policy ')) return { ...base, kind: 'policy', verdict: rest.slice('policy '.length).trim() };
  return { ...base, kind: 'other' };
}

/**
 * The lines of a trace, one entry per pass of a packet through the hooks, in
 * the order they began. The kernel derives trace ids from the packet buffer's
 * address, so a later packet can get the id of an earlier one (on lo, a ping
 * and its reply often do). A pass begins where hopdeck's tracing chain, which runs
 * before all others, first reports the packet; that starts a new entry even
 * for an id seen before.
 */
export function groupTrace(lines: readonly string[]): TracedPacket[] {
  const passes: { id: string; events: TraceEvent[] }[] = [];
  const open = new Map<string, { id: string; events: TraceEvent[] }>();
  for (const line of lines) {
    const event = parseTraceLine(line);
    if (event === undefined) continue;
    let pass = open.get(event.id);
    const begins = event.kind === 'packet' && event.table.startsWith(TRACE_TABLE_PREFIX);
    if (pass === undefined || begins) {
      pass = { id: event.id, events: [] };
      passes.push(pass);
      open.set(event.id, pass);
    }
    pass.events.push(event);
  }
  return passes.map(({ id, events }, index) => {
    const own = events.find((event) => event.table.startsWith(TRACE_TABLE_PREFIX));
    const steps = events.filter((event) => !event.table.startsWith(TRACE_TABLE_PREFIX));
    const first = events.find((event) => event.kind === 'packet');
    const deciding = steps.filter((event) => event.verdict !== undefined && ['accept', 'drop'].includes(event.verdict));
    const drop = deciding.find((event) => event.verdict === 'drop');
    const decidedBy = drop ?? deciding.at(-1);
    // Seen by hopdeck's chain but by no chain of the firewall: nothing held it back.
    const passed = own !== undefined && steps.length === 0;
    return {
      key: `${id}#${index}`,
      id,
      direction: own === undefined ? undefined : own.chain === 'out' ? 'out' : 'in',
      summary: first?.packet === undefined ? {} : summarize(first.packet),
      steps,
      verdict: (decidedBy?.verdict as 'accept' | 'drop' | undefined) ?? (passed ? 'accept' : undefined),
      decidedBy,
    };
  });
}

/** The fields that tell packets apart, out of nft's description of one. */
export function summarize(packet: string): PacketSummary {
  const field = (pattern: RegExp) => pattern.exec(packet)?.[1];
  const protocol = field(/\bip protocol (\S+)/) ?? field(/\bip6 nexthdr (\S+)/) ?? field(/\b(tcp|udp|icmpv6|icmp|sctp) /);
  const l4 = protocol === 'tcp' || protocol === 'udp' || protocol === 'sctp' ? protocol : undefined;
  const summary: PacketSummary = {
    ipId: field(/\bip id (\d+)/),
    iif: field(/\biif "([^"]*)"/),
    oif: field(/\boif "([^"]*)"/),
    saddr: field(/\bip6? saddr (\S+)/),
    daddr: field(/\bip6? daddr (\S+)/),
    protocol,
    sport: l4 === undefined ? undefined : field(new RegExp(`\\b${l4} sport (\\S+)`)),
    dport: l4 === undefined ? undefined : field(new RegExp(`\\b${l4} dport (\\S+)`)),
    tcpFlags: field(/\btcp flags == (\S+)/),
    icmpType: field(/\bicmp(?:v6)? type (\S+)/),
    length: field(/\bip length (\d+)/) ?? field(/\bip6 length (\d+)/),
  };
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined)) as PacketSummary;
}

function unquote(text: string): string {
  return text.replace(/^"(.*)"$/, '$1');
}
