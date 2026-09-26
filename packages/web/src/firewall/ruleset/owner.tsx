import type { KnownTool, TableOwner } from '@hopdeck/core';
import styles from './Ruleset.module.css';

const TOOL_NAMES: Record<KnownTool, string> = {
  crowdsec: 'CrowdSec',
  docker: 'Docker',
  fail2ban: 'fail2ban',
  firewalld: 'firewalld',
  incus: 'Incus',
  kubernetes: 'Kubernetes',
  libvirt: 'libvirt',
  lxd: 'LXD',
  nixos: 'NixOS',
  'hopdeck-trace': 'hopdeck (nftrace)',
  openwrt: 'OpenWrt firewall4',
  podman: 'Podman',
  tailscale: 'Tailscale',
  ufw: 'UFW',
};

export function toolName(tool: KnownTool): string {
  return TOOL_NAMES[tool];
}

export function OwnerBadge({ owner }: { owner: TableOwner }) {
  if (owner.kind === 'iptables-nft') return <span className={`${styles.badge} ${styles.badgeDanger}`}>iptables-nft</span>;
  if (owner.kind === 'tool') return <span className={`${styles.badge} ${styles.badgeWarn}`}>{toolName(owner.tool)}</span>;
  return null;
}
