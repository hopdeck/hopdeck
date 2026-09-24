import type { HostErrorCode, HostSummary } from '@nftm/core';
import type { MessageKey } from '../i18n/locales.ts';

export type Tone = 'neutral' | 'busy' | 'ok' | 'warn' | 'danger';

/** The host's state in one colour and one short label, for the host list. */
export function hostStatus(host: HostSummary, connecting: boolean): { tone: Tone; label: MessageKey } {
  if (connecting) return { tone: 'busy', label: 'status.connecting' };
  const { status } = host;
  if (status.state === 'new') return { tone: 'neutral', label: 'status.new' };
  if (status.state === 'error') return { tone: 'danger', label: 'status.error' };
  if (status.facts.nft === undefined) return { tone: 'danger', label: 'status.nftMissing' };
  switch (status.privilege.kind) {
    case 'root':
    case 'sudo':
      return { tone: 'ok', label: 'status.ready' };
    case 'sudo-password':
      return status.passwordStored ? { tone: 'ok', label: 'status.ready' } : { tone: 'warn', label: 'status.locked' };
    case 'none':
      return { tone: 'warn', label: 'status.limited' };
  }
}

/** Second line under a host's name: its SSH destination or what the built-in host is. */
export function hostSubtitle(host: HostSummary): { key: MessageKey } | { text: string } {
  if (host.kind === 'local') return { key: 'hosts.kind.local' };
  if (host.kind === 'sandbox') return { key: 'hosts.kind.sandbox' };
  return { text: host.destination ?? '' };
}

type ErrorCode = HostErrorCode | 'invalid-host' | 'unknown';

const ERROR_TITLES: Partial<Record<ErrorCode, MessageKey>> = {
  'ssh-host-key': 'error.ssh-host-key.title',
  'ssh-host-key-changed': 'error.ssh-host-key-changed.title',
  'ssh-auth': 'error.ssh-auth.title',
  'ssh-connect': 'error.ssh-connect.title',
  timeout: 'error.timeout.title',
  'spawn-failed': 'error.spawn-failed.title',
  'wrong-password': 'error.wrong-password.title',
  'invalid-host': 'error.invalid-host.title',
};

const ERROR_HINTS: Partial<Record<ErrorCode, MessageKey>> = {
  'ssh-host-key': 'error.ssh-host-key.hint',
  'ssh-host-key-changed': 'error.ssh-host-key-changed.hint',
  'ssh-auth': 'error.ssh-auth.hint',
  'ssh-connect': 'error.ssh-connect.hint',
};

/** Error codes come from the server; unknown ones get a generic title. */
export function errorTitle(code: string): MessageKey {
  return ERROR_TITLES[code as ErrorCode] ?? 'error.unknown.title';
}

export function errorHint(code: string): MessageKey | undefined {
  return ERROR_HINTS[code as ErrorCode];
}
