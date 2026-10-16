// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

/** An interface of a host, with its addresses. */
export interface NetworkInterface {
  name: string;
  up: boolean;
  addresses: { family: 'ip' | 'ip6'; address: string; prefix: number }[];
}

export interface HostNetwork {
  interfaces: NetworkInterface[];
  /** Whether the kernel forwards packets between interfaces (net.ipv4.ip_forward, net.ipv6.conf.all.forwarding). */
  forwarding: { ip: boolean; ip6: boolean };
}

/** Where the host sends packets for an address (`ip route get`). */
export interface HostRoute {
  device?: string;
  /** The gateway, when the address is not on a network the host is on itself. */
  via?: string;
  source?: string;
}

// ip is in /sbin or /usr/sbin on some systems, which a normal user's PATH lacks.
const PATH = 'PATH="$PATH:/usr/sbin:/sbin"';

/** The host's interfaces and addresses, and whether it forwards; no root needed. */
export const NETWORK_COMMAND = `${PATH}
ip -o link show
echo '--- addr'
ip -o addr show
echo '--- forwarding'
cat /proc/sys/net/ipv4/ip_forward /proc/sys/net/ipv6/conf/all/forwarding 2>/dev/null
`;

/** Where the host routes $1; no root needed. */
export const ROUTE_COMMAND = `${PATH}; ip route get "$1"`;

export function parseNetwork(output: string): HostNetwork {
  const [links = '', rest = ''] = output.split('\n--- addr\n');
  const [addresses = '', forwarding = ''] = rest.split('\n--- forwarding\n');
  const interfaces = new Map<string, NetworkInterface>();
  for (const line of links.split('\n')) {
    // "2: eth0@if5: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 ..."
    const match = /^\d+:\s+([^:\s]+?)(?:@\S+)?:\s+<([^>]*)>/.exec(line);
    if (match === null) continue;
    interfaces.set(match[1]!, { name: match[1]!, up: match[2]!.split(',').includes('UP'), addresses: [] });
  }
  for (const line of addresses.split('\n')) {
    // "2: eth0    inet 10.0.2.100/24 brd 10.0.2.255 scope global eth0\       valid_lft ..."
    const match = /^\d+:\s+([^\s@]+)(?:@\S+)?\s+(inet6?)\s+([0-9a-fA-F.:]+)\/(\d+)/.exec(line);
    if (match === null) continue;
    const name = match[1]!;
    const entry = interfaces.get(name) ?? { name, up: true, addresses: [] };
    entry.addresses.push({ family: match[2] === 'inet6' ? 'ip6' : 'ip', address: match[3]!, prefix: Number(match[4]) });
    interfaces.set(name, entry);
  }
  const [ip, ip6] = forwarding.split('\n').map((value) => value.trim() === '1');
  return { interfaces: [...interfaces.values()], forwarding: { ip: ip ?? false, ip6: ip6 ?? false } };
}

/** "192.168.1.10 dev lan0 src 192.168.1.1 uid 1000" or "8.8.8.8 via 10.0.2.2 dev eth0 src 10.0.2.100". */
export function parseRoute(output: string): HostRoute {
  const line = output.split('\n')[0] ?? '';
  const field = (name: string) => new RegExp(`(?:^|\\s)${name} (\\S+)`).exec(line)?.[1];
  const [device, via, source] = [field('dev'), field('via'), field('src')];
  return { ...(device !== undefined && { device }), ...(via !== undefined && { via }), ...(source !== undefined && { source }) };
}

/** The network an interface address is on, e.g. "192.168.1.0/24"; for the hairpin clients a target's neighbours are. */
export function networkOf(address: string, prefix: number): string {
  if (!address.includes(':')) {
    const value = address.split('.').reduce((sum, part) => sum * 256 + Number(part), 0);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const network = (value & mask) >>> 0;
    return `${[24, 16, 8, 0].map((shift) => (network >>> shift) & 255).join('.')}/${prefix}`;
  }
  const groups = expandIPv6(address);
  const bits = groups.map((group) => group.toString(2).padStart(16, '0')).join('');
  const kept = bits.slice(0, prefix).padEnd(128, '0');
  const parts = Array.from({ length: 8 }, (_, index) => parseInt(kept.slice(index * 16, index * 16 + 16), 2).toString(16));
  return `${compressIPv6(parts)}/${prefix}`;
}

/** Whether an address is on a network ("192.168.1.0/24"). */
export function inNetwork(address: string, network: string): boolean {
  const [base, length] = network.split('/');
  if (base === undefined || length === undefined || base.includes(':') !== address.includes(':')) return false;
  return networkOf(address, Number(length)) === networkOf(base, Number(length));
}

function expandIPv6(address: string): number[] {
  const [head = '', tail] = address.split('::');
  const parse = (text: string) => (text === '' ? [] : text.split(':').map((group) => parseInt(group, 16) || 0));
  const start = parse(head);
  const end = tail === undefined ? [] : parse(tail);
  return [...start, ...Array<number>(8 - start.length - end.length).fill(0), ...end];
}

function compressIPv6(parts: string[]): string {
  let best = { start: -1, length: 1 };
  for (let start = 0; start < 8; start += 1) {
    let length = 0;
    while (start + length < 8 && parts[start + length] === '0') length += 1;
    if (length > best.length) best = { start, length };
  }
  if (best.start === -1) return parts.join(':');
  return `${parts.slice(0, best.start).join(':')}::${parts.slice(best.start + best.length).join(':')}`;
}
