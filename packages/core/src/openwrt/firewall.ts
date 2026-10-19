// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { uciBoolean, uciList, type UciConfig, type UciSection, type UciValue } from './uci.ts';

/**
 * OpenWrt's firewall as UCI holds it in /etc/config/firewall, from which fw4
 * makes the `inet fw4` table. Each part keeps its section, so that a change
 * touches only the options it is about and keeps every other one, including
 * those hopdeck does not know.
 */
export interface OpenWrtFirewall {
  defaults: FirewallDefaults | undefined;
  zones: FirewallZone[];
  forwardings: FirewallForwarding[];
  rules: FirewallRule[];
  redirects: FirewallRedirect[];
  ipsets: FirewallIpSet[];
  /** Sections of other types (include, nat, ...), shown as they are. */
  other: UciSection[];
}

/** ACCEPT, REJECT or DROP. */
export type ZonePolicy = string;

export interface FirewallDefaults {
  section: UciSection;
  input: ZonePolicy | undefined;
  output: ZonePolicy | undefined;
  forward: ZonePolicy | undefined;
  synFlood: boolean;
}

export interface FirewallZone {
  section: UciSection;
  name: string;
  /** Networks of /etc/config/network, such as lan or wan6. */
  networks: string[];
  /** Interfaces named directly, besides those of the networks. */
  devices: string[];
  subnets: string[];
  input: ZonePolicy | undefined;
  output: ZonePolicy | undefined;
  forward: ZonePolicy | undefined;
  masquerade: boolean;
  mtuFix: boolean;
  /** Logs what the zone's policies reject or drop. */
  log: boolean;
  enabled: boolean;
}

export interface FirewallForwarding {
  section: UciSection;
  /** From this zone ... */
  src: string;
  /** ... to this one, whatever its forward policy. */
  dest: string;
  enabled: boolean;
}

export interface FirewallRule {
  section: UciSection;
  name: string | undefined;
  /** A zone, "*" for any, or nothing for the router itself (output). */
  src: string | undefined;
  /** A zone, "*" for any, or nothing for the router itself (input). */
  dest: string | undefined;
  /** tcp, udp, icmp, ...; fw4 takes "tcp udp" when there is none. */
  protocols: string[];
  srcIps: string[];
  destIps: string[];
  srcPort: string | undefined;
  destPort: string | undefined;
  icmpTypes: string[];
  /** ipv4, ipv6, or nothing for both. */
  family: string | undefined;
  /** An IP set the packet must be in, or with "!" must not: "blocked", "!blocked". */
  ipset: string | undefined;
  /** ACCEPT, REJECT, DROP, MARK, NOTRACK, ... */
  target: string | undefined;
  enabled: boolean;
}

export interface FirewallRedirect {
  section: UciSection;
  name: string | undefined;
  /** DNAT (a port forward) or SNAT. */
  target: string;
  /** For DNAT, the zone the connections come from, usually wan. */
  src: string | undefined;
  /** The port on the router, for DNAT. */
  srcDport: string | undefined;
  /** Where they go: the zone, the address and the port there. */
  dest: string | undefined;
  destIp: string | undefined;
  destPort: string | undefined;
  protocols: string[];
  /** NAT loopback (hairpin): clients inside reach the forward by the router's outside address. On by default. */
  reflection: boolean;
  enabled: boolean;
}

/**
 * A named set fw4 declares in its table, for rules to match against: of
 * addresses, networks, ports or MAC addresses, from the source or the
 * destination of a packet.
 */
export interface FirewallIpSet {
  section: UciSection;
  name: string;
  /** ipv4 (fw4's default) or ipv6. */
  family: string;
  /** What of a packet it holds, such as src_net or dest_port; several make a set of tuples. */
  match: string[];
  entries: string[];
  /** A file of more entries, one a line, that fw4 reads when it loads. */
  loadfile: string | undefined;
  comment: string | undefined;
  enabled: boolean;
}

/** The firewall's sections, typed; sections fw4 would ignore keep their place in `other`. */
export function openwrtFirewall(config: UciConfig): OpenWrtFirewall {
  const firewall: OpenWrtFirewall = { defaults: undefined, zones: [], forwardings: [], rules: [], redirects: [], ipsets: [], other: [] };
  for (const section of config.sections) {
    const option = (name: string): string | undefined => {
      const value: UciValue | undefined = section.options[name];
      return typeof value === 'string' ? value : value?.[0];
    };
    const enabled = uciBoolean(section.options['enabled'], true);
    switch (section.type) {
      case 'defaults':
        // fw4 reads the first defaults section only.
        if (firewall.defaults === undefined) {
          firewall.defaults = { section, input: option('input'), output: option('output'), forward: option('forward'), synFlood: uciBoolean(section.options['syn_flood'], false) };
        } else firewall.other.push(section);
        break;
      case 'zone':
        firewall.zones.push({
          section,
          name: option('name') ?? section.name,
          networks: uciList(section.options['network']),
          devices: uciList(section.options['device']),
          subnets: uciList(section.options['subnet']),
          input: option('input'),
          output: option('output'),
          forward: option('forward'),
          masquerade: uciBoolean(section.options['masq'], false),
          mtuFix: uciBoolean(section.options['mtu_fix'], false),
          log: uciBoolean(section.options['log'], false),
          enabled,
        });
        break;
      case 'forwarding':
        firewall.forwardings.push({ section, src: option('src') ?? '', dest: option('dest') ?? '', enabled });
        break;
      case 'rule':
        firewall.rules.push({
          section,
          name: option('name'),
          src: option('src'),
          dest: option('dest'),
          protocols: uciList(section.options['proto']),
          srcIps: uciList(section.options['src_ip']),
          destIps: uciList(section.options['dest_ip']),
          srcPort: option('src_port'),
          destPort: option('dest_port'),
          icmpTypes: uciList(section.options['icmp_type']),
          family: option('family'),
          ipset: option('ipset'),
          target: option('target'),
          enabled,
        });
        break;
      case 'ipset':
        firewall.ipsets.push({
          section,
          name: option('name') ?? section.name,
          family: option('family') ?? 'ipv4',
          match: uciList(section.options['match']),
          entries: uciList(section.options['entry']),
          loadfile: option('loadfile'),
          comment: option('comment'),
          enabled,
        });
        break;
      case 'redirect':
        firewall.redirects.push({
          section,
          name: option('name'),
          target: (option('target') ?? 'DNAT').toUpperCase(),
          src: option('src'),
          srcDport: option('src_dport'),
          dest: option('dest'),
          destIp: option('dest_ip'),
          destPort: option('dest_port'),
          protocols: uciList(section.options['proto']),
          reflection: uciBoolean(section.options['reflection'], true),
          enabled,
        });
        break;
      default:
        firewall.other.push(section);
    }
  }
  return firewall;
}
