// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { Family, Json } from './nft-json.ts';
import { emptyRule, type RuleForm } from './rule-form.ts';
import type { Ruleset } from './ruleset.ts';

/** How many packet log lines one read brings at most: the newest. */
export const PACKET_LOG_LINES = 1000;

/**
 * Reads the packets nftables' log statement wrote to the kernel log, run
 * as root where it can. It prints the host's time zone and boot time, to date
 * lines that carry only a local time or seconds since boot; then which source
 * it read, then the lines that may be such packets (they hold "IN="). The
 * source is the journal where journald runs, logread on OpenWrt, else the
 * first syslog file that holds such lines, else dmesg. $1: how many lines at
 * most; $2: a journal cursor to read on from, or nothing for the newest.
 */
export const PACKET_LOG_COMMAND = `max=$1
after=\${2-}
echo "zone $(date +%z)"
echo "boot $(awk '$1 == "btime" { print $2 }' /proc/stat 2>/dev/null)"
if [ -f /etc/openwrt_release ] && command -v logread >/dev/null 2>&1; then
	echo 'source logread'
	logread | grep -F 'IN=' | tail -n "$max"
	exit 0
fi
if [ -d /run/systemd/journal ] && command -v journalctl >/dev/null 2>&1; then
	echo 'source journal'
	if [ -n "$after" ]; then
		journalctl -k -q --no-pager -o json --output-fields=MESSAGE --after-cursor="$after" | grep -F 'IN=' | tail -n "$max"
	else
		journalctl -k -q --no-pager -o json --output-fields=MESSAGE -r | grep -F -m "$max" 'IN='
	fi
	exit 0
fi
for file in /var/log/kern.log /var/log/messages /var/log/syslog; do
	[ -r "$file" ] || continue
	found=$(tail -n 100000 "$file" | grep -F 'IN=' | tail -n "$max")
	[ -n "$found" ] || continue
	echo "source file $file"
	printf '%s\\n' "$found"
	exit 0
done
if dmesg >/dev/null 2>&1; then
	echo 'source dmesg'
	dmesg | grep -F 'IN=' | tail -n "$max"
	exit 0
fi
echo 'source none'
`;

/** Where the packet log was read from. */
export type PacketLogSource = { kind: 'journal' | 'logread' | 'dmesg' | 'none' } | { kind: 'file'; path: string };

/** One packet as nftables' log statement wrote it to the kernel log. */
export interface PacketLogEntry {
  /** When the kernel logged it, ISO 8601; undefined when the source gives no usable time. */
  time: string | undefined;
  /** The log statement's prefix, as given ("" for none). */
  prefix: string;
  /** Interfaces it came in and goes out on; "" for none. */
  in: string;
  out: string;
  mac?: string;
  src?: string;
  dst?: string;
  /** As the kernel names it: TCP, UDP, ICMP, ICMPv6, ARP, or a number. */
  protocol?: string;
  sport?: number;
  dport?: number;
  icmp?: { type: number; code: number };
  /** The packet's length in bytes. */
  length?: number;
  /** TCP flags as the kernel prints them, e.g. ["SYN"]. */
  tcpFlags: string[];
  /** The kernel's message, whole. */
  message: string;
}

export interface PacketLogRead {
  source: PacketLogSource;
  /** Newest first. */
  entries: PacketLogEntry[];
  /** journal only: the newest line's cursor, to read on from. */
  cursor?: string;
}

/** A read of the packet log, as the panel gets it. */
export interface PacketLogView extends PacketLogRead {
  /** true: the entries are the newest there are, in place of any before; false: they came after the cursor asked for. */
  complete: boolean;
  /** When hopdeck read it, ISO 8601. */
  readAt: string;
  /** What the host said while reading, such as a permission it lacked, as it said it. */
  stderr?: string;
  /** Read with the login user's rights: sudo allows nft only, or nothing. */
  asUser?: boolean;
}

/** What PACKET_LOG_COMMAND printed, as entries; lines that are no packet are left out. */
export function parsePacketLogRead(output: string, now: Date = new Date()): PacketLogRead {
  const lines = output.split('\n');
  let zone = 0;
  let boot: number | undefined;
  let source: PacketLogSource = { kind: 'none' };
  let at = 0;
  for (; at < lines.length; at += 1) {
    const line = lines[at]!;
    if (line.startsWith('zone ')) zone = zoneMinutes(line.slice(5));
    else if (line.startsWith('boot ')) boot = Number(line.slice(5)) || undefined;
    else if (line.startsWith('source ')) {
      source = sourceOf(line.slice(7));
      at += 1;
      break;
    }
  }

  const read: { entry: PacketLogEntry; cursor?: string; order: number }[] = [];
  for (const [index, line] of lines.slice(at).entries()) {
    if (line === '') continue;
    const timed = source.kind === 'journal' ? journalLine(line) : logLine(line, source, zone, boot, now);
    if (timed === undefined) continue;
    const entry = parsePacketMessage(timed.message, timed.time);
    if (entry !== undefined) read.push({ entry, ...(timed.cursor !== undefined && { cursor: timed.cursor }), order: index });
  }
  // Newest first; lines of the same moment keep the order they were logged in, reversed.
  read.sort((a, b) => (b.entry.time ?? '').localeCompare(a.entry.time ?? '') || (source.kind === 'journal' ? 0 : b.order - a.order));
  const cursor = read.find((item) => item.cursor !== undefined)?.cursor;
  return { source, entries: read.map((item) => item.entry), ...(cursor !== undefined && { cursor }) };
}

function sourceOf(text: string): PacketLogSource {
  if (text.startsWith('file ')) return { kind: 'file', path: text.slice(5) };
  return text === 'journal' || text === 'logread' || text === 'dmesg' ? { kind: text } : { kind: 'none' };
}

/** "+0200" as minutes east of UTC. */
function zoneMinutes(text: string): number {
  const match = /^([+-])(\d{2})(\d{2})$/.exec(text.trim());
  if (match === null) return 0;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

/** A line of `journalctl -o json`: MESSAGE is text, or its bytes where it is not UTF-8. */
function journalLine(line: string): { message: string; time: string | undefined; cursor?: string } | undefined {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof record !== 'object' || record === null) return undefined;
  const fields = record as Record<string, unknown>;
  const raw = fields['MESSAGE'];
  const message =
    typeof raw === 'string'
      ? raw
      : Array.isArray(raw) && raw.every((byte) => typeof byte === 'number')
        ? utf8(raw as number[])
        : undefined;
  if (message === undefined) return undefined;
  const micros = Number(fields['__REALTIME_TIMESTAMP']);
  const cursor = fields['__CURSOR'];
  return {
    message,
    time: Number.isFinite(micros) && micros > 0 ? new Date(micros / 1000).toISOString() : undefined,
    ...(typeof cursor === 'string' && { cursor }),
  };
}

/** UTF-8 bytes as text; where they are not UTF-8, bytes beyond ASCII show as U+FFFD. */
function utf8(bytes: readonly number[]): string {
  try {
    return decodeURIComponent(bytes.map((byte) => `%${(byte & 0xff).toString(16).padStart(2, '0')}`).join(''));
  } catch {
    return bytes.map((byte) => String.fromCharCode(byte < 0x80 ? byte : 0xfffd)).join('');
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A line of a syslog file, logread or dmesg: the time, and the kernel's
 * message after "kernel: " and the "[seconds since boot]" printk may add.
 */
function logLine(line: string, source: PacketLogSource, zone: number, boot: number | undefined, now: Date): { message: string; time: string | undefined; cursor?: string } | undefined {
  let head = '';
  let rest = line;
  if (source.kind !== 'dmesg') {
    const kernel = line.indexOf('kernel: ');
    if (kernel === -1) return undefined;
    head = line.slice(0, kernel);
    rest = line.slice(kernel + 'kernel: '.length);
  }
  const uptime = /^\[\s*(\d+(?:\.\d+)?)\]\s?/.exec(rest);
  if (uptime !== null) rest = rest.slice(uptime[0].length);
  const time =
    wallTime(head, zone, now) ?? (uptime !== null && boot !== undefined ? new Date((boot + Number(uptime[1])) * 1000).toISOString() : undefined);
  return { message: rest, time };
}

/** The time at the start of a syslog or logread line, in the host's zone where the line has none. */
function wallTime(head: string, zone: number, now: Date): string | undefined {
  // rsyslog's RFC 3339: 2026-10-16T10:00:00.123456+02:00
  const iso = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\s/.exec(head);
  if (iso !== null) {
    const parsed = new Date(iso[1]!);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  // logread: Thu Oct 16 10:00:00 2026; BSD syslog: Oct 16 10:00:00, without the year.
  const local = /^(?:[A-Z][a-z]{2} )?([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?: (\d{4}))?\s/.exec(head);
  if (local === null) return undefined;
  const month = MONTHS.indexOf(local[1]!);
  if (month === -1) return undefined;
  const at = (year: number) => Date.UTC(year, month, Number(local[2]), Number(local[3]), Number(local[4]), Number(local[5])) - zone * 60_000;
  let year = local[6] !== undefined ? Number(local[6]) : now.getUTCFullYear();
  // A line from December read in January belongs to the year before.
  if (local[6] === undefined && at(year) > now.getTime() + 86_400_000) year -= 1;
  return new Date(at(year)).toISOString();
}

const TCP_FLAG_NAMES = new Set(['CWR', 'ECE', 'URG', 'ACK', 'PSH', 'RST', 'SYN', 'FIN']);

/**
 * The fields of a packet the kernel logged for a log statement: "PREFIXIN=eth0
 * OUT= MAC=… SRC=… DST=… LEN=60 … PROTO=TCP SPT=51234 DPT=22 … SYN URGP=0".
 * Undefined for any other kernel message. An ICMP error carries the packet it
 * is about in brackets; that one is left out of the fields.
 */
export function parsePacketMessage(message: string, time?: string): PacketLogEntry | undefined {
  const match = /^(.*?)IN=(\S*) OUT=(\S*)(?: (.*))?$/s.exec(message);
  if (match === null) return undefined;
  const entry: PacketLogEntry = { time, prefix: match[1]!, in: match[2]!, out: match[3]!, tcpFlags: [], message };
  const rest = (match[4] ?? '').replace(/\[.*\]/s, ' ').replace(/OPT \([^)]*\)/g, ' ');
  let transport = false;
  for (const token of rest.split(/\s+/)) {
    if (token === '') continue;
    const equals = token.indexOf('=');
    if (equals === -1) {
      if (token === 'ARP') entry.protocol = 'ARP';
      else if (transport && entry.protocol === 'TCP' && TCP_FLAG_NAMES.has(token)) entry.tcpFlags.push(token);
      continue;
    }
    const key = token.slice(0, equals);
    const value = token.slice(equals + 1);
    const number = Number(value);
    switch (key) {
      case 'MAC':
        if (value !== '') entry.mac = value;
        break;
      case 'SRC':
      case 'IPSRC':
        entry.src ??= value;
        break;
      case 'DST':
      case 'IPDST':
        entry.dst ??= value;
        break;
      case 'LEN':
        if (!transport && Number.isInteger(number)) entry.length ??= number;
        break;
      case 'PROTO':
        entry.protocol = value;
        transport = true;
        break;
      case 'SPT':
        if (transport && Number.isInteger(number)) entry.sport ??= number;
        break;
      case 'DPT':
        if (transport && Number.isInteger(number)) entry.dport ??= number;
        break;
      case 'TYPE':
        if (transport && Number.isInteger(number)) entry.icmp = { type: number, code: entry.icmp?.code ?? 0 };
        break;
      case 'CODE':
        if (transport && entry.icmp !== undefined && Number.isInteger(number)) entry.icmp = { ...entry.icmp, code: number };
        break;
    }
  }
  return entry;
}

/** Entries that tell the same within one second, shown as one line with their count. */
export interface PacketLogGroup {
  key: string;
  /** Newest first; the first stands for the group. */
  entries: PacketLogEntry[];
}

/**
 * Folds entries that are the same packet again within one second: the same
 * prefix, interfaces, protocol, addresses, destination port, ICMP type and
 * TCP flags. The source port is left out, as a new connection gets a new one.
 * Entries without a time stay apart. The order of the newest of each stays.
 */
export function groupPacketLog(entries: readonly PacketLogEntry[]): PacketLogGroup[] {
  const groups = new Map<string, PacketLogGroup>();
  for (const [index, entry] of entries.entries()) {
    const second = entry.time?.slice(0, 19);
    const key =
      second === undefined
        ? `#${index}`
        : [second, entry.prefix, entry.in, entry.out, entry.protocol, entry.src, entry.dst, entry.dport, entry.icmp && `${entry.icmp.type}/${entry.icmp.code}`, entry.tcpFlags.join(',')].join('|');
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { key, entries: [entry] });
    else group.entries.push(entry);
  }
  return [...groups.values()];
}

/** A rule that writes packets to the kernel log, and what it then does with them. */
export interface LoggingRule {
  family: Family;
  table: string;
  chain: string;
  handle: number;
  prefix: string;
  /**
   * What the packet meets after the log: the rule's verdict ("drop", "jump
   * other"), or "policy drop" for the last rule of a base chain without one.
   * Undefined when it goes on to the next rule.
   */
  verdict?: string;
}

/**
 * Rules with a log statement that writes to the kernel log, by prefix. A log
 * statement with a group goes to nflog instead, so it is left out.
 */
export function loggingRules(ruleset: Ruleset): Map<string, LoggingRule[]> {
  const found = new Map<string, LoggingRule[]>();
  for (const table of ruleset.tables) {
    for (const { chain, rules } of table.chains) {
      for (const [index, rule] of rules.entries()) {
        const log = rule.expr.map((statement) => field(statement, 'log')).find((body) => body !== undefined);
        if (log === undefined || (typeof log === 'object' && log !== null && !Array.isArray(log) && log['group'] !== undefined)) continue;
        const prefix = typeof log === 'object' && log !== null && !Array.isArray(log) && typeof log['prefix'] === 'string' ? log['prefix'] : '';
        const last = index === rules.length - 1 && chain.hook !== undefined;
        const verdict = ruleVerdict(rule.expr) ?? (last ? `policy ${chain.policy ?? 'accept'}` : undefined);
        const logging: LoggingRule = { family: chain.family, table: chain.table, chain: chain.name, handle: rule.handle, prefix, ...(verdict !== undefined && { verdict }) };
        found.set(prefix, [...(found.get(prefix) ?? []), logging]);
      }
    }
  }
  return found;
}

const VERDICTS = ['accept', 'drop', 'reject', 'return', 'continue', 'queue', 'masquerade', 'snat', 'dnat', 'redirect'];

function ruleVerdict(expr: readonly Json[]): string | undefined {
  for (const statement of expr) {
    for (const verdict of VERDICTS) if (field(statement, verdict) !== undefined) return verdict;
    for (const jump of ['jump', 'goto']) {
      const target = field(statement, jump);
      if (typeof target === 'object' && target !== null && !Array.isArray(target) && typeof target['target'] === 'string') return `${jump} ${target['target']}`;
    }
    if (field(statement, 'vmap') !== undefined) return 'vmap';
  }
  return undefined;
}

/** The value under `key` of a statement object, or undefined. */
function field(statement: Json, key: string): Json | undefined {
  if (typeof statement !== 'object' || statement === null || Array.isArray(statement) || !(key in statement)) return undefined;
  return statement[key] ?? null;
}

/** The longest prefix the kernel keeps for a log statement (NF_LOG_PREFIXLEN, less its NUL). */
export const MAX_LOG_PREFIX = 127;

/** The prefix of the rule that logs what a base chain drops: one per chain, so a line names its chain. */
export function dropLogPrefix(family: Family, table: string, chain: string): string {
  const candidates = [`hopdeck drop ${family} ${table} ${chain}: `, `hopdeck drop ${table} ${chain}: `, `hopdeck drop ${chain}: `];
  return candidates.find((prefix) => prefix.length <= MAX_LOG_PREFIX) ?? 'hopdeck drop: ';
}

/** How many dropped packets a second the drop log writes at most, and the burst it allows. */
export const DROP_LOG_LIMIT = { rate: 50, burst: 100 };

/**
 * The rule that logs what a base chain's policy drops, put last in the chain:
 * every packet counted, up to DROP_LOG_LIMIT a second logged, so a flood
 * cannot fill the host's log, while the counter still says how many there
 * were. Without a verdict, the policy then drops the packet as before.
 */
export function dropLogRule(prefix: string): RuleForm {
  return {
    ...emptyRule(),
    action: { kind: 'none' },
    counter: true,
    limit: { rate: DROP_LOG_LIMIT.rate, per: 'second', burst: DROP_LOG_LIMIT.burst },
    log: { prefix },
    order: ['counter', 'limit', 'log'],
  };
}
