// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { UciConfig } from './uci.ts';

/** A host the router knows on its networks: one it gave an address by DHCP, or one with an address of its own in /etc/config/dhcp. */
export interface DhcpHost {
  ip: string;
  mac?: string;
  name?: string;
  /** A host section of /etc/config/dhcp; else a lease of the moment. */
  static: boolean;
}

/** What `ubus call luci-rpc getDHCPLeases` printed: its IPv4 leases. */
export function parseLuciLeases(json: string): DhcpHost[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const leases = (parsed as { dhcp_leases?: unknown }).dhcp_leases;
  if (!Array.isArray(leases)) return [];
  return leases.flatMap((lease: Record<string, unknown>) => {
    if (typeof lease['ipaddr'] !== 'string') return [];
    return [hostOf(lease['ipaddr'], lease['macaddr'], lease['hostname'], false)];
  });
}

/** dnsmasq's lease file, /tmp/dhcp.leases: "expiry mac ip hostname client-id" a line, "*" for no hostname. */
export function parseLeaseFile(text: string): DhcpHost[] {
  return text.split('\n').flatMap((line) => {
    const [, mac, ip, name] = line.trim().split(/\s+/);
    if (ip === undefined || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return [];
    return [hostOf(ip, mac, name === '*' ? undefined : name, false)];
  });
}

/** The host sections of /etc/config/dhcp with an address. */
export function staticHosts(dhcp: UciConfig): DhcpHost[] {
  return dhcp.sections.flatMap((section) => {
    if (section.type !== 'host') return [];
    const ip = section.options['ip'];
    if (typeof ip !== 'string' || ip === '') return [];
    const mac = section.options['mac'];
    return [hostOf(ip, Array.isArray(mac) ? mac[0] : mac, section.options['name'], true)];
  });
}

/** One entry an address, a host section's name winning over a lease's, sorted by address. */
export function mergeHosts(...lists: readonly DhcpHost[][]): DhcpHost[] {
  const byIp = new Map<string, DhcpHost>();
  for (const host of lists.flat()) {
    const known = byIp.get(host.ip);
    byIp.set(host.ip, known === undefined ? host : { ...known, ...Object.fromEntries(Object.entries(host).filter(([, value]) => value !== undefined)), static: known.static || host.static });
  }
  const key = (ip: string) => ip.split('.').map((part) => part.padStart(3, '0')).join('.');
  return [...byIp.values()].sort((a, b) => key(a.ip).localeCompare(key(b.ip)));
}

function hostOf(ip: string, mac: unknown, name: unknown, isStatic: boolean): DhcpHost {
  return {
    ip,
    ...(typeof mac === 'string' && mac !== '' && { mac: mac.toLowerCase() }),
    ...(typeof name === 'string' && name !== '' && { name }),
    static: isStatic,
  };
}
