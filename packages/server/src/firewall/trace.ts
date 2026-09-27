// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { randomBytes, randomUUID } from 'node:crypto';
import { replaceTableScript, TRACE_TABLE_PREFIX, traceFilterProblem, traceTable, type TraceFilter, type TraceView } from '@hopdeck/core';
import { rollbackUnavailableReason, startWatchdog, watchdogCommand, type DeployTarget } from './deploy.ts';
import { inStaging, makeStaging, removeStaging, stageFile, type Staging } from '../hosts/staging.ts';
import { HostError } from '../hosts/errors.ts';
import { runNft } from '../hosts/privilege.ts';

/** Lines kept per trace; older ones are dropped and counted. */
const MAX_LINES = 20_000;
/** After this many traced packets the trace stops on its own. */
const MAX_PACKETS = 500;

// Runs on the host as root (or as the login user with sudo for nft), started
// the way the deployment watchdog is, before the tracing table exists. It
// records the trace until $1 seconds pass, "stop" appears or the monitor ends,
// then always removes the table with cleanup.nft and says so in "finished".
const TRACE_WATCHDOG = `#!/bin/sh
# hopdeck trace watchdog; see packages/server/src/firewall/trace.ts.
dir=$(dirname "$0")
seconds=$1
shift
echo $$ > "$dir/watchdog.pid"
umask 022
"$@" -a monitor trace > "$dir/trace.log" 2>&1 &
monitor=$!
waited=0
while [ "$waited" -lt "$seconds" ] && [ ! -e "$dir/stop" ] && kill -0 "$monitor" 2>/dev/null; do
	sleep 1
	waited=$((waited + 1))
done
kill "$monitor" 2>/dev/null
"$@" -f "$dir/cleanup.nft" > "$dir/cleanup.log" 2>&1
echo $? > "$dir/finished"
`;

interface Trace {
  view: TraceView;
  staging: Staging;
  /** Bytes of trace.log read so far. */
  offset: number;
  /** An unfinished last line, completed by the next read. */
  partial: string;
  /** Packets seen so far: passes hopdeck's chain reported. */
  packets: number;
}

export interface TraceOptions {
  seconds: number;
  perSecond: number;
}

/** Packet traces on hosts: a temporary marking table, `nft monitor trace`, and a watchdog that removes both. */
export class Traces {
  readonly #traces = new Map<string, Trace>();

  hostOf(id: string): string | undefined {
    return this.#traces.get(id)?.view.hostId;
  }

  async start(target: DeployTarget, filter: TraceFilter, options: TraceOptions): Promise<TraceView> {
    const problem = traceFilterProblem(filter);
    if (problem !== undefined) throw new HostError('invalid-filter', problem);
    const seconds = Math.min(Math.max(Math.round(options.seconds), 5), 600);
    const perSecond = Math.min(Math.max(Math.round(options.perSecond), 1), 100);

    const table = `${TRACE_TABLE_PREFIX}${randomBytes(4).toString('hex')}`;
    const definition = traceTable(table, filter, perSecond);
    const staging = await makeStaging(target);
    const directory = staging.dir;
    const watchdog = await watchdogCommand(target, directory, seconds);
    if (watchdog === undefined) {
      await removeStaging(target, staging);
      throw new HostError('trace-unavailable', rollbackUnavailableReason(target).replace('roll the change back', 'remove the tracing table'));
    }
    await stageFile(target, staging, 'trace.nft', definition);
    await stageFile(target, staging, 'cleanup.nft', replaceTableScript('inet', table, undefined));
    await stageFile(target, staging, 'watchdog.sh', TRACE_WATCHDOG);
    // The watchdog runs before the table exists, so the table cannot outlive it.
    await startWatchdog(target, watchdog.argv, staging);

    const now = Date.now();
    const view: TraceView = {
      id: randomUUID(),
      hostId: target.hostId,
      state: 'running',
      filter,
      perSecond,
      table,
      definition,
      startedAt: new Date(now).toISOString(),
      endsAt: new Date(now + seconds * 1000).toISOString(),
      lines: [],
      dropped: 0,
    };
    const trace: Trace = { view, staging, offset: 0, partial: '', packets: 0 };
    this.#traces.set(view.id, trace);

    const loaded = await runNft(target.access, ['-f', `${directory}/trace.nft`]);
    if (loaded.exitCode !== 0) {
      view.problem = { code: 'invalid-filter', detail: loaded.stderr.trim() || `nft exited with code ${loaded.exitCode}` };
      await this.#finish(trace, target);
      view.state = 'failed';
    }
    return view;
  }

  /** The trace with whatever nft printed since the last look. */
  async get(id: string, target: DeployTarget): Promise<TraceView> {
    const trace = this.#require(id);
    if (trace.view.state === 'running') await this.#read(trace, target);
    return trace.view;
  }

  /** Stops tracing now; the watchdog removes the table within a second. */
  async stop(id: string, target: DeployTarget): Promise<TraceView> {
    const trace = this.#require(id);
    if (trace.view.state === 'running') await this.#finish(trace, target);
    return trace.view;
  }

  /** Forgets finished traces; running ones stay until they end. */
  discard(id: string): void {
    const trace = this.#require(id);
    if (trace.view.state !== 'running') this.#traces.delete(id);
  }

  #require(id: string): Trace {
    const trace = this.#traces.get(id);
    if (trace === undefined) throw new HostError('trace-unavailable', 'no such trace');
    return trace;
  }

  async #read(trace: Trace, target: DeployTarget): Promise<void> {
    const directory = trace.staging.dir;
    const read = await inStaging(target, trace.staging, [
      'sh',
      '-c',
      // New bytes of the log, then whether the watchdog has finished.
      'tail -c +"$2" "$1/trace.log" 2>/dev/null; printf "\\n%s" "$(cat "$1/finished" 2>/dev/null)"',
      'sh',
      directory,
      String(trace.offset + 1),
    ]);
    if (read.exitCode !== 0) throw new HostError('command-failed', read.stderr.trim());
    const cut = read.stdout.lastIndexOf('\n');
    const chunk = read.stdout.slice(0, cut);
    const finished = read.stdout.slice(cut + 1).trim();
    trace.offset += Buffer.byteLength(chunk);
    this.#append(trace, chunk);

    if (finished !== '') {
      this.#append(trace, '\n');
      await this.#collect(trace, target, finished);
    } else if (trace.packets >= MAX_PACKETS) {
      trace.view.problem = { code: 'trace-unavailable', detail: `stopped after ${MAX_PACKETS} packets` };
      await this.#finish(trace, target);
    }
  }

  #append(trace: Trace, chunk: string): void {
    const text = trace.partial + chunk;
    const lines = text.split('\n');
    trace.partial = lines.pop() ?? '';
    const { view } = trace;
    // The kernel reuses trace ids, so packets are counted where hopdeck's chain first reports them.
    const begins = new RegExp(`^trace id \\S+ inet ${view.table} \\S+ packet: `);
    for (const line of lines) {
      if (begins.test(line)) trace.packets += 1;
      view.lines.push(line);
    }
    if (view.lines.length > MAX_LINES) {
      const excess = view.lines.length - MAX_LINES;
      view.lines.splice(0, excess);
      view.dropped += excess;
    }
  }

  /** Asks the watchdog to stop, waits for it to remove the table, and reads the rest. */
  async #finish(trace: Trace, target: DeployTarget): Promise<void> {
    const { staging } = trace;
    await inStaging(target, staging, ['touch', `${staging.dir}/stop`]);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const done = await inStaging(target, staging, ['cat', `${staging.dir}/finished`]);
      if (done.exitCode === 0) {
        const rest = await inStaging(target, staging, ['tail', '-c', `+${trace.offset + 1}`, `${staging.dir}/trace.log`]);
        this.#append(trace, `${rest.stdout}\n`);
        await this.#collect(trace, target, done.stdout.trim());
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    trace.view.state = 'finished';
    trace.view.cleanup = `the watchdog did not report back; it removes ${trace.view.table} at ${trace.view.endsAt} at the latest`;
  }

  async #collect(trace: Trace, target: DeployTarget, exitCode: string): Promise<void> {
    const { view, staging } = trace;
    if (exitCode !== '0') {
      const log = await inStaging(target, staging, ['cat', `${staging.dir}/cleanup.log`]);
      view.cleanup = `exit code ${exitCode}: ${log.stdout.trim()}`;
    }
    // A monitor that could not start leaves its complaint instead of trace lines.
    const complaints = view.lines.filter((line) => line.trim() !== '' && !line.startsWith('trace id '));
    if (complaints.length > 0 && trace.packets === 0 && view.problem === undefined) {
      view.problem = { code: 'command-failed', detail: complaints.join('\n') };
    }
    view.state = view.problem?.code === 'command-failed' || view.problem?.code === 'invalid-filter' ? 'failed' : 'finished';
    await removeStaging(target, staging);
  }
}
