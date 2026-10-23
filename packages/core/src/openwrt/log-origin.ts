// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { fw4Name, type OpenWrtFirewall } from './firewall.ts';
import type { UciSection } from './uci.ts';

/** The part of UCI a line of the kernel log came from: a zone's policy, or a section with `log`. */
export type Fw4LogOrigin =
  | { kind: 'zone'; zone: string; direction: 'in' | 'out' | 'forward'; verdict: string }
  | { kind: 'rule' | 'redirect' | 'nat'; name: string; section: string };

/**
 * Where fw4 made the rule whose log prefix a line has. fw4 logs what a zone
 * with `log` turns away as "reject wan in: " ("out", "forward"; "drop" for
 * DROP), and what a rule, port forward or NAT rule with `log 1` matches as
 * "NAME: ", NAME being fw4's for the section; a `log` that is no flag is the
 * prefix itself. `sections` are the configuration's, for the names of
 * sections without one.
 */
export function fw4LogOrigin(firewall: OpenWrtFirewall, sections: readonly UciSection[], prefix: string): Fw4LogOrigin | undefined {
  const zone = /^(accept|reject|drop) (\S+) (in|out|forward): $/.exec(prefix);
  if (zone !== null && firewall.zones.some((candidate) => candidate.name === zone[2])) {
    return { kind: 'zone', zone: zone[2]!, direction: zone[3] as 'in' | 'out' | 'forward', verdict: zone[1]! };
  }
  const kinds = [
    ['rule', firewall.rules],
    ['redirect', firewall.redirects],
    ['nat', firewall.nats],
  ] as const;
  for (const [kind, parts] of kinds) {
    for (const part of parts) {
      const log = part.section.options['log'];
      if (typeof log !== 'string' || !part.enabled) continue;
      const on = fw4Flag(log);
      const name = fw4Name(part.section, sections);
      if (on === false) continue;
      if ((on === true ? `${name}: ` : log) === prefix) return { kind, name, section: part.section.name };
    }
  }
  return undefined;
}

/** A flag as fw4 reads one (parse_bool): undefined for a value that is none. */
export function fw4Flag(value: string): boolean | undefined {
  if (['1', 'on', 'true', 'yes'].includes(value)) return true;
  if (['0', 'off', 'false', 'no'].includes(value)) return false;
  return undefined;
}
