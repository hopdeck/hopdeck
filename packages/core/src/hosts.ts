/** Shapes of the hosts API, shared by the server and the UI. */

import type { DiffLine } from './diff.ts';
import type { Family } from './nft-json.ts';

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
  | 'deployment-state';

export interface HostFacts {
  uid: number;
  user: string;
  hostname: string;
  kernel: string;
  os: { id: string; version: string; name: string } | undefined;
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

/** What nftm found out about an SSH host's key, for the user to confirm. */
export interface HostKeyCheck {
  /** How known_hosts names the host, e.g. "fw1" or "[10.0.0.1]:2222". */
  name: string;
  /** Where nftm would write the key: the first known_hosts file ssh uses for this host. */
  knownHostsFile: string;
  /** The key the server presents now. */
  presented: HostKey;
  /** Keys that known_hosts files already hold for this name; any that differ from `presented` mean the key changed. */
  known: (HostKey & { file: string })[];
}

/** The live ruleset as nft prints it; the UI parses it with parseRuleset() and parseListing(). */
export interface RulesetSnapshot {
  /** Output of `nft -j list ruleset`. */
  json: unknown;
  /** Output of `nft -a list ruleset`: the text form with handles. */
  listing: string;
  /** When nftm read it, ISO 8601. */
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
  | { kind: 'replace'; family: Family; table: string; definition: string }
  | { kind: 'delete'; family: Family; table: string };

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
  action: 'adopt' | 'create' | 'replace' | 'delete';
  /** nft's listing of the table before, without handles; undefined for a new table. */
  before: string | undefined;
  /** The definition to load; undefined when the table is deleted. */
  after: string | undefined;
  diff: DiffLine[];
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
}
