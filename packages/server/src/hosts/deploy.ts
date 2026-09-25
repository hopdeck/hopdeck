import {
  diffLines,
  isManaged,
  nftName,
  parseListing,
  parseRuleset,
  replaceTableScript,
  tableOwner,
  withManagedComment,
  type DeploymentTable,
  type DeploymentView,
  type Executor,
  type Family,
  type HostKind,
  type Listing,
  type PersistResult,
  type TableChange,
  type TableNode,
  type TableOwner,
} from '@nftm/core';
import { randomUUID } from 'node:crypto';
import { HostError } from './errors.ts';
import { runAsRoot, runNft, type NftAccess } from './privilege.ts';

/** Everything deploying to one host needs; HostManager builds it. */
export interface DeployTarget {
  hostId: string;
  name: string;
  kind: HostKind;
  executor: Executor;
  access: NftAccess;
  systemd: boolean;
  manualOverride: boolean;
  /** A connection that shares nothing with `executor`; undefined without a network hop (localhost, sandbox). */
  freshExecutor: Executor | undefined;
}

export interface DeployLogEntry {
  host: string;
  deployment: string;
  event: 'applied' | 'failed' | 'confirmed' | 'rolled-back';
  tables: string[];
  manualOverride: boolean;
  detail?: string;
}

export interface DeploymentsOptions {
  /** Seconds until the host rolls back an unconfirmed change. */
  seconds?: number;
  /** Records what happened, e.g. into the change log. */
  log?: (entry: DeployLogEntry) => void | Promise<void>;
  /** Saves a kept change for boot. */
  afterConfirm?: (view: DeploymentView, target: DeployTarget) => Promise<PersistResult>;
}

/** A table as it is on the host now. */
export interface CurrentTable {
  node: TableNode;
  listing: Listing;
  /** `nft list table` output: loadable nft input without handles. */
  text: string;
}

interface Deployment {
  view: DeploymentView;
  createdAt: number;
  /** How the watchdog was started, to know what "unavailable" meant. */
  watchdogCommand: readonly string[] | undefined;
}

const PLAN_LIFETIME_MS = 15 * 60_000;
/** A confirmation this close to the deadline may race the watchdog; nftm then waits and reports what happened. */
const RACE_MARGIN_MS = 3000;

// Runs on the host as root, or as the login user with sudo for nft. Unless
// "confirmed" appears in its directory within $1 seconds, it restores the
// tables from rollback.nft with the command in the other arguments and records
// the outcome; confirmed or not, the directory is removed once it is done.
const WATCHDOG = `#!/bin/sh
# nftm rollback watchdog; see packages/server/src/hosts/deploy.ts.
dir=$(dirname "$0")
seconds=$1
shift
echo $$ > "$dir/watchdog.pid"
sleep "$seconds"
if [ -e "$dir/confirmed" ]; then
	rm -rf "$dir"
	exit 0
fi
"$@" -f "$dir/rollback.nft" > "$dir/rollback.log" 2>&1
echo $? > "$dir/rolled-back"
`;

/** Plans, applies and confirms changes on hosts, with a rollback armed on the host before anything changes. */
export class Deployments {
  readonly #deployments = new Map<string, Deployment>();
  readonly #seconds: number;
  readonly #log: DeploymentsOptions['log'];
  readonly #afterConfirm: DeploymentsOptions['afterConfirm'];

  constructor(options: DeploymentsOptions = {}) {
    this.#seconds = options.seconds ?? 60;
    this.#log = options.log;
    this.#afterConfirm = options.afterConfirm;
  }

  hostOf(id: string): string | undefined {
    return this.#deployments.get(id)?.view.hostId;
  }

  get(id: string): DeploymentView | undefined {
    return this.#deployments.get(id)?.view;
  }

  /** Checks the changes against ownership rules and nft -c, and stages files on the host. Nothing changes yet. */
  async prepare(target: DeployTarget, changes: readonly TableChange[]): Promise<DeploymentView> {
    if (changes.length === 0) throw new HostError('invalid-definition', 'no changes');
    const seen = new Set<string>();
    const tables: DeploymentTable[] = [];
    for (const change of changes) {
      const label = `${change.family} ${change.table}`;
      if (seen.has(label)) throw new HostError('invalid-definition', `${label} is changed twice`);
      seen.add(label);
      tables.push(planTable(change, await readTable(target.access, change.family, change.table), target.manualOverride));
    }

    const directory = await makeDirectory(target.executor);
    const change = tables.map((table) => replaceTableScript(table.family, table.name, table.after)).join('');
    const rollback = tables.map((table) => replaceTableScript(table.family, table.name, table.before)).join('');
    await writeRemote(target.executor, `${directory}/change.nft`, change);
    await writeRemote(target.executor, `${directory}/rollback.nft`, rollback);
    await writeRemote(target.executor, `${directory}/watchdog.sh`, WATCHDOG);

    const checkChange = await runNft(target.access, ['-c', '-f', `${directory}/change.nft`]);
    const checkRollback = await runNft(target.access, ['-c', '-f', `${directory}/rollback.nft`]);
    const validation =
      checkChange.exitCode !== 0
        ? { ok: false, message: checkChange.stderr.trim() || `nft exited with code ${checkChange.exitCode}` }
        : checkRollback.exitCode !== 0
          ? { ok: false, message: `nftm could not prepare a way back, so it will not apply this. nft said: ${checkRollback.stderr.trim()}` }
          : { ok: true, message: '' };
    if (!validation.ok) await removeDirectory(target.executor, directory);

    const watchdog = validation.ok ? await watchdogCommand(target, directory, this.#seconds) : undefined;
    const view: DeploymentView = {
      id: randomUUID(),
      hostId: target.hostId,
      state: validation.ok ? 'planned' : 'invalid',
      tables,
      validation,
      safety: {
        watchdog: watchdog === undefined ? 'unavailable' : watchdog.how,
        seconds: this.#seconds,
        freshConnectionCheck: target.freshExecutor !== undefined,
        directory,
      },
      manualOverride: target.manualOverride,
    };
    this.#deployments.set(view.id, { view, createdAt: Date.now(), watchdogCommand: watchdog?.argv });
    return view;
  }

  /**
   * Arms the watchdog, applies the change in one transaction, then tries a new
   * connection. If new connections fail, the change is undone at once through
   * the connection that still works.
   */
  async apply(id: string, target: DeployTarget): Promise<DeploymentView> {
    const deployment = this.#require(id, 'planned');
    const { view } = deployment;
    const dir = view.safety.directory;
    if (Date.now() - deployment.createdAt > PLAN_LIFETIME_MS) {
      throw new HostError('deployment-state', 'this plan is older than 15 minutes; prepare it again');
    }
    for (const table of view.tables) {
      const now = await readTable(target.access, table.family, table.name);
      if (comparable(now?.text) !== comparable(table.before)) {
        throw new HostError('ruleset-changed', `${table.family} ${table.name} changed after this plan was made; prepare it again`);
      }
    }
    if (deployment.watchdogCommand === undefined) {
      throw new HostError('rollback-unavailable', rollbackUnavailableReason(target));
    }

    await startWatchdog(target, deployment.watchdogCommand, dir);
    const armedAt = Date.now();

    const applied = await runNft(target.access, ['-f', `${dir}/change.nft`]);
    if (applied.exitCode !== 0) {
      await disarm(target.executor, dir);
      view.state = 'failed';
      view.outcome = { reason: 'nft-error', detail: applied.stderr.trim() || `nft exited with code ${applied.exitCode}` };
      await this.#record(view, 'failed', view.outcome.detail);
      return view;
    }
    view.state = 'awaiting-confirmation';
    view.deadline = new Date(armedAt + view.safety.seconds * 1000).toISOString();
    await this.#record(view, 'applied');

    if (target.freshExecutor !== undefined) {
      const blocked = await target.freshExecutor.exec(['true']).then(
        () => undefined,
        (error: unknown) => (error instanceof HostError ? error.detail || error.code : String(error)),
      );
      if (blocked !== undefined) {
        view.outcome = { reason: 'fresh-connection-failed', detail: blocked };
        // Undo now through the connection that still works; if that fails too,
        // the watchdog restores the tables at the deadline.
        const undone = await runNft(target.access, ['-f', `${dir}/rollback.nft`]).catch(() => undefined);
        if (undone?.exitCode === 0) {
          await disarm(target.executor, dir).catch(() => undefined);
          view.state = 'rolled-back';
          delete view.deadline;
          await this.#record(view, 'rolled-back', `new connections failed: ${blocked}`);
          return view;
        }
      }
    }
    // The check can outlast a short watchdog: if the watchdog already restored
    // the tables, say so rather than wait for a confirmation of nothing.
    const fired = await readRollback(target.executor, dir).catch(() => undefined);
    if (fired !== undefined) return this.#rolledBack(view, 'timeout', fired, target);
    return view;
  }

  /** Keeps the change: the watchdog stands down. Close to the deadline, nftm waits to report what really happened. */
  async confirm(id: string, target: DeployTarget): Promise<DeploymentView> {
    const { view } = this.#require(id, 'awaiting-confirmation');
    const remaining = Date.parse(view.deadline!) - Date.now();
    await disarm(target.executor, view.safety.directory);
    if (remaining < RACE_MARGIN_MS) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(remaining, 0) + RACE_MARGIN_MS));
      const rolledBack = await readRollback(target.executor, view.safety.directory);
      if (rolledBack !== undefined) return this.#rolledBack(view, 'timeout', rolledBack, target);
    }
    view.state = 'confirmed';
    delete view.deadline;
    await this.#record(view, 'confirmed');
    if (this.#afterConfirm !== undefined) view.persisted = await this.#afterConfirm(view, target);
    return view;
  }

  /** Restores the tables now, before the deadline. */
  async rollback(id: string, target: DeployTarget): Promise<DeploymentView> {
    const { view } = this.#require(id, 'awaiting-confirmation');
    const undone = await runNft(target.access, ['-f', `${view.safety.directory}/rollback.nft`]);
    if (undone.exitCode !== 0) {
      throw new HostError('command-failed', `rolling back failed; the watchdog will try again at the deadline. nft said: ${undone.stderr.trim()}`);
    }
    await disarm(target.executor, view.safety.directory);
    return this.#rolledBack(view, 'user', '', target);
  }

  /** After the deadline, reads what the watchdog did. */
  async refresh(id: string, target: DeployTarget): Promise<DeploymentView> {
    const deployment = this.#deployments.get(id);
    if (deployment === undefined) throw new HostError('deployment-state', 'no such deployment');
    const { view } = deployment;
    if (view.state !== 'awaiting-confirmation' || Date.now() < Date.parse(view.deadline!)) return view;
    const rolledBack = await readRollback(target.executor, view.safety.directory);
    return rolledBack === undefined ? view : this.#rolledBack(view, 'timeout', rolledBack, target);
  }

  /** Drops a plan that was never applied, with its files on the host. */
  async discard(id: string, target: DeployTarget): Promise<void> {
    const { view } = this.#require(id, 'planned', 'invalid');
    this.#deployments.delete(id);
    if (view.state === 'planned') await removeDirectory(target.executor, view.safety.directory);
  }

  #require(id: string, ...states: DeploymentView['state'][]): Deployment {
    const deployment = this.#deployments.get(id);
    if (deployment === undefined) throw new HostError('deployment-state', 'no such deployment');
    if (!states.includes(deployment.view.state)) {
      throw new HostError('deployment-state', `the deployment is ${deployment.view.state}, not ${states.join(' or ')}`);
    }
    return deployment;
  }

  async #rolledBack(view: DeploymentView, reason: 'timeout' | 'user', detail: string, target: DeployTarget): Promise<DeploymentView> {
    view.state = 'rolled-back';
    view.outcome = { reason, detail };
    delete view.deadline;
    await removeDirectory(target.executor, view.safety.directory).catch(() => undefined);
    await this.#record(view, 'rolled-back', reason === 'timeout' ? `not confirmed in time. ${detail}`.trim() : 'by the user');
    return view;
  }

  async #record(view: DeploymentView, event: DeployLogEntry['event'], detail?: string): Promise<void> {
    await this.#log?.({
      host: view.hostId,
      deployment: view.id,
      event,
      tables: view.tables.map((table) => `${table.action} ${table.family} ${table.name}`),
      manualOverride: view.manualOverride,
      ...(detail !== undefined && { detail }),
    });
  }
}

/**
 * What changes in one table, after the ownership rules: nftm changes only
 * tables it manages, unless Manual override is on; tables with xt expressions
 * never, because nft cannot recreate those statements.
 */
export function planTable(change: TableChange, current: CurrentTable | undefined, manualOverride: boolean): DeploymentTable {
  const { family, table: name } = change;
  const label = `${family} ${name}`;
  const owner: TableOwner | undefined = current && tableOwner(current.node, current.listing);
  if (owner?.kind === 'iptables-nft' && owner.evidence === 'xt') {
    throw new HostError('table-not-editable', `${label} contains xt expressions that nft cannot recreate; change it with iptables`);
  }
  const managed = current !== undefined && isManaged(current.node.table);
  const unmanaged = `${label} is not managed by nftm; adopt it first, or switch on Manual override`;

  switch (change.kind) {
    case 'adopt': {
      if (current === undefined) throw new HostError('table-not-editable', `${label} does not exist`);
      if (managed) throw new HostError('table-not-editable', `${label} is already managed by nftm`);
      if (owner !== undefined && owner.kind !== 'unknown') {
        throw new HostError('table-not-editable', `${label} belongs to ${ownerName(owner)}; tables of other tools cannot be adopted`);
      }
      const after = withManagedComment(current.text);
      return { family, name, action: 'adopt', before: current.text, after, diff: diffLines(current.text, after) };
    }
    case 'replace': {
      checkDefinition(change.definition, family, name);
      if (current !== undefined && !managed && !manualOverride) throw new HostError('table-not-editable', unmanaged);
      // Tables nftm creates or manages keep the marker, so it cannot be lost by accident.
      const after = current === undefined || managed ? withManagedComment(change.definition) : change.definition;
      const before = current?.text;
      return { family, name, action: current === undefined ? 'create' : 'replace', before, after, diff: diffLines(before ?? '', after) };
    }
    case 'delete': {
      if (current === undefined) throw new HostError('table-not-editable', `${label} does not exist`);
      if (!managed && !manualOverride) throw new HostError('table-not-editable', unmanaged);
      return { family, name, action: 'delete', before: current.text, after: undefined, diff: diffLines(current.text, '') };
    }
  }
}

/**
 * A replacement must be exactly one block for this table: its contents cannot
 * reach other tables or read files on the host.
 */
export function checkDefinition(definition: string, family: Family, name: string): void {
  const lines = definition.split('\n');
  const opening = `table ${family} ${nftName(name)} {`;
  const code = lines.map((line) => line.trimEnd()).filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
  const invalid = (reason: string) => new HostError('invalid-definition', reason);

  if (code[0] !== opening) throw invalid(`the definition must start with "${opening}"`);
  if (code.at(-1) !== '}') throw invalid('the definition must end with the "}" that closes the table');
  const topLevel = code.slice(1, -1).filter((line) => !/^\s/.test(line));
  if (topLevel.length > 0) throw invalid(`everything inside the table must be indented; found "${topLevel[0]}"`);
  if (code.some((line) => /^\s*include\s/.test(line))) throw invalid('include is not allowed: it would read files on the host as root');
}

/**
 * A listing without what changes on its own: counter values, quota usage and
 * the countdown of expiring elements. What remains differs only if someone
 * changed the table.
 */
export function comparable(text: string | undefined): string | undefined {
  return text
    ?.replace(/packets \d+ bytes \d+/g, 'packets _ bytes _')
    .replace(/ used \d+ \w*bytes/g, ' used _')
    .replace(/ expires [\w.]+/g, '');
}

function ownerName(owner: Exclude<TableOwner, { kind: 'unknown' }>): string {
  return owner.kind === 'tool' ? owner.tool : 'iptables-nft';
}

/** The table as nft lists it now, or undefined when it does not exist. */
export async function readTable(access: NftAccess, family: Family, name: string): Promise<CurrentTable | undefined> {
  const json = await runNft(access, ['-j', 'list', 'table', family, nftName(name)]);
  if (json.exitCode !== 0) {
    if (/No such file or directory/.test(json.stderr)) return undefined;
    throw new HostError('command-failed', json.stderr.trim() || `nft exited with code ${json.exitCode}`);
  }
  const text = await runNft(access, ['list', 'table', family, nftName(name)]);
  if (text.exitCode !== 0) throw new HostError('command-failed', text.stderr.trim());
  const node = parseRuleset(JSON.parse(json.stdout)).tables[0];
  if (node === undefined) throw new HostError('command-failed', `nft listed no table for ${family} ${name}`);
  return { node, listing: parseListing(text.stdout), text: text.stdout };
}

/**
 * How to start the watchdog so it outlives the SSH session: a transient systemd
 * unit when systemd is there and root may start one; otherwise a process
 * detached with setsid. As a last resort it runs as the login user with sudo,
 * which works when sudo allows nft without a password.
 */
async function watchdogCommand(
  target: DeployTarget,
  dir: string,
  seconds: number,
): Promise<{ how: 'systemd' | 'detached'; argv: string[] } | undefined> {
  const { privilege } = target.access;
  const script = [`${dir}/watchdog.sh`, String(seconds)];
  const detached = (nft: string[]) => ['sh', '-c', 'setsid sh "$0" "$@" </dev/null >/dev/null 2>&1 &', ...script, ...nft];
  // The sandbox shares the host's /run/systemd; a unit there would run outside its namespace.
  const systemd = target.systemd && target.kind !== 'sandbox';

  if (privilege.kind === 'root') {
    return systemd
      ? { how: 'systemd', argv: ['systemd-run', '--collect', '--quiet', '/bin/sh', ...script, target.access.nftPath] }
      : { how: 'detached', argv: detached([target.access.nftPath]) };
  }
  if (systemd) {
    const allowed = await runAsRoot(target.access, ['systemd-run', '--version']).then(
      (result) => result.exitCode === 0,
      () => false,
    );
    if (allowed) return { how: 'systemd', argv: ['systemd-run', '--collect', '--quiet', '/bin/sh', ...script, target.access.nftPath] };
  }
  if (privilege.kind === 'sudo') return { how: 'detached', argv: detached(['sudo', '-n', '--', target.access.nftPath]) };
  return undefined;
}

function rollbackUnavailableReason(target: DeployTarget): string {
  return target.access.privilege.kind === 'sudo-password'
    ? 'sudo needs a password here and does not allow systemd-run, so nothing could roll the change back while nftm is away'
    : 'nothing on this host could roll the change back while nftm is away';
}

async function startWatchdog(target: DeployTarget, argv: readonly string[], dir: string): Promise<void> {
  const viaSystemd = argv[0] === 'systemd-run';
  const started = viaSystemd ? await runAsRoot(target.access, argv) : await target.executor.exec(argv);
  if (started.exitCode !== 0) {
    throw new HostError('rollback-unavailable', started.stderr.trim() || `starting the watchdog failed with code ${started.exitCode}`);
  }
  // Nothing is applied until the watchdog provably runs.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const running = await target.executor.exec(['sh', '-c', 'test -s "$1/watchdog.pid" && test -d "/proc/$(cat "$1/watchdog.pid")"', 'sh', dir]);
    if (running.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new HostError('rollback-unavailable', 'the watchdog did not start');
}

/**
 * A private directory for one deployment. Directories of this user older than
 * a day are removed first: they are left when nftm stopped before a rolled
 * back change was reported, and are kept that long for a look at the logs.
 */
async function makeDirectory(executor: Executor): Promise<string> {
  const made = await executor.exec([
    'sh',
    '-c',
    'base="${TMPDIR:-/tmp}"; find "$base" -maxdepth 1 -name "nftm.*" -user "$(id -u)" -mtime +0 -exec rm -rf {} + 2>/dev/null; umask 077; mktemp -d "$base/nftm.XXXXXX"',
  ]);
  if (made.exitCode !== 0) throw new HostError('command-failed', made.stderr.trim());
  return made.stdout.trim();
}

async function writeRemote(executor: Executor, path: string, content: string): Promise<void> {
  const written = await executor.exec(['sh', '-c', 'umask 077; cat > "$1"', 'sh', path], { stdin: content });
  if (written.exitCode !== 0) throw new HostError('command-failed', written.stderr.trim());
}

async function removeDirectory(executor: Executor, dir: string): Promise<void> {
  await executor.exec(['rm', '-rf', '--', dir]);
}

async function disarm(executor: Executor, dir: string): Promise<void> {
  const touched = await executor.exec(['touch', `${dir}/confirmed`]);
  if (touched.exitCode !== 0) throw new HostError('command-failed', touched.stderr.trim());
}

/** The watchdog's record of a rollback: nft's exit code and output; undefined if it did not roll back. */
async function readRollback(executor: Executor, dir: string): Promise<string | undefined> {
  const read = await executor.exec(['sh', '-c', 'test -e "$1/rolled-back" || exit 3; echo "exit code $(cat "$1/rolled-back")"; cat "$1/rollback.log"', 'sh', dir]);
  if (read.exitCode === 3) return undefined;
  return read.stdout.trim();
}
