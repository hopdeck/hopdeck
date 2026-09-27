// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

/** Shapes of the hosts API, shared by the server and the UI. */

import type { DiffLine } from './diff.ts';
import type { Family } from './firewall/nft-json.ts';
import type { TraceFilter } from './firewall/trace.ts';
import type { PlatformId } from './platform.ts';

export type HostKind = 'local' | 'ssh' | 'sandbox';

/**
 * Stable codes the UI translates; the accompanying detail carries the raw
 * message (usually stderr of ssh, sudo or nft).
 */
export type HostErrorCode =
  | 'ssh-host-key'
  | 'ssh-host-key-changed'
  | 'ssh-auth'
  | 'ssh-connect'
  | 'timeout'
  | 'spawn-failed'
  | 'command-failed'
  | 'nft-missing'
  | 'no-privileges'
  | 'password-required'
  | 'wrong-password'
  | 'sudo-not-allowed'
  | 'host-key-mismatch'
  | 'known-hosts-unwritable'
  | 'host-key-in-global-file'
  | 'table-not-editable'
  | 'invalid-definition'
  | 'ruleset-changed'
  | 'rollback-unavailable'
  | 'deployment-state'
  | 'persistence-unavailable'
  | 'include-rejected'
  | 'invalid-filter'
  | 'trace-unavailable'
  | 'platform-read-only'
  | 'wrong-passphrase'
  | 'login-password-rejected'
  | 'password-login-disabled';

export interface HostFacts {
  uid: number;
  user: string;
  hostname: string;
  kernel: string;
  os: { id: string; version: string; name: string } | undefined;
  /** See platform(). */
  platform: PlatformId;
  systemd: boolean;
  /** `path` is absolute: /usr/sbin is often missing from a normal user's PATH. */
  nft: { path: string; version: string } | undefined;
}

/** Why nft cannot get root on a host; `detail` of the privilege carries the raw message. */
export type NoAccessReason = 'nft-missing' | 'sudo-missing' | 'sudo-not-allowed' | 'other';

/** How nft gets root on a host. */
export type Privilege =
  | { kind: 'root' }
  | { kind: 'sudo' }
  | { kind: 'sudo-password' }
  | { kind: 'none'; reason: NoAccessReason; detail: string };

export type HostStatus =
  | { state: 'new' }
  | { state: 'connected'; facts: HostFacts; privilege: Privilege; passwordStored: boolean }
  | {
      state: 'error';
      /** `code` is a HostErrorCode from the server, or "unknown"; the UI also records API error codes here. */
      error: { code: HostErrorCode | 'unknown' | (string & {}); detail: string };
    };

export interface HostKey {
  /** e.g. "ssh-ed25519". */
  type: string;
  /** "SHA256:..." as ssh-keygen -l prints it. */
  fingerprint: string;
}

/** What hopdeck found out about an SSH host's key, for the user to confirm. */
export interface HostKeyCheck {
  /** How known_hosts names the host, e.g. "fw1" or "[10.0.0.1]:2222". */
  name: string;
  /** Where hopdeck would write the key: the first known_hosts file ssh uses for this host. */
  knownHostsFile: string;
  /** The key the server presents now. */
  presented: HostKey;
  /** Keys that known_hosts files already hold for this name; any that differ from `presented` mean the key changed. */
  known: (HostKey & { file: string })[];
}

/** A private key ssh would offer a host, as hopdeck found it on this machine. */
export interface SshKeyInfo {
  /** Its path. */
  file: string;
  /** e.g. "ED25519". */
  type: string;
  /** "SHA256:…", as ssh-keygen -l prints it. */
  fingerprint: string;
  comment: string;
  /** It needs its passphrase before ssh can use it. */
  encrypted: boolean;
  /** It is in the agent already. */
  loaded: boolean;
}

/** The keys for one host, and which agent holds unlocked ones. */
export interface SshKeysView {
  /** session: the agent of the user's login session; hopdeck: hopdeck's own, gone when hopdeck stops. */
  agent: 'session' | 'hopdeck';
  keys: SshKeyInfo[];
}

/** The live ruleset as nft prints it; the UI parses it with parseRuleset() and parseListing(). */
export interface RulesetSnapshot {
  /** Output of `nft -j list ruleset`. */
  json: unknown;
  /** Output of `nft -a list ruleset`: the text form with handles. */
  listing: string;
  /** When hopdeck read it, ISO 8601. */
  readAt: string;
}

export interface HostSummary {
  id: string;
  kind: HostKind;
  name: string;
  destination?: string;
  status: HostStatus;
  /** Manual override is on: tables may be changed without adopting them. For this session only. */
  manualOverride: boolean;
}

/** One table change asked of the server. */
export type TableChange =
  | { kind: 'adopt'; family: Family; table: string }
  /**
   * `base` is the table as the editor first showed it; objects left as they
   * were there follow the host's current state (see refreshUntouched).
   */
  | { kind: 'replace'; family: Family; table: string; definition: string; base?: string }
  | { kind: 'delete'; family: Family; table: string }
  /** Elements of one named set or map, changed in place; the rest of the table stays as it is. */
  | { kind: 'elements'; family: Family; table: string; set: string; setKind: 'set' | 'map'; add: string[]; remove: string[] };

export type DeploymentState =
  /** Validated and waiting for the user to apply it. */
  | 'planned'
  /** nft rejected the change; nothing was applied. */
  | 'invalid'
  /** Applied; the host rolls it back unless confirmed before the deadline. */
  | 'awaiting-confirmation'
  | 'confirmed'
  | 'rolled-back'
  /** Applying failed; nothing changed. */
  | 'failed';

export interface DeploymentTable {
  family: Family;
  name: string;
  action: 'adopt' | 'create' | 'replace' | 'delete' | 'elements';
  /** The set or map whose elements change; for the elements action. */
  set?: { kind: 'set' | 'map'; name: string };
  /** nft's listing of the table before, without handles; undefined for a new table. */
  before: string | undefined;
  /** The definition to load; undefined when the table is deleted or only elements change. */
  after: string | undefined;
  /** What changes: lines of the table, or the elements of the set. */
  diff: DiffLine[];
  /** The nft input that makes the change, and the one that undoes it. */
  script: string;
  rollback: string;
  /**
   * The change touches only rules, so it is made rule by rule: the other rules
   * keep their handles, counters and limit state. The rollback still puts the
   * whole table back. Absent when the table is replaced whole.
   */
  inPlace?: { added: number; removed: number; replaced: number };
}

export interface DeploymentView {
  id: string;
  hostId: string;
  state: DeploymentState;
  tables: DeploymentTable[];
  /** nft -c on the host; a failure carries nft's message. */
  validation: { ok: boolean; message: string };
  /** How the change is protected, shown before applying. */
  safety: {
    /** How the rollback watchdog runs on the host. */
    watchdog: 'systemd' | 'detached' | 'unavailable';
    /** Seconds until the host rolls back an unconfirmed change. */
    seconds: number;
    /** Whether a new, unshared SSH connection is tried right after applying. */
    freshConnectionCheck: boolean;
    /** Where the change, rollback and watchdog files live on the host. */
    directory: string;
  };
  /** When the host rolls back on its own, ISO 8601; while awaiting confirmation. */
  deadline?: string;
  /** Why a change failed or was rolled back, with the raw message. */
  outcome?: { reason: 'nft-error' | 'fresh-connection-failed' | 'timeout' | 'user'; detail: string };
  manualOverride: boolean;
  /** The history version this change puts back. */
  restoredFrom?: number;
  /** What was saved for boot once the change was kept. */
  persisted?: PersistResult;
  /** The history version the kept change became, or why it did not. */
  recorded?: { version?: number; problem?: { code: HostErrorCode | 'unknown'; detail: string } };
}

/** Saving kept changes for boot; see docs/ARCHITECTURE.md, "Persisting". */
export interface PersistResult {
  /** Files written or removed. */
  written: string[];
  removed: string[];
  /** Tables changed through Manual override that hopdeck does not manage, hence not saved. */
  notManaged: string[];
  /** Why nothing (or not everything) could be saved. */
  problem?: { code: HostErrorCode; detail: string };
}

export interface PersistedTable {
  family: Family;
  name: string;
  file: string;
  /** saved: the file matches the live table; differs or missing: a reboot would load something else; orphaned: a file without a managed live table. */
  state: 'saved' | 'differs' | 'missing' | 'orphaned';
  /** The main configuration defines the table too; hopdeck's file replaces that definition at boot. */
  alsoInMainConfig: boolean;
}

/** Whether what hopdeck manages on a host survives a reboot. */
export interface PersistenceStatus {
  /** The file loaded at boot, e.g. /etc/nftables.conf. */
  mainConfig: string | undefined;
  /** service: read from the nftables service's command line; guess: a known path that exists. */
  source: 'service' | 'guess' | 'none';
  /** Whether the nftables service starts at boot; undefined without systemd or without the service. */
  serviceEnabled: boolean | undefined;
  /** Where hopdeck keeps a file per managed table, e.g. /etc/hopdeck/firewall. */
  directory: string;
  /** The main configuration includes the files in `directory`. */
  includePresent: boolean;
  /** The exact line hopdeck adds, to show before asking. */
  includeLine: string;
  tables: PersistedTable[];
  /** Why hopdeck cannot save anything on this host. */
  problem?: { code: HostErrorCode; detail: string };
}

/** A packet trace on a host: hopdeck marks packets matching the filter and records what nft reports about them. */
export interface TraceView {
  id: string;
  hostId: string;
  state: 'running' | 'finished' | 'failed';
  filter: TraceFilter;
  /** At most this many packets a second are marked. */
  perSecond: number;
  /** The temporary table on the host that marks packets. */
  table: string;
  /** Its definition, as loaded. */
  definition: string;
  startedAt: string;
  /** When the host removes the table on its own at the latest. */
  endsAt: string;
  /** What nft printed, trace lines and anything else, in order. */
  lines: string[];
  /** Lines left out after the limit, oldest first. */
  dropped: number;
  /** Why the trace failed or stopped early, with the raw message. */
  problem?: { code: string; detail: string };
  /** nft's output when removing the table failed. */
  cleanup?: string;
}
