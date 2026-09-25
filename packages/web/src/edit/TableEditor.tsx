import { editableTable, renderTable, type TableNode } from '@nftm/core';
import { useEffect, useMemo, useState } from 'react';
import { Callout } from '../components/Callout.tsx';
import { AlertIcon } from '../components/icons.tsx';
import { Segmented } from '../components/Segmented.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { formatBytes, ruleCounter, type RulesetModel } from '../ruleset/model.ts';
import { CodeEditor } from './CodeEditor.tsx';
import styles from './Editor.module.css';
import { definitionErrorLines } from './nft-errors.ts';
import { definitionOf, initialChains, type ChainState } from './table-model.ts';
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
  text: string;
}

interface TableEditorProps {
  model: RulesetModel;
  node: TableNode;
  initialMode: EditorMode;
  draft: EditorDraft | undefined;
  onDraft(draft: EditorDraft): void;
  /** Set when nft or nftm rejected the last attempt. */
  problem: EditorProblem | undefined;
  onReview(definition: string): void;
  onClose(): void;
}

/** Edits one table visually or as text; both produce a definition for review. */
export function TableEditor({ model, node, initialMode, draft, onDraft, problem, onReview, onClose }: TableEditorProps) {
  const { t, locale } = useI18n();
  const { family, name } = node.table;
  const table = useMemo(() => editableTable(model.text, family, name), [model, family, name]);
  const original = useMemo(() => (table === undefined ? '' : renderTable(table)), [table]);
  const [chains, setChains] = useState<ChainState[]>(() => draft?.chains ?? (table === undefined ? [] : initialChains(table, node, model)));
  const [mode, setMode] = useState<EditorMode>(draft?.mode ?? initialMode);
  const [text, setText] = useState(draft?.text ?? original);
  const changed = table !== undefined && (mode === 'visual' ? definitionOf(table, chains).text : text) !== original;

  useEffect(() => onDraft({ mode, chains, text }), [mode, chains, text]);

  // Closing or reloading the page would lose the edits.
  useEffect(() => {
    if (!changed) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [changed]);

  if (table === undefined) {
    return <Callout tone="danger" icon={<AlertIcon />} title={t('editor.notFound', { table: `${family} ${name}` })} />;
  }

  const visual = definitionOf(table, chains);
  const definition = mode === 'visual' ? visual.text : text;
  // Text edits cannot be turned back into the visual model, which follows the live table.
  const textDiverged = mode === 'text' && text !== visual.text;
  const errorLines = problem === undefined ? [] : definitionErrorLines(problem.message, problem.preamble);
  const errorRows = new Set([...visual.lines].filter(([, line]) => errorLines.includes(line)).map(([key]) => key));
  const counters = node.objects.filter((object) => object.kind === 'counter').map((object) => object.object.name);

  const counterOf = (handle: number) => {
    const rule = node.chains.flatMap((chain) => chain.rules).find((candidate) => candidate.handle === handle);
    const counter = rule && ruleCounter(rule, node);
    return counter && `${new Intl.NumberFormat(locale).format(counter.packets)} / ${formatBytes(counter.bytes, locale)}`;
  };

  return (
    <section className={styles.editor} aria-label={t('editor.title', { table: `${family} ${name}` })}>
      <div className={styles.toolbar}>
        <h2 className={styles.title}>{t('editor.title', { table: `${family} ${name}` })}</h2>
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

      {problem !== undefined && (
        <Callout tone="danger" icon={<AlertIcon />} title={t('editor.rejected')} role="alert">
          {errorLines.length > 0 && <p>{t(mode === 'visual' ? 'editor.rejectedRows' : 'editor.rejectedLines')}</p>}
          <pre className="details">{problem.message}</pre>
        </Callout>
      )}

      {mode === 'visual' ? (
        <VisualEditor family={family} chains={chains} counters={counters} counterOf={counterOf} errorRows={errorRows} onChange={setChains} />
      ) : (
        <>
          <p className={styles.note}>{t('editor.textNote')}</p>
          <CodeEditor value={text} onChange={setText} errorLines={errorLines} label={t('editor.textLabel', { table: `${family} ${name}` })} />
        </>
      )}
    </section>
  );
}
