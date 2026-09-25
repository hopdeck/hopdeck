import type { HostFacts, HostKind, HostStatus, HostSummary, Privilege } from '@nftm/core';
import { useEffect, useState, type FormEvent } from 'react';
import { Callout } from '../components/Callout.tsx';
import { ErrorBody, ErrorCallout, errorTitle, toErrorInfo, type ErrorInfo } from '../components/ErrorCallout.tsx';
import { AlertIcon, CheckIcon, HostKindIcon, LockIcon, RefreshIcon, SandboxIcon, TrashIcon } from '../components/icons.tsx';
import { Tabs } from '../components/Tabs.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/locales.ts';
import { ListingView } from '../ruleset/ListingView.tsx';
import { PacketPathView } from '../ruleset/PacketPathView.tsx';
import { RulesetView } from '../ruleset/RulesetView.tsx';
import { useRuleset, type RulesetState } from '../ruleset/useRuleset.ts';
import { HostKeyPanel } from './HostKeyPanel.tsx';
import styles from './HostView.module.css';
import { hostSubtitle } from './status.ts';

type Connected = Extract<HostStatus, { state: 'connected' }>;

/** Whether nft can run as root now, i.e. the ruleset can be read. */
function fullAccess(status: HostStatus): boolean {
  if (status.state !== 'connected' || status.facts.nft === undefined) return false;
  const { privilege } = status;
  return privilege.kind === 'root' || privilege.kind === 'sudo' || (privilege.kind === 'sudo-password' && status.passwordStored);
}

const ACCESS_BADGES: Record<'root' | 'sudo' | 'sudo-password', { label: MessageKey; title: MessageKey }> = {
  root: { label: 'access.badge.root', title: 'access.root' },
  sudo: { label: 'access.badge.sudo', title: 'access.sudo' },
  'sudo-password': { label: 'access.badge.sudoPassword', title: 'access.sudoPasswordStored' },
};

interface HostViewProps {
  host: HostSummary;
  connecting: boolean;
  onConnect(): void;
  onRemove(): void;
  /** Rejects with an ApiError, e.g. code "wrong-password". */
  onUnlock(password: string): Promise<void>;
  /** A newer state of this host, e.g. after its key was trusted. */
  onUpdate(host: HostSummary): void;
}

export function HostView({ host, connecting, onConnect, onRemove, onUnlock, onUpdate }: HostViewProps) {
  const { t } = useI18n();
  const { status } = host;
  const subtitle = hostSubtitle(host);
  const readable = fullAccess(status);
  const ruleset = useRuleset(host.id, readable);
  const [tab, setTab] = useState('rules');
  // A chain to scroll to once the rules tab is shown, e.g. picked in the packet path.
  const [scrollTarget, setScrollTarget] = useState<string>();

  useEffect(() => {
    if (tab !== 'rules' || scrollTarget === undefined) return;
    setScrollTarget(undefined);
    const element = document.getElementById(scrollTarget);
    if (element === null) return;
    element.closest('details')?.setAttribute('open', '');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    if (!reduceMotion) {
      element.animate([{ backgroundColor: 'var(--accent-soft)' }, { backgroundColor: 'transparent' }], { duration: 1800 });
    }
  }, [tab, scrollTarget]);
  const badge =
    readable && status.state === 'connected' && status.privilege.kind !== 'none' ? ACCESS_BADGES[status.privilege.kind] : undefined;

  return (
    <section className={styles.view} aria-labelledby="host-title">
      <header className={styles.header}>
        <div className={styles.identity}>
          <span className={styles.icon}>
            <HostKindIcon kind={host.kind} />
          </span>
          <div className={styles.names}>
            <h1 id="host-title" className={styles.title}>
              {host.name}
            </h1>
            <p className={styles.subtitle}>
              <span className={'text' in subtitle ? 'mono' : undefined}>{'text' in subtitle ? subtitle.text : t(subtitle.key)}</span>
              {badge !== undefined && (
                <span className={styles.accessBadge} title={t(badge.title)}>
                  <CheckIcon />
                  {t(badge.label)}
                </span>
              )}
            </p>
          </div>
        </div>
        <div className={styles.actions}>
          <button type="button" className="btn" onClick={onConnect} disabled={connecting}>
            {connecting ? <span className="spinner" aria-hidden="true" /> : <RefreshIcon />}
            {t(status.state === 'new' ? 'host.connect' : 'host.reconnect')}
          </button>
          {host.kind === 'ssh' && (
            <button type="button" className="btn btn-ghost btn-danger" onClick={onRemove}>
              <TrashIcon />
              {t('host.remove')}
            </button>
          )}
        </div>
      </header>

      {host.kind === 'sandbox' && (
        <Callout tone="info" icon={<SandboxIcon />} title={t('host.sandboxTitle')}>
          {t('host.sandboxNote')}
        </Callout>
      )}

      {status.state === 'new' && (
        <p className={styles.loading} role="status">
          <span className="spinner" aria-hidden="true" />
          {t('status.connecting')}
        </p>
      )}

      {status.state === 'error' && (
        <ErrorCallout
          error={{ code: status.error.code, message: status.error.detail }}
          vars={{ destination: host.destination ?? host.name }}
        />
      )}

      {status.state === 'error' && host.kind === 'ssh' && ['ssh-host-key', 'ssh-host-key-changed'].includes(status.error.code) && (
        <HostKeyPanel hostId={host.id} changed={status.error.code === 'ssh-host-key-changed'} onTrusted={onUpdate} />
      )}

      {status.state === 'connected' && !readable && (
        <>
          <Access status={status} kind={host.kind} onUnlock={onUnlock} />
          <Facts facts={status.facts} />
        </>
      )}

      {readable && status.state === 'connected' && (
        <Tabs
          label={t('tabs.label')}
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'rules', label: t('tabs.rules'), content: <RulesetView state={ruleset} /> },
            {
              id: 'path',
              label: t('tabs.path'),
              content:
                ruleset.model !== undefined ? (
                  <PacketPathView
                    model={ruleset.model}
                    onShowChain={(anchor) => {
                      setScrollTarget(anchor);
                      setTab('rules');
                    }}
                  />
                ) : (
                  <Listing state={ruleset} />
                ),
            },
            { id: 'text', label: t('tabs.text'), content: <Listing state={ruleset} /> },
            { id: 'system', label: t('tabs.system'), content: <Facts facts={status.facts} /> },
          ]}
        />
      )}
    </section>
  );
}

function Listing({ state }: { state: RulesetState }) {
  const { t } = useI18n();
  if (state.model !== undefined) return <ListingView text={state.model.text} />;
  if (state.error !== undefined) return <ErrorCallout error={state.error} />;
  return (
    <p className={styles.loading} role="status">
      <span className="spinner" aria-hidden="true" />
      {t('ruleset.loading')}
    </p>
  );
}

function Access({ status, kind, onUnlock }: { status: Connected; kind: HostKind; onUnlock: HostViewProps['onUnlock'] }) {
  const { t } = useI18n();
  const { privilege, facts } = status;

  if (facts.nft === undefined) {
    return <Callout tone="danger" icon={<AlertIcon />} title={t('access.nftMissing')} />;
  }
  if (privilege.kind === 'none') return <NoAccess privilege={privilege} facts={facts} kind={kind} />;
  // Full access shows as a badge in the header; what is left is the password prompt.
  return <PasswordPrompt onUnlock={onUnlock} />;
}

/** Where sudo membership comes from on common distributions. */
function sudoGroup(osId: string | undefined): string | undefined {
  if (osId === undefined) return undefined;
  if (['debian', 'ubuntu', 'linuxmint', 'pop', 'raspbian', 'kali'].includes(osId)) return 'sudo';
  if (['fedora', 'rhel', 'centos', 'rocky', 'almalinux', 'ol', 'amzn', 'arch'].includes(osId)) return 'wheel';
  return undefined;
}

function NoAccess({ privilege, facts, kind }: { privilege: Extract<Privilege, { kind: 'none' }>; facts: HostFacts; kind: HostKind }) {
  const { t } = useI18n();
  const user = facts.user || `uid ${facts.uid}`;
  const raw = privilege.detail.trim();

  let title: string;
  let hints: string[];
  if (privilege.reason === 'sudo-not-allowed') {
    const group = sudoGroup(facts.os?.id);
    title = t('access.notAllowedTitle', { user });
    hints = [group ? t('access.notAllowedHintGroup', { user, group }) : t('access.notAllowedHint', { user })];
    // sudo checks the groups of the process that runs it, i.e. of nftm itself.
    if (kind === 'local') hints.push(t('access.restartNote'));
  } else if (privilege.reason === 'sudo-missing') {
    title = t('access.sudoMissingTitle');
    hints = [t('access.sudoMissingHint')];
  } else {
    title = t('access.noneTitle');
    hints = [t('access.noneHint')];
  }

  return (
    <Callout tone="warn" icon={<AlertIcon />} title={title}>
      {hints.map((hint) => (
        <p key={hint}>{hint}</p>
      ))}
      {raw !== '' && (
        <div>
          <p className="details-label">{t('error.original')}</p>
          <pre className="details">{raw}</pre>
        </div>
      )}
    </Callout>
  );
}

function PasswordPrompt({ onUnlock }: { onUnlock: HostViewProps['onUnlock'] }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError(null);
    try {
      await onUnlock(String(new FormData(form).get('password') ?? ''));
    } catch (caught) {
      setError(toErrorInfo(caught));
      form.reset();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Callout tone="warn" icon={<LockIcon />} title={t('access.passwordTitle')}>
      <p>{t('access.passwordHint')}</p>
      <form className={styles.passwordForm} onSubmit={submit}>
        <label className="visually-hidden" htmlFor="sudo-password">
          {t('access.passwordLabel')}
        </label>
        <input
          id="sudo-password"
          name="password"
          type="password"
          className="input"
          placeholder={t('access.passwordLabel')}
          autoComplete="off"
          required
        />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {t('access.unlock')}
        </button>
      </form>
      {error !== null && (
        <div className={styles.error} role="alert">
          <p className={styles.errorTitle}>{errorTitle(t, error.code)}</p>
          <ErrorBody error={error} />
        </div>
      )}
    </Callout>
  );
}

function Facts({ facts }: { facts: HostFacts }) {
  const { t } = useI18n();
  return (
    <div className="card">
      <h2 className={styles.cardTitle}>{t('facts.title')}</h2>
      <dl className={styles.facts}>
        <dt>{t('facts.os')}</dt>
        <dd>{facts.os?.name || t('facts.unknown')}</dd>
        <dt>{t('facts.kernel')}</dt>
        <dd className="mono">{facts.kernel}</dd>
        <dt>{t('facts.nft')}</dt>
        <dd>{facts.nft ? <span className="mono">{facts.nft.version}</span> : t('facts.notInstalled')}</dd>
        {facts.nft && (
          <>
            <dt>{t('facts.nftPath')}</dt>
            <dd className="mono">{facts.nft.path}</dd>
          </>
        )}
        <dt>{t('facts.systemd')}</dt>
        <dd>{t(facts.systemd ? 'facts.yes' : 'facts.no')}</dd>
        <dt>{t('facts.hostname')}</dt>
        <dd className="mono">{facts.hostname}</dd>
        <dt>{t('facts.user')}</dt>
        <dd className="mono">{facts.user ? `${facts.user} (uid ${facts.uid})` : `uid ${facts.uid}`}</dd>
      </dl>
    </div>
  );
}
