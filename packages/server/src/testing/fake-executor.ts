// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { ExecOptions, ExecResult, Executor } from '@hopdeck/core';

/** Answers a command with a result, or with an error to throw. */
export type Script = (argv: readonly string[], stdin: string | undefined) => ExecResult | Error;

/** An Executor for tests that records every call and answers from a script. */
export class FakeExecutor implements Executor {
  readonly host = 'fake';
  readonly calls: { argv: readonly string[]; stdin: string | undefined }[] = [];
  readonly #script: Script;

  constructor(script: Script) {
    this.#script = script;
  }

  async exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    this.calls.push({ argv, stdin: options.stdin });
    const result = this.#script(argv, options.stdin);
    if (result instanceof Error) throw result;
    return result;
  }
}

export const ok = (stdout = ''): ExecResult => ({ exitCode: 0, stdout, stderr: '' });
export const failed = (stderr: string, exitCode = 1): ExecResult => ({ exitCode, stdout: '', stderr });

/** What the facts script prints on a typical Debian host with a normal user. */
export const DEBIAN_FACTS = `uid=1000
user=admin
hostname=fw1
kernel=6.1.0-18-amd64
os_id=debian
os_version=12
os_name=Debian GNU/Linux 12 (bookworm)
systemd=yes
nft=/usr/sbin/nft
nft_version=nftables v1.0.6 (Lester Gooch #5)
`;
