/**
 * Stable codes the UI translates; `detail` carries the raw message (usually
 * stderr of ssh, sudo or nft) for display next to the translation.
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
  | 'wrong-password';

export class HostError extends Error {
  override name = 'HostError';
  readonly code: HostErrorCode;
  readonly detail: string;

  constructor(code: HostErrorCode, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}
