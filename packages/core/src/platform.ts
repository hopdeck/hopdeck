// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

/**
 * What sets hosts apart for hopdeck: where its files go, and how each module
 * may change the host. See docs/ARCHITECTURE.md, "Platforms".
 */
export type PlatformId = 'linux' | 'openwrt';

export interface Platform {
  id: PlatformId;
  /** hopdeck's files that must survive a reboot: what loads at boot, host settings. Only root may read them. */
  configDir: string;
  /** hopdeck's records on the host, such as the change history. */
  stateDir: string;
  /**
   * How the firewall module changes the host: through nft, or not at all yet.
   * OpenWrt's firewall belongs to UCI, which fw4 turns into nftables and LuCI
   * shows; a table changed with nft behind their back would be lost on the
   * next firewall reload, and LuCI would never show it.
   */
  firewall: 'nft' | 'read-only';
}

const PLATFORMS: Readonly<Record<PlatformId, Platform>> = {
  linux: { id: 'linux', configDir: '/etc/hopdeck', stateDir: '/var/lib/hopdeck', firewall: 'nft' },
  // /var is in RAM on OpenWrt, so records that must outlive a reboot go to flash with the configuration.
  openwrt: { id: 'openwrt', configDir: '/etc/hopdeck', stateDir: '/etc/hopdeck/state', firewall: 'read-only' },
};

export function platform(id: PlatformId): Platform {
  return PLATFORMS[id];
}
