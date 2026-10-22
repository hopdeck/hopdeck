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
  nats: FirewallNat[];
  ipsets: FirewallIpSet[];
  includes: FirewallInclude[];
  /** Sections of other types, shown as they are. */
  other: UciSection[];
}

/** Where fw4 puts an nftables include: before or after everything, inside its table, or inside one of its chains. */
export const INCLUDE_POSITIONS = ['ruleset-pre', 'ruleset-post', 'table-pre', 'table-post', 'chain-pre', 'chain-post'] as const;

/** Where hopdeck keeps the nftables files it writes for fw4, one per version: name.version.nft. */
export const INCLUDE_DIRECTORY = '/etc/hopdeck/fw4';
/** UCI names the include sections hopdeck writes hopdeck_NAME. */
export const INCLUDE_SECTION_PREFIX = 'hopdeck_';

/**
 * A file fw4 includes when it builds its ruleset: nftables at a position
 * (`type nftables`), or a shell script of fw3's days. hopdeck manages those
 * in its own directory under a section of its own; others it shows.
 */
export interface FirewallInclude {
  section: UciSection;
  /** nftables, or script (fw3's, which fw4 ignores). */
  type: string;
  path: string | undefined;
  /** One of INCLUDE_POSITIONS; fw4 takes table-append when none is given. */
  position: string | undefined;
  /** The chain, for chain-pre and chain-post. */
  chain: string | undefined;
  enabled: boolean;
  /** hopdeck wrote it: a section hopdeck_NAME pointing into INCLUDE_DIRECTORY. */
  managed: boolean;
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
 * A NAT rule, as LuCI's NAT Rules are: what leaves through a zone gets the
 * address of the interface it leaves by (MASQUERADE, fw4's default), an
 * address or port given (SNAT), or keeps its own (ACCEPT). fw4 follows them
 * in their order, before the zone's own masquerading.
 */
export interface FirewallNat {
  section: UciSection;
  name: string | undefined;
  /** The zone the packets leave through; "*" or nothing for any. */
  src: string | undefined;
  /** An interface they leave by. */
  device: string | undefined;
  /** None for all, as fw4 takes it. */
  protocols: string[];
  srcIp: string | undefined;
  srcPort: string | undefined;
  destIp: string | undefined;
  destPort: string | undefined;
  /** MASQUERADE, SNAT or ACCEPT. */
  target: string;
  /** For SNAT: the source address and port it writes. */
  snatIp: string | undefined;
  snatPort: string | undefined;
  /** ipv4, ipv6 or any; with none, fw4 takes IPv4, or IPv6 when the addresses are. */
  family: string | undefined;
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
  const firewall: OpenWrtFirewall = { defaults: undefined, zones: [], forwardings: [], rules: [], redirects: [], nats: [], ipsets: [], includes: [], other: [] };
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
      case 'include': {
        const path = option('path');
        firewall.includes.push({
          section,
          type: option('type') ?? 'script',
          path,
          position: option('position'),
          chain: option('chain'),
          enabled,
          managed: section.name.startsWith(INCLUDE_SECTION_PREFIX) && path !== undefined && path.startsWith(`${INCLUDE_DIRECTORY}/`),
        });
        break;
      }
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
      case 'nat':
        firewall.nats.push({
          section,
          name: option('name'),
          src: option('src'),
          device: option('device'),
          protocols: uciList(section.options['proto']),
          srcIp: option('src_ip'),
          srcPort: option('src_port'),
          destIp: option('dest_ip'),
          destPort: option('dest_port'),
          target: (option('target') ?? 'MASQUERADE').toUpperCase(),
          snatIp: option('snat_ip'),
          snatPort: option('snat_port'),
          family: option('family'),
          enabled,
        });
        break;
      default:
        firewall.other.push(section);
    }
  }
  return firewall;
}
