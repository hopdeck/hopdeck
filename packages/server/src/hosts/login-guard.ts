// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { ExecOptions, ExecResult, Executor } from '@hopdeck/core';
import { HostError } from './errors.ts';

/**
 * Stops logging in to a host that refused a login: every further command
 * fails at once with the same error, without starting ssh, until reset(),
 * which a reconnect does. The panel reads some hosts every few seconds; a
 * failed login each time is what sshd (PerSourcePenalties) and fail2ban
 * answer by shutting this machine's address out.
 */
export class LoginGuard implements Executor {
  readonly host: string;
  readonly #inner: Executor;
  #refused: HostError | undefined;

  constructor(inner: Executor) {
    this.#inner = inner;
    this.host = inner.host;
  }

  async exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult> {
    if (this.#refused !== undefined) {
      throw new HostError('ssh-auth', `${this.#refused.detail}\n(hopdeck does not log in again until you reconnect, so that the host does not shut this address out)`);
    }
    try {
      return await this.#inner.exec(argv, options);
    } catch (error) {
      if (error instanceof HostError && error.code === 'ssh-auth') this.#refused = error;
      throw error;
    }
  }

  /** Lets the next command log in again. */
  reset(): void {
    this.#refused = undefined;
  }

  /** Ends what the executor inside keeps open. */
  close(): void {
    (this.#inner as Executor & { close?(): void }).close?.();
  }
}
