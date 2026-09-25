/** Shapes of the hosts API, shared by the server and the UI. */

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
  | 'host-key-in-global-file';

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
}
