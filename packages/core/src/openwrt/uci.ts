// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

/**
 * UCI, OpenWrt's configuration, as hopdeck reads and changes it: through
 * rpcd over ubus, the way LuCI does, so that every change is UCI's own and
 * LuCI shows it. See docs/ARCHITECTURE.md, "OpenWrt".
 */

/** An option's value: a list option is an array. */
export type UciValue = string | string[];

/** A section of a UCI configuration, as `ubus call uci get` returns it. */
export interface UciSection {
  /** Its own name, or for an anonymous section the one UCI made up (cfg02dc81), which lasts until the next reboot or commit at most. */
  name: string;
  type: string;
  anonymous: boolean;
  /** Its place in the file, from 0. */
  index: number;
  options: Record<string, UciValue>;
}

export interface UciConfig {
  /** firewall, network, ... */
  name: string;
  /** In the order of the file. */
  sections: UciSection[];
}

/** One change hopdeck stages in its rpcd session: one ubus call. */
export type UciChange =
  /**
   * A new section; anonymous unless it has a name. Until rpcd names it, later
   * changes and orders refer to it by `ref` (new-1, ...), which hopdeck
   * replaces with the name rpcd gives it.
   */
  | { kind: 'add'; type: string; name?: string; ref?: string; values: Record<string, UciValue> }
  /** Options set, keeping the others. */
  | { kind: 'set'; section: string; values: Record<string, UciValue> }
  /** Options removed. */
  | { kind: 'unset'; section: string; options: string[] }
  | { kind: 'delete'; section: string }
  /** Sections put first in this order; for rules, the order is what fw4 follows. */
  | { kind: 'order'; sections: string[] };

/** What `ubus call uci get '{"config": NAME}'` printed. */
export function parseUciGet(config: string, json: string): UciConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`ubus did not print JSON for ${config}: ${json.slice(0, 200)}`);
  }
  const values = (parsed as { values?: unknown }).values;
  if (typeof values !== 'object' || values === null) throw new Error(`ubus printed no sections for ${config}: ${json.slice(0, 200)}`);
  const sections: UciSection[] = [];
  for (const [key, raw] of Object.entries(values as Record<string, Record<string, unknown>>)) {
    const options: Record<string, UciValue> = {};
    for (const [option, value] of Object.entries(raw)) {
      if (option.startsWith('.')) continue;
      if (typeof value === 'string') options[option] = value;
      else if (Array.isArray(value)) options[option] = value.map(String);
    }
    sections.push({
      name: typeof raw['.name'] === 'string' ? raw['.name'] : key,
      type: String(raw['.type']),
      anonymous: raw['.anonymous'] === true,
      index: typeof raw['.index'] === 'number' ? raw['.index'] : sections.length,
      options,
    });
  }
  sections.sort((a, b) => a.index - b.index);
  return { name: config, sections };
}

/** The ubus method of `uci` and its message for a change, without the session, which the caller adds. */
export function uciCall(config: string, change: UciChange): { method: string; message: Record<string, unknown> } {
  switch (change.kind) {
    case 'add':
      return { method: 'add', message: { config, type: change.type, ...(change.name !== undefined && { name: change.name }), values: change.values } };
    case 'set':
      return { method: 'set', message: { config, section: change.section, values: change.values } };
    case 'unset':
      return { method: 'delete', message: { config, section: change.section, options: change.options } };
    case 'delete':
      return { method: 'delete', message: { config, section: change.section } };
    case 'order':
      return { method: 'order', message: { config, sections: change.sections } };
  }
}

/**
 * A section as people name it: by its name option where it has one
 * (`rule "Allow-Ping"`), else as uci show does (`@rule[3]`, counting the
 * sections of its type), or by its own name when it is not anonymous.
 */
export function sectionLabel(config: UciConfig, section: UciSection): string {
  const name = section.options['name'];
  if (typeof name === 'string' && name !== '') return `${section.type} "${name}"`;
  if (!section.anonymous) return `${section.type} ${section.name}`;
  const nth = config.sections.filter((other) => other.type === section.type && other.index < section.index).length;
  return `@${section.type}[${nth}]`;
}

/** A change as rpcd lists it (`ubus call uci changes`): what will be written when it applies. */
export interface StagedChange {
  /** add, set, remove, rename, list-add, list-del, reorder. */
  kind: string;
  section: string;
  /** For add: the section's type; for set: the option; else the option or nothing. */
  option?: string;
  value?: string;
}

/** What `ubus call uci changes '{"config": NAME, ...}'` printed. */
export function parseUciChanges(json: string): StagedChange[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`ubus did not print JSON for the changes: ${json.slice(0, 200)}`);
  }
  const changes = (parsed as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) return [];
  return changes.map((entry: unknown) => {
    const [kind, section, option, value] = (Array.isArray(entry) ? entry : []).map(String);
    return { kind: kind ?? '', section: section ?? '', ...(option !== undefined && { option }), ...(value !== undefined && { value }) };
  });
}

/** UCI's booleans: 1, yes, on and true are true; 0, no, off and false false; anything else, or nothing, the default. */
export function uciBoolean(value: UciValue | undefined, fallback: boolean): boolean {
  if (typeof value !== 'string') return fallback;
  if (['1', 'yes', 'on', 'true', 'enabled'].includes(value)) return true;
  if (['0', 'no', 'off', 'false', 'disabled'].includes(value)) return false;
  return fallback;
}

/** A list option as a list, whether UCI keeps it as a list or as one string; fw4 splits a string at spaces. */
export function uciList(value: UciValue | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((item) => item.split(/\s+/)).filter((item) => item !== '');
}

export type UciPlanState = 'planned' | 'invalid' | 'awaiting-confirmation' | 'confirmed' | 'rolled-back' | 'failed';

/**
 * A change of a UCI configuration on its way: staged in hopdeck's own rpcd
 * session, applied with rpcd's rollback, then kept or undone; the way LuCI
 * applies its changes.
 */
export interface UciPlanView {
  id: string;
  hostId: string;
  /** The configuration changed, such as firewall. */
  config: string;
  state: UciPlanState;
  /** What rpcd will write, as it lists it, each section named as people name it. */
  staged: (StagedChange & { label: string })[];
  /** Whether rpcd took every change; a refusal carries its message. */
  validation: { ok: boolean; message: string };
  /**
   * Changes to the same configuration not committed elsewhere: the uci
   * command's, and other rpcd sessions', such as LuCI's. Applying this plan
   * leaves them where they are.
   */
  pendingElsewhere: { cli: boolean; sessions: number };
  safety: {
    /** Seconds until rpcd rolls back an unconfirmed change. */
    seconds: number;
    /** Whether a new, unshared SSH connection is tried right after applying. */
    freshConnectionCheck: boolean;
  };
  /** When rpcd rolls back on its own, ISO 8601; while awaiting confirmation. */
  deadline?: string;
  /** Why the change failed or was rolled back, with the raw message. */
  outcome?: { reason: 'apply-failed' | 'reload-failed' | 'fresh-connection-failed' | 'timeout' | 'user'; detail: string };
  /** What fw4 said when it reloaded the firewall with the change, such as a section it skipped. */
  warnings?: string;
  /** The table fw4 made, before the change and with it: what the change does in nftables. */
  ruleset?: { before: string; after: string };
}
