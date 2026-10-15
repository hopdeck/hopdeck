// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { HostErrorCode } from '@hopdeck/core';

export type { HostErrorCode };

/** A failure on a host; `detail` is the raw message, shown next to the translated code. */
export class HostError extends Error {
  override name = 'HostError';
  readonly code: HostErrorCode;
  readonly detail: string;

  constructor(code: HostErrorCode, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}
