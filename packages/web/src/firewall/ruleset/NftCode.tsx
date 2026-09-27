// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { useMemo } from 'react';
import { tokenize } from './highlight.ts';

/**
 * nft text with syntax colours. Tokens become React text nodes, never HTML, so
 * whatever a host prints cannot inject markup into the panel.
 */
export function NftCode({ text, block = false, className }: { text: string; block?: boolean; className?: string }) {
  const content = useMemo(
    () =>
      tokenize(text).map((token, index) =>
        token.kind === 'plain' ? (
          token.text
        ) : (
          <span key={index} className={`syn-${token.kind}`}>
            {token.text}
          </span>
        ),
      ),
    [text],
  );
  const classes = [block ? 'code-block' : 'code-inline', className].filter(Boolean).join(' ');
  return block ? <pre className={classes}>{content}</pre> : <code className={classes}>{content}</code>;
}
