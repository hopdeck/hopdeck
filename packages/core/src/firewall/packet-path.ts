// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { Family } from './nft-json.ts';
import type { ChainNode, Ruleset, TableNode } from './ruleset.ts';

/** Which kind of traffic to follow; each sees the chains of different families. */
export type Traffic = 'ipv4' | 'ipv6' | 'arp' | 'bridge';

export type PathKind = 'incoming' | 'forwarded' | 'outgoing';

export interface StageChain {
  node: TableNode;
  chain: ChainNode;
  priority: number;
  /** Another chain in the same hook has the same priority; the kernel does not guarantee their order. */
  tie: boolean;
}

export interface HookStage {
  hook: string;
  /** In the order the kernel runs them: lowest priority first. */
  chains: StageChain[];
}

// Hooks a packet passes, in order. ingress and egress are netdev hooks on the
// device (inet tables can use ingress too, since Linux 5.10).
const PATHS: Record<Traffic, Partial<Record<PathKind, readonly string[]>>> = {
  ipv4: {
    incoming: ['ingress', 'prerouting', 'input'],
    forwarded: ['ingress', 'prerouting', 'forward', 'postrouting', 'egress'],
    outgoing: ['output', 'postrouting', 'egress'],
  },
  ipv6: {
    incoming: ['ingress', 'prerouting', 'input'],
    forwarded: ['ingress', 'prerouting', 'forward', 'postrouting', 'egress'],
    outgoing: ['output', 'postrouting', 'egress'],
  },
  arp: {
    incoming: ['ingress', 'input'],
    outgoing: ['output', 'egress'],
  },
  bridge: {
    incoming: ['ingress', 'prerouting', 'input'],
    forwarded: ['ingress', 'prerouting', 'forward', 'postrouting', 'egress'],
    outgoing: ['output', 'postrouting', 'egress'],
  },
};

// inet chains see both IPv4 and IPv6.
const FAMILIES: Record<Traffic, readonly Family[]> = {
  ipv4: ['ip', 'inet'],
  ipv6: ['ip6', 'inet'],
  arp: ['arp'],
  bridge: ['bridge'],
};

export function hasPath(traffic: Traffic, path: PathKind): boolean {
  return PATHS[traffic][path] !== undefined;
}

/** The base chains a packet meets, hook by hook; undefined when that traffic has no such path (forwarded ARP). */
export function packetPath(ruleset: Ruleset, traffic: Traffic, path: PathKind): HookStage[] | undefined {
  const hooks = PATHS[traffic][path];
  if (hooks === undefined) return undefined;
  const families = new Set<Family>(FAMILIES[traffic]);

  return hooks.map((hook) => {
    // netdev chains sit on devices and see every packet there, whatever its protocol.
    const sees = (family: Family) => families.has(family) || (family === 'netdev' && (hook === 'ingress' || hook === 'egress'));
    const chains = ruleset.tables
      .filter((node) => sees(node.table.family))
      .flatMap((node) =>
        node.chains
          .filter((chain) => chain.chain.hook === hook)
          .map((chain) => ({ node, chain, priority: chain.chain.prio ?? 0 })),
      )
      .sort((a, b) => a.priority - b.priority);
    return {
      hook,
      chains: chains.map((entry) => ({ ...entry, tie: chains.some((other) => other !== entry && other.priority === entry.priority) })),
    };
  });
}
