import type { MessageKey } from './i18n/locales.ts';

export interface ErrorText {
  title: MessageKey;
  hint?: MessageKey;
}

// Codes come from the server (HostErrorCode and API codes), plus the UI's own:
// backend-unreachable (no response at all), invalid-ruleset (nft's output did
// not parse) and ui-error (a bug in the panel).
const TEXTS = new Map<string, ErrorText>([
  ['ssh-host-key', { title: 'error.ssh-host-key.title', hint: 'error.ssh-host-key.hint' }],
  ['ssh-host-key-changed', { title: 'error.ssh-host-key-changed.title', hint: 'error.ssh-host-key-changed.hint' }],
  ['ssh-auth', { title: 'error.ssh-auth.title', hint: 'error.ssh-auth.hint' }],
  ['ssh-connect', { title: 'error.ssh-connect.title', hint: 'error.ssh-connect.hint' }],
  ['timeout', { title: 'error.timeout.title', hint: 'error.timeout.hint' }],
  ['spawn-failed', { title: 'error.spawn-failed.title', hint: 'error.spawn-failed.hint' }],
  ['command-failed', { title: 'error.command-failed.title' }],
  ['nft-missing', { title: 'error.nft-missing.title' }],
  ['no-privileges', { title: 'error.no-privileges.title' }],
  ['password-required', { title: 'error.password-required.title' }],
  ['wrong-password', { title: 'error.wrong-password.title', hint: 'error.wrong-password.hint' }],
  ['sudo-not-allowed', { title: 'error.sudo-not-allowed.title' }],
  ['host-key-mismatch', { title: 'error.host-key-mismatch.title', hint: 'error.host-key-mismatch.hint' }],
  ['known-hosts-unwritable', { title: 'error.known-hosts-unwritable.title', hint: 'error.known-hosts-unwritable.hint' }],
  ['host-key-in-global-file', { title: 'error.host-key-in-global-file.title', hint: 'error.host-key-in-global-file.hint' }],
  ['invalid-host', { title: 'error.invalid-host.title' }],
  ['host-state-changed', { title: 'error.host-state-changed.title', hint: 'error.host-state-changed.hint' }],
  ['unauthorized', { title: 'error.unauthorized.title', hint: 'error.unauthorized.hint' }],
  ['internal-error', { title: 'error.internal-error.title', hint: 'error.internal-error.hint' }],
  ['backend-unreachable', { title: 'error.backend-unreachable.title', hint: 'error.backend-unreachable.hint' }],
  ['invalid-ruleset', { title: 'error.invalid-ruleset.title' }],
  ['table-not-editable', { title: 'error.table-not-editable.title' }],
  ['invalid-definition', { title: 'error.invalid-definition.title' }],
  ['ruleset-changed', { title: 'error.ruleset-changed.title', hint: 'error.ruleset-changed.hint' }],
  ['rollback-unavailable', { title: 'error.rollback-unavailable.title', hint: 'error.rollback-unavailable.hint' }],
  ['deployment-state', { title: 'error.deployment-state.title', hint: 'error.deployment-state.hint' }],
  ['deployment-not-found', { title: 'error.deployment-not-found.title', hint: 'error.deployment-not-found.hint' }],
  ['persistence-unavailable', { title: 'error.persistence-unavailable.title' }],
  ['include-rejected', { title: 'error.include-rejected.title', hint: 'error.include-rejected.hint' }],
  ['invalid-filter', { title: 'error.invalid-filter.title', hint: 'error.invalid-filter.hint' }],
  ['trace-unavailable', { title: 'error.trace-unavailable.title', hint: 'error.trace-unavailable.hint' }],
  ['trace-not-found', { title: 'error.trace-not-found.title', hint: 'error.trace-not-found.hint' }],
  ['platform-read-only', { title: 'error.platform-read-only.title' }],
  ['ui-error', { title: 'error.ui-error.title', hint: 'error.ui-error.hint' }],
]);

/** Title and hint for a known code; unknown codes get a generic title that names the code. */
export function errorText(code: string): ErrorText | undefined {
  return TEXTS.get(code);
}
