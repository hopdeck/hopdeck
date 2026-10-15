// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

/**
 * Where hopdeck's source code is. A changed hopdeck that others use over a
 * network must offer them its own source (AGPL-3.0, section 13): point this
 * at the changed code.
 */
export const SOURCE_REPOSITORY = 'https://github.com/hopdeck/hopdeck';

/** The source of this very version: its release tag, or the main branch for a development build. */
export function sourceUrl(version: string): string {
  return /^\d+\.\d+\.\d+$/.test(version) ? `${SOURCE_REPOSITORY}/tree/v${version}` : SOURCE_REPOSITORY;
}
