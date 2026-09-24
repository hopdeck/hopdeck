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
  | 'sudo-not-allowed';

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

export interface HostSummary {
  id: string;
  kind: HostKind;
  name: string;
  destination?: string;
  status: HostStatus;
}
