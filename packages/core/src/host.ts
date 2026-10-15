// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { Ruleset } from './firewall/ruleset.ts';

export interface ExecOptions {
  /** Written to the command's standard input, e.g. a ruleset for `nft -f -`. */
  stdin?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs commands on one managed host as the login user. Implementations: local,
 * SSH (system OpenSSH) and sandbox (a private namespace); an agent could be
 * added later. Privilege escalation (sudo) is layered on top, not built in.
 *
 * `argv` is never interpreted by a local shell. The SSH implementation must
 * quote every argument for the remote shell, since ssh joins them into one
 * command line.
 */
export interface Executor {
  /** Display name of the host, e.g. "localhost" or "admin@fw1". */
  readonly host: string;
  exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult>;
}

/**
 * Where the ruleset being edited comes from: a live host (model A) or, later,
 * a project file (model B).
 */
export interface RulesetSource {
  load(): Promise<Ruleset>;
}
