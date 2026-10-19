// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { INCLUDE_POSITIONS, includeChanges, includeForm, includeProblems, type FirewallInclude, type IncludeForm } from '@hopdeck/core';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { ErrorCallout, toErrorInfo, type ErrorInfo } from '../components/ErrorCallout.tsx';
import { EditIcon, EyeIcon, PlusIcon, TrashIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/locales.ts';
import { Field } from '../firewall/edit/fields.tsx';
import editor from '../firewall/edit/Editor.module.css';
import type { RulesetModel } from '../firewall/ruleset/model.ts';
import { NftCode } from '../firewall/ruleset/NftCode.tsx';
import { fieldErrors, FormDialog } from './FormDialog.tsx';
import styles from './OpenWrt.module.css';
import { touchedSections, type UciFirewallState } from './useUciFirewall.ts';
import { problemText } from './ZonesPanel.tsx';

interface IncludesPanelProps {
  hostId: string;
  state: UciFirewallState;
  model: RulesetModel | undefined;
}

/** Where an include goes, in words; fw4's default when the section does not say. */
function positionText(t: ReturnType<typeof useI18n>['t'], position: string | undefined, chain: string | undefined): string {
  if (position === undefined || position === '') return t('uci.includes.position.default');
  const where = (INCLUDE_POSITIONS as readonly string[]).includes(position) ? t(`uci.includes.position.${position}` as MessageKey) : position;
  return position.startsWith('chain-') && chain !== undefined ? `${where}: ${chain}` : where;
}

/**
 * nftables of one's own inside fw4's ruleset: files fw4 includes at a
 * position, which UCI points to, so LuCI and a rollback see them. hopdeck
 * writes its own, a new file for each version; the others it shows.
 */
export function IncludesPanel({ hostId, state, model }: IncludesPanelProps) {
  const { t } = useI18n();
  const [dialog, setDialog] = useState<{ include?: FirewallInclude; opening: number }>();
  const [viewing, setViewing] = useState<string>();
  const [automatic, setAutomatic] = useState<string[]>();
  const firewall = state.firewall!;
  const touched = touchedSections(state.pending);

  useEffect(() => {
    let current = true;
    api.get<{ paths: string[] }>(`/hosts/${encodeURIComponent(hostId)}/uci/firewall/automatic-includes`).then(
      (read) => current && setAutomatic(read.paths),
      () => current && setAutomatic([]),
    );
    return () => {
      current = false;
    };
  }, [hostId, state.base]);

  return (
    <div className={styles.panel}>
      <p className={styles.note}>{t('uci.includes.intro')}</p>
      <div className={styles.bar}>
        <button type="button" className="btn btn-primary" onClick={() => setDialog({ opening: Date.now() })}>
          <PlusIcon />
          {t('uci.includes.add')}
        </button>
      </div>
      {firewall.includes.length === 0 ? (
        <p className={styles.note}>{t('uci.includes.none')}</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t('uci.rules.name')}</th>
              <th>{t('uci.includes.where')}</th>
              <th>{t('uci.includes.file')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {firewall.includes.map((include) => {
              const nftables = include.type === 'nftables';
              return (
                <tr key={include.section.name} className={`${include.enabled && nftables ? '' : styles.off} ${touched.has(include.section.name) ? styles.changed : ''}`}>
                  <td className={`${styles.name} ${styles.nowrap}`}>
                    {include.section.anonymous ? <span className={styles.muted}>{include.section.name}</span> : include.section.name}
                    {!include.managed && <span className={`${styles.badge} ${styles.inlineBadge}`}>{t(nftables ? 'uci.includes.notOurs' : 'uci.includes.script')}</span>}
                  </td>
                  <td>{nftables ? positionText(t, include.position, include.chain) : <span className={styles.muted}>{t('uci.includes.scriptIgnored')}</span>}</td>
                  <td className={styles.mono}>{include.path ?? '–'}</td>
                  <td className={styles.actionsCell}>
                    <span className={styles.buttons}>
                      {include.managed ? (
                        <button type="button" className="btn btn-ghost btn-sm btn-icon" title={t('uci.edit')} aria-label={t('uci.edit')} onClick={() => setDialog({ include, opening: Date.now() })}>
                          <EditIcon />
                        </button>
                      ) : (
                        include.path !== undefined && (
                          <button type="button" className="btn btn-ghost btn-sm btn-icon" title={t('uci.includes.view')} aria-label={t('uci.includes.view')} onClick={() => setViewing(include.path)}>
                            <EyeIcon />
                          </button>
                        )
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm btn-icon btn-danger"
                        title={t('uci.remove')}
                        aria-label={t('uci.remove')}
                        onClick={() => {
                          if (window.confirm(t(include.managed ? 'uci.includes.removeConfirm' : 'uci.includes.removeOtherConfirm', { name: include.section.name }))) {
                            state.change([{ kind: 'delete', section: include.section.name }]);
                          }
                        }}
                      >
                        <TrashIcon />
                      </button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {automatic !== undefined && automatic.length > 0 && (
        <>
          <h3 className={styles.section}>{t('uci.includes.automatic')}</h3>
          <p className={styles.note}>{t('uci.includes.automaticHint')}</p>
          <ul className={styles.files}>
            {automatic.map((path) => (
              <li key={path}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setViewing(path)}>
                  <EyeIcon />
                  <span className="mono">{path}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {dialog !== undefined && <IncludeDialog hostId={hostId} state={state} model={model} include={dialog.include} opening={dialog.opening} onClose={() => setDialog(undefined)} />}
      {viewing !== undefined && <ViewDialog hostId={hostId} path={viewing} onClose={() => setViewing(undefined)} />}
    </div>
  );
}

/** Reads a file fw4 includes, from the pending changes when they hold it, else from the router. */
function useIncludeContent(hostId: string, state: UciFirewallState, path: string | undefined): { content: string | undefined; error: ErrorInfo | undefined } {
  const [content, setContent] = useState<string>();
  const [error, setError] = useState<ErrorInfo>();
  useEffect(() => {
    if (path === undefined) {
      setContent('');
      return;
    }
    const pending = state.files[path];
    if (pending !== undefined) {
      setContent(pending);
      return;
    }
    let current = true;
    api.get<{ content: string }>(`/hosts/${encodeURIComponent(hostId)}/uci/firewall/include?path=${encodeURIComponent(path)}`).then(
      (read) => current && setContent(read.content),
      (caught: unknown) => current && setError(toErrorInfo(caught)),
    );
    return () => {
      current = false;
    };
  }, [hostId, path]);
  return { content, error };
}

function ViewDialog({ hostId, path, onClose }: { hostId: string; path: string; onClose(): void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [content, setContent] = useState<string>();
  const [error, setError] = useState<ErrorInfo>();
  useEffect(() => {
    dialog.current?.showModal();
    let current = true;
    api.get<{ content: string }>(`/hosts/${encodeURIComponent(hostId)}/uci/firewall/include?path=${encodeURIComponent(path)}`).then(
      (read) => current && setContent(read.content),
      (caught: unknown) => current && setError(toErrorInfo(caught)),
    );
    return () => {
      current = false;
    };
  }, [hostId, path]);
  return (
    <dialog ref={dialog} className={`${editor.dialog} ${styles.wideDialog}`} onClose={onClose} aria-labelledby="include-view-title">
      <div className={editor.dialogBody}>
        <h2 id="include-view-title" className={`${editor.dialogTitle} mono`}>
          {path}
        </h2>
        {error !== undefined && <ErrorCallout error={error} />}
        {content === undefined && error === undefined && <span className="spinner" aria-hidden="true" />}
        {content !== undefined && (content.trim() === '' ? <p className={editor.note}>{t('uci.includes.empty')}</p> : <NftCode block text={content.trimEnd()} />)}
      </div>
      <div className={editor.dialogFooter}>
        <span className={editor.spacer} />
        <button type="button" className="btn" onClick={() => dialog.current?.close()}>
          {t('common.close')}
        </button>
      </div>
    </dialog>
  );
}

function IncludeDialog({ hostId, state, model, include, opening, onClose }: IncludesPanelProps & { include: FirewallInclude | undefined; opening: number; onClose(): void }) {
  const { t } = useI18n();
  const firewall = state.firewall!;
  const loaded = useIncludeContent(hostId, state, include?.path);
  const [form, setForm] = useState<IncludeForm>(() => includeForm(include, ''));
  const [ready, setReady] = useState(include === undefined);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (loaded.content !== undefined && !ready) {
      setForm((current) => ({ ...current, content: loaded.content! }));
      setReady(true);
    }
  }, [loaded.content]);
  const problems = includeProblems(firewall, include, form);
  const { errorOf, invalid } = fieldErrors(problems, (problem) => problemText(t, problem), touched, revealed);
  const edit = (field: string, next: Partial<IncludeForm>) => {
    setTouched((current) => new Set([...current, field]));
    setForm((current) => ({ ...current, ...next }));
  };
  // The chains of fw4's table, as the router has them now.
  const chains = model?.ruleset.tables.find((node) => node.table.family === 'inet' && node.table.name === 'fw4')?.chains.map((node) => node.chain.name) ?? [];
  const chainOptions = [...new Set([...chains, ...(form.chain === '' ? [] : [form.chain])])];
  const committedPath = state.base?.sections.find((section) => section.name === include?.section.name)?.options['path'];

  return (
    <FormDialog
      open
      opening={opening}
      title={include === undefined ? t('uci.includes.new') : t('uci.includes.edit', { name: include.section.name })}
      intro={t('uci.includes.dialogIntro')}
      onClose={onClose}
      onSave={() => {
        if (!ready) return;
        if (problems.length > 0) {
          setRevealed(true);
          return;
        }
        const { changes, file } = includeChanges(include, form, {
          committedPath: typeof committedPath === 'string' ? committedPath : undefined,
          contentChanged: include === undefined || form.content !== loaded.content,
        });
        state.change(changes, file);
        onClose();
      }}
    >
      {include === undefined ? (
        <Field label={t('uci.rules.name')} error={errorOf('name')}>
          <input className="input mono" value={form.name} maxLength={32} spellCheck={false} autoFocus aria-invalid={invalid('name')} placeholder="ssh_limits"
            onChange={(event) => edit('name', { name: event.target.value })} />
        </Field>
      ) : null}
      <label className={editor.option}>
        <input type="checkbox" checked={form.enabled} onChange={(event) => edit('enabled', { enabled: event.target.checked })} />
        {t('uci.redirects.enabled')}
      </label>
      <Field label={t('uci.includes.where')}>
        <select className="select" value={form.position} onChange={(event) => edit('position', { position: event.target.value })}>
          {form.position === '' && <option value="">{t('uci.includes.position.default')}</option>}
          {INCLUDE_POSITIONS.map((position) => (
            <option key={position} value={position}>
              {t(`uci.includes.position.${position}` as MessageKey)}
            </option>
          ))}
        </select>
      </Field>
      {form.position.startsWith('chain-') && (
        <Field label={t('uci.includes.chain')} error={errorOf('chain')}>
          <select className="select mono" value={form.chain} aria-invalid={invalid('chain')} onChange={(event) => edit('chain', { chain: event.target.value })}>
            {form.chain === '' && <option value="" />}
            {chainOptions.map((chain) => (
              <option key={chain} value={chain}>
                {chain}
              </option>
            ))}
          </select>
        </Field>
      )}
      <p className={editor.note}>{t(`uci.includes.syntax.${form.position.startsWith('chain-') ? 'chain' : form.position.startsWith('ruleset-') ? 'ruleset' : 'table'}` as MessageKey)}</p>
      {loaded.error !== undefined && <ErrorCallout error={loaded.error} />}
      <Field label={t('uci.includes.content')} error={errorOf('content')}>
        <textarea className={`input mono ${editor.textarea}`} rows={14} value={ready ? form.content : ''} disabled={!ready} spellCheck={false} aria-invalid={invalid('content')}
          placeholder={form.position.startsWith('chain-') ? 'tcp dport 22 ct state new limit rate 10/minute accept' : 'set allowed { type ipv4_addr; flags interval; }'}
          onChange={(event) => edit('content', { content: event.target.value })} />
      </Field>
      <p className={editor.note}>{t('uci.includes.checked')}</p>
    </FormDialog>
  );
}
