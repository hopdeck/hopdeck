// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { isIpAddress } from '../firewall/port-forward.ts';
import type { FirewallIpSet, FirewallRedirect, FirewallRule, FirewallZone, OpenWrtFirewall } from './firewall.ts';
import { sectionChanges } from './uci-edit.ts';
import type { UciChange, UciValue } from './uci.ts';

/**
 * The forms of the OpenWrt firewall and the UCI options they write, as LuCI
 * writes them: a flag that is off and a list that is empty leave no option.
 * Options a form does not show stay as they are.
 */

export const ZONE_POLICIES = ['ACCEPT', 'REJECT', 'DROP'] as const;
export const RULE_TARGETS = ['ACCEPT', 'REJECT', 'DROP'] as const;
/** Protocols with ports. */
const PORT_PROTOCOLS = ['tcp', 'udp', 'sctp', 'udplite', 'dccp'];

export interface ZoneForm {
  name: string;
  /** Networks of /etc/config/network in the zone. */
  networks: string[];
  input: string;
  output: string;
  forward: string;
  masquerade: boolean;
  mtuFix: boolean;
  log: boolean;
  /** Zones it may forward to whatever their forward policy: its forwardings. */
  forwardTo: string[];
}

export interface TrafficRuleForm {
  name: string;
  enabled: boolean;
  /** "" for both. */
  family: '' | 'ipv4' | 'ipv6';
  /** None means tcp and udp, as fw4 takes it. */
  protocols: string[];
  /** A zone, "*" for any, or "" for the router itself (what it sends). */
  src: string;
  srcIps: string[];
  srcPort: string;
  /** A zone, "*" for any, or "" for the router itself (what it receives). */
  dest: string;
  destIps: string[];
  destPort: string;
  icmpTypes: string[];
  /** An IP set the packet must be in, "!name" for not in; "" for none. */
  ipset: string;
  /** "" leaves it to fw4, for a rule that does not say. */
  target: string;
}

/** A port forward: DNAT from a zone, usually wan, to an address in another. */
export interface RedirectForm {
  name: string;
  enabled: boolean;
  protocols: string[];
  /** The zone the connections come from. */
  src: string;
  /** The port, or range, on the router. */
  srcDport: string;
  /** Only these sources may use it; none for any. */
  srcIps: string[];
  /** The zone and address they go to, and the port there; none for the same port. */
  dest: string;
  destIp: string;
  destPort: string;
  /** NAT loopback (hairpin). */
  reflection: boolean;
}

export function zoneForm(firewall: OpenWrtFirewall, zone: FirewallZone | undefined): ZoneForm {
  if (zone === undefined) {
    return { name: '', networks: [], input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', masquerade: false, mtuFix: false, log: false, forwardTo: [] };
  }
  return {
    name: zone.name,
    networks: zone.networks,
    input: zone.input ?? firewall.defaults?.input ?? 'REJECT',
    output: zone.output ?? firewall.defaults?.output ?? 'ACCEPT',
    forward: zone.forward ?? firewall.defaults?.forward ?? 'REJECT',
    masquerade: zone.masquerade,
    mtuFix: zone.mtuFix,
    log: zone.log,
    forwardTo: firewall.forwardings.filter((forwarding) => forwarding.src === zone.name).map((forwarding) => forwarding.dest),
  };
}

export function trafficRuleForm(rule: FirewallRule | undefined): TrafficRuleForm {
  if (rule === undefined) {
    return { name: '', enabled: true, family: '', protocols: ['tcp'], src: 'wan', srcIps: [], srcPort: '', dest: '', destIps: [], destPort: '', icmpTypes: [], ipset: '', target: 'ACCEPT' };
  }
  const family = rule.family === 'ipv4' || rule.family === 'ipv6' ? rule.family : '';
  return {
    name: rule.name ?? '',
    enabled: rule.enabled,
    family,
    protocols: rule.protocols,
    src: rule.src ?? '',
    srcIps: rule.srcIps,
    srcPort: rule.srcPort ?? '',
    dest: rule.dest ?? '',
    destIps: rule.destIps,
    destPort: rule.destPort ?? '',
    icmpTypes: rule.icmpTypes,
    ipset: rule.ipset ?? '',
    target: rule.target ?? '',
  };
}

export function redirectForm(redirect: FirewallRedirect | undefined, zones: readonly string[]): RedirectForm {
  if (redirect === undefined) {
    const inside = zones.find((zone) => zone === 'lan') ?? zones.find((zone) => zone !== 'wan') ?? '';
    return { name: '', enabled: true, protocols: ['tcp'], src: zones.includes('wan') ? 'wan' : (zones[0] ?? ''), srcDport: '', srcIps: [], dest: inside, destIp: '', destPort: '', reflection: true };
  }
  return {
    name: redirect.name ?? '',
    enabled: redirect.enabled,
    protocols: redirect.protocols.length > 0 ? redirect.protocols : ['tcp', 'udp'],
    src: redirect.src ?? '',
    srcDport: redirect.srcDport ?? '',
    srcIps: listOf(redirect.section.options['src_ip']),
    dest: redirect.dest ?? '',
    destIp: redirect.destIp ?? '',
    destPort: redirect.destPort ?? '',
    reflection: redirect.reflection,
  };
}

/** The zone's own options, its forwardings, and for a new name the rules, forwardings and port forwards that name it. */
export function zoneChanges(firewall: OpenWrtFirewall, zone: FirewallZone | undefined, form: ZoneForm, ref: string): UciChange[] {
  const changes = sectionChanges(
    zone?.section,
    'zone',
    {
      name: form.name,
      network: form.networks.length > 0 ? form.networks : undefined,
      input: form.input,
      output: form.output,
      forward: form.forward,
      masq: flag(form.masquerade),
      mtu_fix: flag(form.mtuFix),
      log: flag(form.log),
    },
    ref,
  );
  if (zone !== undefined && zone.name !== form.name) changes.push(...renameZone(firewall, zone.name, form.name));
  // Forwardings from the zone, under the name it ends up with.
  const from = firewall.forwardings.filter((forwarding) => forwarding.src === (zone?.name ?? form.name));
  for (const forwarding of from) {
    if (!form.forwardTo.includes(forwarding.dest)) changes.push({ kind: 'delete', section: forwarding.section.name });
  }
  let n = 0;
  for (const dest of form.forwardTo) {
    if (from.some((forwarding) => forwarding.dest === dest)) continue;
    n += 1;
    changes.push({ kind: 'add', type: 'forwarding', ref: `${ref}-fwd-${n}`, values: { src: form.name, dest } });
  }
  return changes;
}

/**
 * Removing a zone takes its forwardings along; rules and port forwards that
 * name it would be left pointing nowhere, so they are named instead and the
 * zone stays until they are changed or removed.
 */
export function deleteZoneChanges(firewall: OpenWrtFirewall, zone: FirewallZone): { changes: UciChange[]; usedBy: string[] } {
  const usedBy = [
    ...firewall.rules.filter((rule) => rule.src === zone.name || rule.dest === zone.name).map((rule) => rule.name ?? rule.section.name),
    ...firewall.redirects.filter((redirect) => redirect.src === zone.name || redirect.dest === zone.name).map((redirect) => redirect.name ?? redirect.section.name),
  ];
  if (usedBy.length > 0) return { changes: [], usedBy };
  const forwardings = firewall.forwardings.filter((forwarding) => forwarding.src === zone.name || forwarding.dest === zone.name);
  return {
    changes: [{ kind: 'delete', section: zone.section.name }, ...forwardings.map((forwarding): UciChange => ({ kind: 'delete', section: forwarding.section.name }))],
    usedBy: [],
  };
}

export function trafficRuleChanges(rule: FirewallRule | undefined, form: TrafficRuleForm, ref: string): UciChange[] {
  const icmp = form.protocols.some((protocol) => protocol === 'icmp' || protocol === 'icmpv6' || protocol === 'ipv6-icmp');
  return sectionChanges(
    rule?.section,
    'rule',
    {
      name: form.name.trim() === '' ? undefined : form.name.trim(),
      enabled: form.enabled ? undefined : '0',
      family: form.family === '' ? undefined : form.family,
      proto: form.protocols.length > 0 ? form.protocols : undefined,
      src: form.src === '' ? undefined : form.src,
      src_ip: form.srcIps.length > 0 ? form.srcIps : undefined,
      src_port: form.srcPort.trim() === '' ? undefined : form.srcPort.trim(),
      dest: form.dest === '' ? undefined : form.dest,
      dest_ip: form.destIps.length > 0 ? form.destIps : undefined,
      dest_port: form.destPort.trim() === '' ? undefined : form.destPort.trim(),
      icmp_type: icmp && form.icmpTypes.length > 0 ? form.icmpTypes : undefined,
      ipset: form.ipset.trim() === '' ? undefined : form.ipset.trim(),
      target: form.target === '' ? undefined : form.target,
    },
    ref,
  );
}

export function redirectChanges(redirect: FirewallRedirect | undefined, form: RedirectForm, ref: string): UciChange[] {
  const options = redirect?.section.options ?? {};
  // What fw4 takes by default, a redirect that leaves it out keeps leaving out.
  const target = redirect === undefined ? 'DNAT' : (options['target'] as string | undefined);
  const defaultProtocols = form.protocols.length === 2 && form.protocols.includes('tcp') && form.protocols.includes('udp');
  return sectionChanges(
    redirect?.section,
    'redirect',
    {
      name: form.name.trim() === '' ? undefined : form.name.trim(),
      enabled: form.enabled ? undefined : '0',
      target,
      proto: redirect !== undefined && !('proto' in options) && defaultProtocols ? undefined : form.protocols,
      src: form.src === '' ? undefined : form.src,
      src_dport: form.srcDport.trim() === '' ? undefined : form.srcDport.trim(),
      src_ip: form.srcIps.length > 0 ? form.srcIps : undefined,
      dest: form.dest === '' ? undefined : form.dest,
      dest_ip: form.destIp.trim() === '' ? undefined : form.destIp.trim(),
      dest_port: form.destPort.trim() === '' ? undefined : form.destPort.trim(),
      reflection: form.reflection ? undefined : '0',
    },
    ref,
  );
}

/** What is wrong where, for the form to say in its language at that field. */
export interface UciFormProblem {
  field: string;
  code: 'zone-name' | 'zone-taken' | 'required' | 'ports' | 'ports-protocol' | 'address' | 'icmp-protocol' | 'protocols' | 'family' | 'set-name' | 'set-taken' | 'set-unknown' | 'entry';
  value?: string;
}

export function zoneProblems(firewall: OpenWrtFirewall, zone: FirewallZone | undefined, form: ZoneForm): UciFormProblem[] {
  const problems: UciFormProblem[] = [];
  // UCI's names; LuCI keeps zones to 11 characters, which fw3's chain names needed.
  if (!/^[A-Za-z0-9_]{1,11}$/.test(form.name)) problems.push({ field: 'name', code: 'zone-name', value: form.name });
  else if (firewall.zones.some((other) => other !== zone && other.name === form.name)) problems.push({ field: 'name', code: 'zone-taken', value: form.name });
  return problems;
}

/** `sets` are the names of the IP sets there are, for the rule's to be one of them. */
export function trafficRuleProblems(form: TrafficRuleForm, sets?: readonly string[]): UciFormProblem[] {
  const problems: UciFormProblem[] = [];
  const set = ipSetReference(form.ipset).name;
  if (set !== '' && sets !== undefined && !sets.includes(set)) problems.push({ field: 'ipset', code: 'set-unknown', value: set });
  const protocols = form.protocols.length > 0 ? form.protocols : ['tcp', 'udp'];
  const ports = protocols.every((protocol) => PORT_PROTOCOLS.includes(protocol));
  for (const field of ['srcPort', 'destPort'] as const) {
    const value = form[field].trim();
    if (value === '') continue;
    if (!validPorts(value)) problems.push({ field, code: 'ports', value });
    else if (!ports) problems.push({ field, code: 'ports-protocol' });
  }
  for (const field of ['srcIps', 'destIps'] as const) {
    const wrong = form[field].find((value) => !validAddress(value));
    if (wrong !== undefined) problems.push({ field, code: 'address', value: wrong });
    else if (form.family !== '' && form[field].some((value) => (value.includes(':') ? 'ipv6' : 'ipv4') !== form.family)) problems.push({ field, code: 'family' });
  }
  if (form.icmpTypes.length > 0 && !protocols.some((protocol) => protocol.startsWith('icmp') || protocol === 'ipv6-icmp')) problems.push({ field: 'icmpTypes', code: 'icmp-protocol' });
  return problems;
}

export function redirectProblems(form: RedirectForm): UciFormProblem[] {
  const problems: UciFormProblem[] = [];
  if (form.protocols.length === 0 || form.protocols.some((protocol) => protocol !== 'tcp' && protocol !== 'udp')) problems.push({ field: 'protocols', code: 'protocols' });
  if (form.src === '') problems.push({ field: 'src', code: 'required' });
  if (form.srcDport.trim() === '') problems.push({ field: 'srcDport', code: 'required' });
  else if (!validPorts(form.srcDport.trim())) problems.push({ field: 'srcDport', code: 'ports', value: form.srcDport });
  if (form.destPort.trim() !== '' && !validPorts(form.destPort.trim())) problems.push({ field: 'destPort', code: 'ports', value: form.destPort });
  if (form.dest === '') problems.push({ field: 'dest', code: 'required' });
  if (form.destIp.trim() === '') problems.push({ field: 'destIp', code: 'required' });
  else if (!isIpAddress(form.destIp.trim())) problems.push({ field: 'destIp', code: 'address', value: form.destIp });
  const wrong = form.srcIps.find((value) => !validAddress(value));
  if (wrong !== undefined) problems.push({ field: 'srcIps', code: 'address', value: wrong });
  return problems;
}

/** What a set holds, as fw4's match takes it: from the source or the destination, of addresses, networks, ports or MAC addresses. */
export const IPSET_MATCHES = ['src_net', 'dest_net', 'src_ip', 'dest_ip', 'src_port', 'dest_port', 'src_mac'] as const;

export interface IpSetForm {
  name: string;
  enabled: boolean;
  family: 'ipv4' | 'ipv6';
  /** One of IPSET_MATCHES, or several for a set of tuples, kept as they are. */
  match: string[];
  entries: string[];
  /** A file of more entries on the router, one a line; "" for none. */
  loadfile: string;
  comment: string;
}

export function ipSetForm(set: FirewallIpSet | undefined): IpSetForm {
  if (set === undefined) return { name: '', enabled: true, family: 'ipv4', match: ['src_net'], entries: [], loadfile: '', comment: '' };
  return {
    name: set.name,
    enabled: set.enabled,
    family: set.family === 'ipv6' ? 'ipv6' : 'ipv4',
    match: set.match,
    entries: set.entries,
    loadfile: set.loadfile ?? '',
    comment: set.comment ?? '',
  };
}

/** The set's own options, and for a new name the rules and port forwards that use it. */
export function ipSetChanges(firewall: OpenWrtFirewall, set: FirewallIpSet | undefined, form: IpSetForm, ref: string): UciChange[] {
  const options = set?.section.options ?? {};
  const changes = sectionChanges(
    set?.section,
    'ipset',
    {
      name: form.name,
      enabled: form.enabled ? undefined : '0',
      // fw4 takes ipv4 when a set does not say; a set that leaves it out keeps leaving it out.
      family: set !== undefined && !('family' in options) && form.family === 'ipv4' ? undefined : form.family,
      match: form.match,
      entry: form.entries.length > 0 ? form.entries : undefined,
      loadfile: form.loadfile.trim() === '' ? undefined : form.loadfile.trim(),
      comment: form.comment.trim() === '' ? undefined : form.comment.trim(),
    },
    ref,
  );
  if (set !== undefined && set.name !== form.name) {
    for (const part of [...firewall.rules, ...firewall.redirects]) {
      const value = part.section.options['ipset'];
      if (typeof value !== 'string') continue;
      const reference = ipSetReference(value);
      if (reference.name === set.name) changes.push({ kind: 'set', section: part.section.name, values: { ipset: `${reference.not ? '!' : ''}${form.name}${reference.rest}` } });
    }
  }
  return changes;
}

/** Removing a set that rules or port forwards use would leave them matching nothing fw4 knows: they are named instead. */
export function deleteIpSetChanges(firewall: OpenWrtFirewall, set: FirewallIpSet): { changes: UciChange[]; usedBy: string[] } {
  const usedBy = [...firewall.rules, ...firewall.redirects]
    .filter((part) => typeof part.section.options['ipset'] === 'string' && ipSetReference(part.section.options['ipset']).name === set.name)
    .map((part) => part.name ?? part.section.name);
  return usedBy.length > 0 ? { changes: [], usedBy } : { changes: [{ kind: 'delete', section: set.section.name }], usedBy: [] };
}

export function ipSetProblems(firewall: OpenWrtFirewall, set: FirewallIpSet | undefined, form: IpSetForm): UciFormProblem[] {
  const problems: UciFormProblem[] = [];
  // A name nft takes for a set, as fw4 declares it under its own.
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(form.name)) problems.push({ field: 'name', code: 'set-name', value: form.name });
  else if (firewall.ipsets.some((other) => other !== set && other.name === form.name)) problems.push({ field: 'name', code: 'set-taken', value: form.name });
  if (form.match.length === 1) {
    const kind = form.match[0]!.replace(/^(src|dest)_/, '');
    const wrong = form.entries.find((entry) => !validEntry(kind, entry, form.family));
    if (wrong !== undefined) problems.push({ field: 'entries', code: 'entry', value: wrong });
  }
  return problems;
}

/** "!blocked src" as its parts: whether it is negated, the set's name, and the rest, which fw4 reads as the direction. */
export function ipSetReference(value: string): { not: boolean; name: string; rest: string } {
  const match = /^(!?)\s*([^\s]*)(.*)$/.exec(value.trim())!;
  return { not: match[1] === '!', name: match[2]!, rest: match[3]! };
}

function validEntry(kind: string, entry: string, family: 'ipv4' | 'ipv6'): boolean {
  const ofFamily = (address: string) => (address.includes(':') ? 'ipv6' : 'ipv4') === family;
  switch (kind) {
    case 'ip':
      return isIpAddress(entry) && ofFamily(entry);
    case 'net':
      return validAddress(entry) && !entry.startsWith('!') && ofFamily(entry);
    case 'port':
      return validPorts(entry) && !/\s/.test(entry);
    case 'mac':
      return /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/.test(entry);
    default:
      return true;
  }
}

/** Rules, forwardings and port forwards naming a renamed zone, renamed with it. */
function renameZone(firewall: OpenWrtFirewall, from: string, to: string): UciChange[] {
  const changes: UciChange[] = [];
  for (const part of [...firewall.forwardings, ...firewall.rules, ...firewall.redirects]) {
    const values: Record<string, UciValue> = {};
    if (part.src === from) values['src'] = to;
    if (part.dest === from) values['dest'] = to;
    if (Object.keys(values).length > 0) changes.push({ kind: 'set', section: part.section.name, values });
  }
  return changes;
}

/** "22", "1000-2000", or several of them separated by spaces, as fw4 takes ports. */
function validPorts(text: string): boolean {
  return text.split(/\s+/).every((item) => {
    const match = /^(\d{1,5})(?:[-:](\d{1,5}))?$/.exec(item);
    if (match === null) return false;
    const [from, to] = [Number(match[1]), Number(match[2] ?? match[1])];
    return from >= 1 && to <= 65535 && from <= to;
  });
}

/** An address or network, IPv4 or IPv6, which UCI lets "!" negate. */
function validAddress(text: string): boolean {
  const value = text.startsWith('!') ? text.slice(1) : text;
  const [address, prefix, ...rest] = value.split('/');
  if (rest.length > 0 || address === undefined || !isIpAddress(address)) return false;
  if (prefix === undefined) return true;
  const bits = Number(prefix);
  return /^\d{1,3}$/.test(prefix) && bits <= (address.includes(':') ? 128 : 32);
}

function flag(on: boolean): string | undefined {
  return on ? '1' : undefined;
}

function listOf(value: UciValue | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((item) => item.split(/\s+/)).filter((item) => item !== '');
}
