import { tableKey } from './keys.ts';
import type { Listing } from './listing.ts';
import type { Json } from './nft-json.ts';
import type { TableNode } from './ruleset.ts';
import { TRACE_TABLE_PREFIX } from './trace.ts';

export type KnownTool =
  | 'crowdsec'
  | 'docker'
  | 'fail2ban'
  | 'firewalld'
  | 'incus'
  | 'kubernetes'
  | 'libvirt'
  | 'lxd'
  | 'nixos'
  | 'hopdeck-trace'
  | 'openwrt'
  | 'podman'
  | 'tailscale'
  | 'ufw';

/**
 * Who a table probably belongs to, with the evidence, so the UI can say how
 * sure it is. hopdeck edits none of these.
 */
export type TableOwner =
  | {
      kind: 'iptables-nft';
      /** marker: nft says so; xt: rules only iptables-nft can recreate; chains: iptables-style chain names. */
      evidence: 'marker' | 'xt' | 'chains';
      /** Tools that put chains into it, recognised by chain name prefixes. */
      users: KnownTool[];
    }
  | { kind: 'tool'; tool: KnownTool; evidence: 'table-name' }
  | { kind: 'unknown' };

const TABLE_NAMES: ReadonlyMap<string, KnownTool> = new Map([
  ['firewalld', 'firewalld'],
  ['f2b-table', 'fail2ban'],
  ['crowdsec', 'crowdsec'],
  ['crowdsec6', 'crowdsec'],
  ['libvirt_network', 'libvirt'],
  ['netavark', 'podman'],
  ['incus', 'incus'],
  ['lxd', 'lxd'],
  ['kube-proxy', 'kubernetes'],
  ['docker-bridges', 'docker'],
  ['nixos-fw', 'nixos'],
  // OpenWrt's firewall4 generates this table from /etc/config/firewall.
  ['fw4', 'openwrt'],
]);

const CHAIN_PREFIXES: readonly [string, KnownTool][] = [
  ['DOCKER', 'docker'],
  ['ufw-', 'ufw'],
  ['ufw6-', 'ufw'],
  ['f2b-', 'fail2ban'],
  ['KUBE-', 'kubernetes'],
  ['LIBVIRT_', 'libvirt'],
  ['ts-', 'tailscale'],
  ['CROWDSEC', 'crowdsec'],
];

const IPTABLES_TABLES = new Set(['filter', 'nat', 'mangle', 'raw', 'security', 'broute']);
const IPTABLES_CHAINS = new Set(['INPUT', 'OUTPUT', 'FORWARD', 'PREROUTING', 'POSTROUTING', 'BROUTING']);

export function tableOwner(node: TableNode, listing?: Listing): TableOwner {
  const { family, name } = node.table;
  const chainNames = node.chains.map((chain) => chain.chain.name);
  const users = [...new Set(chainNames.flatMap((chain) => CHAIN_PREFIXES.filter(([prefix]) => chain.startsWith(prefix)).map(([, tool]) => tool)))];

  if (listing?.iptablesNft.has(tableKey(family, name))) return { kind: 'iptables-nft', evidence: 'marker', users };
  if (node.chains.some((chain) => chain.rules.some((rule) => containsKey(rule.expr, 'xt')))) {
    return { kind: 'iptables-nft', evidence: 'xt', users };
  }
  if (family !== 'inet' && family !== 'netdev' && IPTABLES_TABLES.has(name) && chainNames.some((chain) => IPTABLES_CHAINS.has(chain))) {
    return { kind: 'iptables-nft', evidence: 'chains', users };
  }
  // hopdeck's own temporary table while it traces packets.
  if (family === 'inet' && name.startsWith(TRACE_TABLE_PREFIX)) return { kind: 'tool', tool: 'hopdeck-trace', evidence: 'table-name' };
  const tool = TABLE_NAMES.get(name);
  if (tool !== undefined) return { kind: 'tool', tool, evidence: 'table-name' };
  return { kind: 'unknown' };
}

function containsKey(value: Json, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
  if (typeof value !== 'object' || value === null) return false;
  return Object.hasOwn(value, key) || Object.values(value).some((item) => containsKey(item, key));
}
