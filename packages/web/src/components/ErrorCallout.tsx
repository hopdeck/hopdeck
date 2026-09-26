import { RulesetParseError } from '@hopdeck/core';
import { ApiError } from '../api.ts';
import { errorText } from '../errors.ts';
import { useI18n, type I18n } from '../i18n/I18nProvider.tsx';
import type { Vars } from '../i18n/translate.ts';
import { Callout } from './Callout.tsx';
import { AlertIcon } from './icons.tsx';

export interface ErrorInfo {
  code: string;
  /** The raw message: stderr of ssh, sudo or nft, or the server's own message. */
  message: string;
}

/** Turns anything caught into a code and the real message. */
export function toErrorInfo(caught: unknown): ErrorInfo {
  if (caught instanceof ApiError) return { code: caught.code, message: caught.message };
  if (caught instanceof RulesetParseError) return { code: 'invalid-ruleset', message: caught.message };
  const message = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
  return { code: 'ui-error', message };
}

export function errorTitle(t: I18n['t'], code: string): string {
  const text = errorText(code);
  return text === undefined ? t('error.unexpected', { code }) : t(text.title);
}

/**
 * The hint for an error and its raw message. The raw message is always shown:
 * translations add context, they never replace what actually happened.
 */
export function ErrorBody({ error, vars }: { error: ErrorInfo; vars?: Vars }) {
  const { t } = useI18n();
  const hint = errorText(error.code)?.hint;
  const message = error.message.trim();
  return (
    <>
      {hint !== undefined && <p>{t(hint, vars)}</p>}
      {message !== '' && message !== error.code && (
        <div>
          <p className="details-label">{t('error.original')}</p>
          <pre className="details">{message}</pre>
        </div>
      )}
    </>
  );
}

export function ErrorCallout({ error, vars }: { error: ErrorInfo; vars?: Vars }) {
  const { t } = useI18n();
  return (
    <Callout tone="danger" icon={<AlertIcon />} title={errorTitle(t, error.code)} role="alert">
      <ErrorBody error={error} vars={vars} />
    </Callout>
  );
}
