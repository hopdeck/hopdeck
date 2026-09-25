import { randomBytes, randomUUID } from 'node:crypto';
import { replaceTableScript, TRACE_TABLE_PREFIX, traceFilterProblem, traceTable, type TraceFilter, type TraceView } from '@nftm/core';
import { makeDirectory, removeDirectory, rollbackUnavailableReason, startWatchdog, watchdogCommand, writeRemote, type DeployTarget } from './deploy.ts';
import { HostError } from './errors.ts';
import { runNft } from './privilege.ts';

/** Lines kept per trace; older ones are dropped and counted. */
const MAX_LINES = 20_000;
/** After this many traced packets the trace stops on its own. */
const MAX_PACKETS = 500;

// Runs on the host as root (or as the login user with sudo for nft), started
// the way the deployment watchdog is, before the tracing table exists. It
// records the trace until $1 seconds pass, "stop" appears or the monitor ends,
// then always removes the table with cleanup.nft and says so in "finished".
const TRACE_WATCHDOG = `#!/bin/sh
# nftm trace watchdog; see packages/server/src/hosts/trace.ts.
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
  directory: string;
  /** Bytes of trace.log read so far. */
  offset: number;
  /** An unfinished last line, completed by the next read. */
  partial: string;
  packets: Set<string>;
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
    const directory = await makeDirectory(target.executor);
    const watchdog = await watchdogCommand(target, directory, seconds);
    if (watchdog === undefined) {
      await removeDirectory(target.executor, directory);
      throw new HostError('trace-unavailable', rollbackUnavailableReason(target).replace('roll the change back', 'remove the tracing table'));
    }
    await writeRemote(target.executor, `${directory}/trace.nft`, definition);
    await writeRemote(target.executor, `${directory}/cleanup.nft`, replaceTableScript('inet', table, undefined));
    await writeRemote(target.executor, `${directory}/watchdog.sh`, TRACE_WATCHDOG);
    // The watchdog runs before the table exists, so the table cannot outlive it.
    await startWatchdog(target, watchdog.argv, directory);

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
    const trace: Trace = { view, directory, offset: 0, partial: '', packets: new Set() };
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
    const { directory } = trace;
    const read = await target.executor.exec([
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
    } else if (trace.packets.size >= MAX_PACKETS) {
      trace.view.problem = { code: 'trace-unavailable', detail: `stopped after ${MAX_PACKETS} packets` };
      await this.#finish(trace, target);
    }
  }

  #append(trace: Trace, chunk: string): void {
    const text = trace.partial + chunk;
    const lines = text.split('\n');
    trace.partial = lines.pop() ?? '';
    const { view } = trace;
    for (const line of lines) {
      const id = /^trace id (\S+) /.exec(line)?.[1];
      if (id !== undefined) trace.packets.add(id);
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
    await target.executor.exec(['touch', `${trace.directory}/stop`]);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const done = await target.executor.exec(['cat', `${trace.directory}/finished`]);
      if (done.exitCode === 0) {
        const rest = await target.executor.exec(['tail', '-c', `+${trace.offset + 1}`, `${trace.directory}/trace.log`]);
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
    const { view, directory } = trace;
    if (exitCode !== '0') {
      const log = await target.executor.exec(['cat', `${directory}/cleanup.log`]);
      view.cleanup = `exit code ${exitCode}: ${log.stdout.trim()}`;
    }
    // A monitor that could not start leaves its complaint instead of trace lines.
    const complaints = view.lines.filter((line) => line.trim() !== '' && !line.startsWith('trace id '));
    if (complaints.length > 0 && trace.packets.size === 0 && view.problem === undefined) {
      view.problem = { code: 'command-failed', detail: complaints.join('\n') };
    }
    view.state = view.problem?.code === 'command-failed' || view.problem?.code === 'invalid-filter' ? 'failed' : 'finished';
    await removeDirectory(target.executor, directory);
  }
}
