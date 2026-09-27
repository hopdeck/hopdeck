// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { useMemo, type KeyboardEvent } from 'react';
import { tokenize } from '../ruleset/highlight.ts';
import styles from './CodeEditor.module.css';

interface CodeEditorProps {
  value: string;
  onChange(value: string): void;
  /** 1-based lines to mark, e.g. where nft reported an error. */
  errorLines?: readonly number[];
  label: string;
}

/**
 * A textarea over a coloured copy of its text: selection, clipboard and undo
 * stay native, and no editor library is needed. Tab inserts a tab, as nft
 * listings indent with tabs.
 */
export function CodeEditor({ value, onChange, errorLines = [], label }: CodeEditorProps) {
  const lines = value.split('\n');
  const highlighted = useMemo(
    () =>
      value.split('\n').map((line, index) => (
        <span key={index} className={errorLines.includes(index + 1) ? `${styles.line} ${styles.errorLine}` : styles.line}>
          {tokenize(line).map((token, part) =>
            token.kind === 'plain' ? (
              token.text
            ) : (
              <span key={part} className={`syn-${token.kind}`}>
                {token.text}
              </span>
            ),
          )}
          {'\n'}
        </span>
      )),
    [value, errorLines],
  );

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    // insertText keeps the change on the native undo stack; setRangeText is the fallback.
    if (!document.execCommand('insertText', false, '\t')) {
      const target = event.currentTarget;
      target.setRangeText('\t', target.selectionStart, target.selectionEnd, 'end');
      onChange(target.value);
    }
  }

  return (
    <div className={styles.editor}>
      <div className={styles.gutter} aria-hidden="true">
        {lines.map((_, index) => (
          <span key={index} className={errorLines.includes(index + 1) ? styles.errorNumber : undefined}>
            {index + 1}
          </span>
        ))}
      </div>
      <div className={styles.code}>
        <pre className={styles.highlight} aria-hidden="true">
          {highlighted}
        </pre>
        <textarea
          className={styles.input}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          rows={lines.length}
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          aria-label={label}
        />
      </div>
    </div>
  );
}
