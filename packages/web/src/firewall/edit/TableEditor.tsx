// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { Family } from '@hopdeck/core';
import { useEffect, useState } from 'react';
import { Callout } from '../../components/Callout.tsx';
import { AlertIcon } from '../../components/icons.tsx';
import { Segmented } from '../../components/Segmented.tsx';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import { formatBytes } from '../ruleset/model.ts';
import { CodeEditor } from './CodeEditor.tsx';
import styles from './Editor.module.css';
import { definitionErrorLines } from './nft-errors.ts';
import { definitionOf, type ChainState, type EditorSource, type SetState } from './table-model.ts';
import { VisualEditor } from './VisualEditor.tsx';

export type EditorMode = 'visual' | 'text';

/** nft's answer to the last attempt, and how many of its lines came before the edited definition. */
export interface EditorProblem {
  message: string;
  preamble: number;
}

/** Unsaved work, kept by the caller so it survives switching tabs. */
export interface EditorDraft {
  mode: EditorMode;
  chains: ChainState[];
  sets: SetState[];
  text: string;
}

interface TableEditorProps {
  family: Family;
  name: string;
  /** undefined: nft's listing has no such table. */
  source: EditorSource | undefined;
  initialMode: EditorMode;
  draft: EditorDraft | undefined;
  onDraft(draft: EditorDraft): void;
  /** Set when nft or hopdeck rejected the last attempt. */
  problem: EditorProblem | undefined;
  /** The table on the host no longer matches the one the editor read. */
  changedOnHost?: boolean;
  onReview(definition: string): void;
  onClose(): void;
}

/** Edits one table visually or as text; both produce a definition for review. */
export function TableEditor({ family, name, source, initialMode, draft, onDraft, problem, changedOnHost = false, onReview, onClose }: TableEditorProps) {
  const { t, locale } = useI18n();
  const [chains, setChains] = useState<ChainState[]>(() => draft?.chains ?? source?.chains ?? []);
  const [sets, setSets] = useState<SetState[]>(() => draft?.sets ?? source?.sets ?? []);
  const [mode, setMode] = useState<EditorMode>(draft?.mode ?? initialMode);
  const [text, setText] = useState(() => draft?.text ?? (source === undefined ? '' : definitionOf(source.table, source.chains, source.sets).text));
  const changed = source !== undefined && (source.creating || (mode === 'visual' ? definitionOf(source.table, chains, sets).text : text) !== source.original);

  useEffect(() => onDraft({ mode, chains, sets, text }), [mode, chains, sets, text]);

  // Closing or reloading the page would lose the edits.
  useEffect(() => {
    if (!changed) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [changed]);

  if (source === undefined) {
    return <Callout tone="danger" icon={<AlertIcon />} title={t('editor.notFound', { table: `${family} ${name}` })} />;
  }

  const visual = definitionOf(source.table, chains, sets);
  const definition = mode === 'visual' ? visual.text : text;
  // Text edits cannot be turned back into the visual model, which follows the live table.
  const textDiverged = mode === 'text' && text !== visual.text;
  const errorLines = problem === undefined ? [] : definitionErrorLines(problem.message, problem.preamble);
  const errorRows = new Set([...visual.lines].filter(([, line]) => errorLines.includes(line)).map(([key]) => key));
  const title = t(source.creating ? 'editor.titleNew' : 'editor.title', { table: `${family} ${name}` });

  const counterOf = (handle: number) => {
    const counter = source.counterOf(handle);
    return counter && `${new Intl.NumberFormat(locale).format(counter.packets)} / ${formatBytes(counter.bytes, locale)}`;
  };

  return (
    <section className={styles.editor} aria-label={title}>
      <div className={styles.toolbar}>
        <h2 className={styles.title}>{title}</h2>
        <Segmented<EditorMode>
          label={t('editor.mode')}
          value={mode}
          onChange={(next) => {
            if (next === 'text') setText(visual.text);
            setMode(next);
          }}
          options={[
            { value: 'visual', label: t('editor.visual'), disabled: textDiverged, ...(textDiverged && { title: t('editor.visualBlocked') }) },
            { value: 'text', label: t('editor.text') },
          ]}
        />
        <span className={styles.spacer} />
        <button type="button" className="btn" onClick={onClose}>
          {t(changed ? 'editor.discard' : 'common.close')}
        </button>
        <button type="button" className="btn btn-primary" disabled={!changed} onClick={() => onReview(definition)}>
          {t('editor.review')}
        </button>
      </div>

      {changedOnHost && (
        <Callout tone="warn" icon={<AlertIcon />} title={t('editor.changedOnHost')} role="status">
          {t('editor.changedOnHostHint')}
        </Callout>
      )}

      {problem !== undefined && (
        <Callout tone="danger" icon={<AlertIcon />} title={t('editor.rejected')} role="alert">
          {errorLines.length > 0 && <p>{t(mode === 'visual' ? 'editor.rejectedRows' : 'editor.rejectedLines')}</p>}
          <pre className="details">{problem.message}</pre>
        </Callout>
      )}

      {mode === 'visual' ? (
        <VisualEditor
          family={family}
          table={name}
          chains={chains}
          sets={sets}
          counters={source.counters}
          counterOf={counterOf}
          errorRows={errorRows}
          onChange={setChains}
          onSetsChange={setSets}
        />
      ) : (
        <>
          <p className={styles.note}>{t('editor.textNote')}</p>
          <CodeEditor value={text} onChange={setText} errorLines={errorLines} label={t('editor.textLabel', { table: `${family} ${name}` })} />
        </>
      )}
    </section>
  );
}
