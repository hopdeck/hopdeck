// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import {
  blockKey,
  diffLines,
  elementChangeScript,
  elementParts,
  elementProblem,
  isManaged,
  nftName,
  parseListing,
  parseRuleset,
  parseSetBlock,
  refreshUntouched,
  replaceTableScript,
  restoreElementsScript,
  ruleCommands,
  stripHandles,
  tableOwner,
  tableText,
  withManagedComment,
  type DeploymentTable,
  type DeploymentView,
  type Executor,
  type Family,
  type HostKind,
  type Listing,
  type PersistResult,
  type Platform,
  type TableChange,
  type TableNode,
  type TableOwner,
} from '@hopdeck/core';
import { randomUUID } from 'node:crypto';
import { HostError } from '../hosts/errors.ts';
import { runAsRoot, runNft, type NftAccess } from '../hosts/privilege.ts';
import { inStaging, makeStaging, removeStaging, stageFile, type Staging } from '../hosts/staging.ts';

/** Everything deploying to one host needs; HostManager builds it. */
export interface DeployTarget {
  hostId: string;
  name: string;
  kind: HostKind;
  executor: Executor;
  access: NftAccess;
  platform: Platform;
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
  /** Then records it in the host's history. */
  record?: (view: DeploymentView, target: DeployTarget) => Promise<NonNullable<DeploymentView['recorded']>>;
}

/** A table as it is on the host now. */
export interface CurrentTable {
  node: TableNode;
  listing: Listing;
  /** `nft list table` output: loadable nft input without handles. */
  text: string;
  /** The same with handles, as `nft -a list table` prints it. */
  annotated: string;
}

interface Deployment {
  view: DeploymentView;
  /** Tables changed rule by rule, as they were with handles: those handles must still be there at apply. */
  annotated: Map<string, string>;
  staging: Staging;
  createdAt: number;
  /** How the watchdog was started, to know what "unavailable" meant. */
  watchdogCommand: readonly string[] | undefined;
}

const PLAN_LIFETIME_MS = 15 * 60_000;
/** A confirmation this close to the deadline may race the watchdog; hopdeck then waits and reports what happened. */
const RACE_MARGIN_MS = 3000;

// Runs on the host as root, or as the login user with sudo for nft. Unless
// "confirmed" appears in its directory within $1 seconds, it restores the
// tables from rollback.nft with the command in the other arguments and records
// the outcome; confirmed or not, the directory is removed once it is done.
const WATCHDOG = `#!/bin/sh
# hopdeck rollback watchdog; see packages/server/src/firewall/deploy.ts.
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

/**
 * Why the firewall module must not change this host's firewall, if it must
 * not; in English, for error details. Only OpenWrt is read-only so far.
 */
export function firewallReadOnly(host: Platform): string | undefined {
  if (host.firewall !== 'read-only') return undefined;
  return 'OpenWrt keeps its firewall in UCI (/etc/config/firewall), which LuCI shows and fw4 turns into nftables. hopdeck will make changes there in a later version; until then it changes nothing on this host';
}

/** Plans, applies and confirms changes on hosts, with a rollback armed on the host before anything changes. */
export class Deployments {
  readonly #deployments = new Map<string, Deployment>();
  readonly #seconds: number;
  readonly #log: DeploymentsOptions['log'];
  readonly #afterConfirm: DeploymentsOptions['afterConfirm'];
  readonly #recordKept: DeploymentsOptions['record'];
  /** Hosts with an apply, confirmation or rollback under way, and how many. */
  readonly #working = new Map<string, number>();

  constructor(options: DeploymentsOptions = {}) {
    this.#seconds = options.seconds ?? 60;
    this.#log = options.log;
    this.#afterConfirm = options.afterConfirm;
    this.#recordKept = options.record;
  }

  hostOf(id: string): string | undefined {
    return this.#deployments.get(id)?.view.hostId;
  }

  /** Whether hopdeck is changing the host just now, or waits for a change there to be kept or undone. */
  busy(hostId: string): boolean {
    if ((this.#working.get(hostId) ?? 0) > 0) return true;
    return [...this.#deployments.values()].some(({ view }) => view.hostId === hostId && view.state === 'awaiting-confirmation');
  }

  get(id: string): DeploymentView | undefined {
    return this.#deployments.get(id)?.view;
  }

  /** Checks the changes against ownership rules and nft -c, and stages files on the host. Nothing changes yet. */
  async prepare(target: DeployTarget, changes: readonly TableChange[], options: { restoredFrom?: number } = {}): Promise<DeploymentView> {
    const readOnly = firewallReadOnly(target.platform);
    if (readOnly !== undefined) throw new HostError('platform-read-only', readOnly);
    if (changes.length === 0) throw new HostError('invalid-definition', 'no changes');
    const seen = new Set<string>();
    const tables: DeploymentTable[] = [];
    const annotated = new Map<string, string>();
    for (const change of changes) {
      const label = `${change.family} ${change.table}`;
      if (seen.has(label)) throw new HostError('invalid-definition', `${label} is changed twice`);
      seen.add(label);
      const current = await readTable(target.access, change.family, change.table);
      const table = planTable(change, current, target.manualOverride);
      if (table.inPlace !== undefined) annotated.set(label, current!.annotated);
      tables.push(table);
    }

    const staging = await makeStaging(target);
    const directory = staging.dir;
    const rollback = tables.map((table) => table.rollback).join('');
    await stageFile(target, staging, 'rollback.nft', rollback);
    await stageFile(target, staging, 'watchdog.sh', WATCHDOG);

    // nft checks every definition whole first, so its messages name lines of
    // the definitions, which is what the editor shows.
    const whole = (table: DeploymentTable) => (table.inPlace === undefined ? table.script : replaceTableScript(table.family, table.name, table.after));
    let checkChange = await this.#check(target, staging, 'change.nft', tables.map(whole).join(''));
    if (checkChange.exitCode === 0 && annotated.size > 0) {
      const byRule = await this.#check(target, staging, 'change.nft', tables.map((table) => table.script).join(''));
      if (byRule.exitCode !== 0) {
        // Valid whole but not rule by rule, e.g. the table changed a moment ago: replace it whole after all.
        for (const table of tables) {
          if (table.inPlace === undefined) continue;
          table.script = whole(table);
          delete table.inPlace;
        }
        annotated.clear();
        checkChange = await this.#check(target, staging, 'change.nft', tables.map(whole).join(''));
      }
    }
    const checkRollback = await runNft(target.access, ['-c', '-f', `${directory}/rollback.nft`]);
    const validation =
      checkChange.exitCode !== 0
        ? { ok: false, message: checkChange.stderr.trim() || `nft exited with code ${checkChange.exitCode}` }
        : checkRollback.exitCode !== 0
          ? { ok: false, message: `hopdeck could not prepare a way back, so it will not apply this. nft said: ${checkRollback.stderr.trim()}` }
          : { ok: true, message: '' };
    if (!validation.ok) await removeStaging(target, staging);

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
      ...(options.restoredFrom !== undefined && { restoredFrom: options.restoredFrom }),
    };
    this.#deployments.set(view.id, { view, annotated, staging, createdAt: Date.now(), watchdogCommand: watchdog?.argv });
    return view;
  }

  /** Stages nft input under `name` and checks it with `nft -c`. */
  async #check(target: DeployTarget, staging: Staging, name: string, script: string) {
    await stageFile(target, staging, name, script);
    return runNft(target.access, ['-c', '-f', `${staging.dir}/${name}`]);
  }

  /**
   * Arms the watchdog, applies the change in one transaction, then tries a new
   * connection. If new connections fail, the change is undone at once through
   * the connection that still works.
   */
  apply(id: string, target: DeployTarget): Promise<DeploymentView> {
    return this.#during(target.hostId, () => this.#apply(id, target));
  }

  async #apply(id: string, target: DeployTarget): Promise<DeploymentView> {
    const deployment = this.#require(id, 'planned');
    const { view } = deployment;
    const dir = view.safety.directory;
    if (Date.now() - deployment.createdAt > PLAN_LIFETIME_MS) {
      throw new HostError('deployment-state', 'this plan is older than 15 minutes; prepare it again');
    }
    for (const table of view.tables) {
      const now = await readTable(target.access, table.family, table.name);
      // Elements change in place and may come and go on their own (timeouts,
      // rules that add them); only the set's declaration has to stay the same.
      // Rule by rule, the handles the commands name must be the same too.
      const annotated = deployment.annotated.get(`${table.family} ${table.name}`);
      const unchanged =
        table.set !== undefined
          ? declaration(now?.text, table) === declaration(table.before, table) && declaration(table.before, table) !== undefined
          : annotated !== undefined
            ? comparable(now?.annotated) === comparable(annotated)
            : comparable(now?.text) === comparable(table.before);
      if (!unchanged) {
        throw new HostError('ruleset-changed', `${table.family} ${table.name} changed after this plan was made; prepare it again`);
      }
    }
    if (deployment.watchdogCommand === undefined) {
      throw new HostError('rollback-unavailable', rollbackUnavailableReason(target));
    }

    await startWatchdog(target, deployment.watchdogCommand, deployment.staging);
    const armedAt = Date.now();

    const applied = await runNft(target.access, ['-f', `${dir}/change.nft`]);
    if (applied.exitCode !== 0) {
      await disarm(target, deployment.staging);
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
          await disarm(target, deployment.staging).catch(() => undefined);
          view.state = 'rolled-back';
          delete view.deadline;
          await this.#record(view, 'rolled-back', `new connections failed: ${blocked}`);
          return view;
        }
      }
    }
    // The check can outlast a short watchdog: if the watchdog already restored
    // the tables, say so rather than wait for a confirmation of nothing.
    const fired = await readRollback(target, deployment.staging).catch(() => undefined);
    if (fired !== undefined) return this.#rolledBack(view, 'timeout', fired, target);
    return view;
  }

  /** Keeps the change: the watchdog stands down. Close to the deadline, hopdeck waits to report what really happened. */
  confirm(id: string, target: DeployTarget): Promise<DeploymentView> {
    return this.#during(target.hostId, () => this.#confirm(id, target));
  }

  async #confirm(id: string, target: DeployTarget): Promise<DeploymentView> {
    const { view, staging } = this.#require(id, 'awaiting-confirmation');
    const remaining = Date.parse(view.deadline!) - Date.now();
    await disarm(target, staging);
    if (remaining < RACE_MARGIN_MS) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(remaining, 0) + RACE_MARGIN_MS));
      const rolledBack = await readRollback(target, staging);
      if (rolledBack !== undefined) return this.#rolledBack(view, 'timeout', rolledBack, target);
    }
    view.state = 'confirmed';
    delete view.deadline;
    await this.#record(view, 'confirmed');
    if (this.#afterConfirm !== undefined) view.persisted = await this.#afterConfirm(view, target);
    if (this.#recordKept !== undefined) view.recorded = await this.#recordKept(view, target);
    return view;
  }

  /** Restores the tables now, before the deadline. */
  rollback(id: string, target: DeployTarget): Promise<DeploymentView> {
    return this.#during(target.hostId, () => this.#rollback(id, target));
  }

  async #rollback(id: string, target: DeployTarget): Promise<DeploymentView> {
    const { view, staging } = this.#require(id, 'awaiting-confirmation');
    const undone = await runNft(target.access, ['-f', `${staging.dir}/rollback.nft`]);
    if (undone.exitCode !== 0) {
      throw new HostError('command-failed', `rolling back failed; the watchdog will try again at the deadline. nft said: ${undone.stderr.trim()}`);
    }
    await disarm(target, staging);
    return this.#rolledBack(view, 'user', '', target);
  }

  /** After the deadline, reads what the watchdog did. */
  async refresh(id: string, target: DeployTarget): Promise<DeploymentView> {
    const deployment = this.#deployments.get(id);
    if (deployment === undefined) throw new HostError('deployment-state', 'no such deployment');
    const { view } = deployment;
    if (view.state !== 'awaiting-confirmation' || Date.now() < Date.parse(view.deadline!)) return view;
    const rolledBack = await readRollback(target, deployment.staging);
    return rolledBack === undefined ? view : this.#rolledBack(view, 'timeout', rolledBack, target);
  }

  /** Drops a plan that was never applied, with its files on the host. */
  async discard(id: string, target: DeployTarget): Promise<void> {
    const { view, staging } = this.#require(id, 'planned', 'invalid');
    this.#deployments.delete(id);
    if (view.state === 'planned') await removeStaging(target, staging);
  }

  async #during<T>(hostId: string, task: () => Promise<T>): Promise<T> {
    this.#working.set(hostId, (this.#working.get(hostId) ?? 0) + 1);
    try {
      return await task();
    } finally {
      const left = (this.#working.get(hostId) ?? 1) - 1;
      if (left === 0) this.#working.delete(hostId);
      else this.#working.set(hostId, left);
    }
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
    const staging = this.#deployments.get(view.id)?.staging;
    if (staging !== undefined) await removeStaging(target, staging).catch(() => undefined);
    await this.#record(view, 'rolled-back', reason === 'timeout' ? `not confirmed in time. ${detail}`.trim() : 'by the user');
    return view;
  }

  async #record(view: DeploymentView, event: DeployLogEntry['event'], detail?: string): Promise<void> {
    await this.#log?.({
      host: view.hostId,
      deployment: view.id,
      event,
      tables: view.tables.map((table) => `${table.action} ${table.family} ${table.name}${table.set ? ` ${table.set.kind} ${table.set.name}` : ''}`),
      manualOverride: view.manualOverride,
      ...(detail !== undefined && { detail }),
    });
  }
}

/**
 * What changes in one table, after the ownership rules: hopdeck changes only
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
  const unmanaged = `${label} is not managed by hopdeck; adopt it first, or switch on Manual override`;

  switch (change.kind) {
    case 'adopt': {
      if (current === undefined) throw new HostError('table-not-editable', `${label} does not exist`);
      if (managed) throw new HostError('table-not-editable', `${label} is already managed by hopdeck`);
      if (owner !== undefined && owner.kind !== 'unknown') {
        throw new HostError('table-not-editable', `${label} belongs to ${ownerName(owner)}; tables of other tools cannot be adopted`);
      }
      const after = withManagedComment(current.text);
      return { family, name, action: 'adopt', before: current.text, after, diff: diffLines(current.text, after), ...scripts(family, name, current.text, after) };
    }
    case 'replace': {
      checkDefinition(change.definition, family, name);
      if (current !== undefined && !managed && !manualOverride) throw new HostError('table-not-editable', unmanaged);
      // Objects left as the editor showed them follow the host's current state.
      const definition =
        current !== undefined && change.base !== undefined
          ? refreshUntouched(change.definition, change.base, current.text, family, name)
          : change.definition;
      // Tables hopdeck creates or manages keep the marker, so it cannot be lost by accident.
      const after = current === undefined || managed ? withManagedComment(definition) : definition;
      const before = current?.text;
      const byRule = current === undefined ? undefined : ruleCommands(family, name, current.annotated, after);
      const { script, rollback } = scripts(family, name, before, after);
      return {
        family,
        name,
        action: current === undefined ? 'create' : 'replace',
        before,
        after,
        diff: diffLines(before ?? '', after),
        script: byRule?.script ?? script,
        rollback,
        ...(byRule !== undefined && { inPlace: { added: byRule.added, removed: byRule.removed, replaced: byRule.replaced } }),
      };
    }
    case 'delete': {
      if (current === undefined) throw new HostError('table-not-editable', `${label} does not exist`);
      if (!managed && !manualOverride) throw new HostError('table-not-editable', unmanaged);
      return { family, name, action: 'delete', before: current.text, after: undefined, diff: diffLines(current.text, ''), ...scripts(family, name, current.text, undefined) };
    }
    case 'elements':
      return planElements(change, current, managed || manualOverride, unmanaged);
  }
}

/** Replacing the whole table, and putting it back as it was. */
function scripts(family: Family, name: string, before: string | undefined, after: string | undefined): { script: string; rollback: string } {
  return { script: replaceTableScript(family, name, after), rollback: replaceTableScript(family, name, before) };
}

/**
 * Elements removed and added in place. The rollback flushes the set and puts
 * back the elements as they were, with their timeouts, counters and comments.
 */
function planElements(
  change: Extract<TableChange, { kind: 'elements' }>,
  current: CurrentTable | undefined,
  editable: boolean,
  unmanaged: string,
): DeploymentTable {
  const { family, table: name, set, setKind } = change;
  const label = `${family} ${name}`;
  if (current === undefined) throw new HostError('table-not-editable', `${label} does not exist`);
  if (!editable) throw new HostError('table-not-editable', unmanaged);
  const block = current.listing.blocks.get(blockKey(family, name, setKind, set));
  const parsed = block === undefined ? undefined : parseSetBlock(block);
  if (parsed === undefined) throw new HostError('invalid-definition', `${label} has no ${setKind} ${set}`);
  if (change.add.length === 0 && change.remove.length === 0) throw new HostError('invalid-definition', 'no elements to add or remove');
  for (const element of [...change.add, ...change.remove]) {
    const problem = elementProblem(element);
    if (problem !== undefined) throw new HostError('invalid-definition', problem);
  }

  const map = setKind === 'map';
  const removed = new Set(change.remove);
  const kept = parsed.elements.filter((element) => !removed.has(elementParts(element, map).key));
  return {
    family,
    name,
    action: 'elements',
    set: { kind: setKind, name: set },
    before: current.text,
    after: undefined,
    diff: diffLines(parsed.elements.join('\n'), [...kept, ...change.add].join('\n')),
    script: elementChangeScript(family, name, set, change.add, change.remove),
    rollback: restoreElementsScript(family, name, setKind, set, parsed.elements),
  };
}

/** A set's declaration in a table listing, without its elements; undefined if the set is gone. */
function declaration(text: string | undefined, table: DeploymentTable): string | undefined {
  if (text === undefined || table.set === undefined) return undefined;
  const block = parseListing(text).blocks.get(blockKey(table.family, table.name, table.set.kind, table.set.name));
  const parsed = block === undefined ? undefined : parseSetBlock(block);
  return parsed?.declaration.join('\n');
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

  // Lines are read as nft reads them: strings hold anything, # starts a comment,
  // and ";" or a brace may end a statement or block in the middle of a line.
  let depth = 0;
  for (const [index, line] of code.entries()) {
    if ((line.match(/"/g)?.length ?? 0) % 2 !== 0) throw invalid(`a string is not closed: "${line.trim()}"`);
    const bare = line.replace(/"[^"]*"/g, '""').replace(/#.*$/, '');
    if (/(^|[\s;{}])include\s*""/.test(bare)) throw invalid('include is not allowed: it would read files on the host as root');
    for (const char of bare) {
      if (char === '{') depth += 1;
      if (char !== '}') continue;
      depth -= 1;
      // Anything after the table's closing brace would act outside it, on other tables.
      if (depth <= 0 && index !== code.length - 1) throw invalid(`"${line.trim()}" closes the table before its end`);
    }
  }
  if (depth !== 0) throw invalid('the braces of the definition do not match');
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

/**
 * The table as nft lists it now, or undefined when it does not exist. It is cut
 * out of the whole ruleset: `nft list table` fails for tables named like one of
 * its list keywords, e.g. "sets".
 */
export async function readTable(access: NftAccess, family: Family, name: string): Promise<CurrentTable | undefined> {
  const json = await runNft(access, ['-j', 'list', 'ruleset']);
  if (json.exitCode !== 0) throw new HostError('command-failed', json.stderr.trim() || `nft exited with code ${json.exitCode}`);
  const node = parseRuleset(JSON.parse(json.stdout)).tables.find((table) => table.table.family === family && table.table.name === name);
  if (node === undefined) return undefined;
  const listing = await runNft(access, ['-a', 'list', 'ruleset']);
  if (listing.exitCode !== 0) throw new HostError('command-failed', listing.stderr.trim() || `nft exited with code ${listing.exitCode}`);
  // The same lines with and without handles: find the table in one, cut it out of both.
  const plain = stripHandles(listing.stdout);
  const text = tableText(plain, family, name);
  if (text === undefined) throw new HostError('command-failed', `nft printed no table ${family} ${name}, though its JSON has one`);
  const start = plain.split('\n').indexOf(text.split('\n')[0]!);
  const annotated = `${listing.stdout.split('\n').slice(start, start + text.split('\n').length - 1).join('\n')}\n`;
  return { node, listing: parseListing(annotated), text, annotated };
}

/**
 * How to start the watchdog so it outlives the SSH session: a transient systemd
 * unit when systemd is there and root may start one; otherwise a process
 * detached with setsid. As a last resort it runs as the login user with sudo,
 * which works when sudo allows nft without a password.
 */
export async function watchdogCommand(
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

export function rollbackUnavailableReason(target: DeployTarget): string {
  return target.access.privilege.kind === 'sudo-password'
    ? 'sudo needs a password here and does not allow systemd-run, so nothing could roll the change back while hopdeck is away'
    : 'nothing on this host could roll the change back while hopdeck is away';
}

export async function startWatchdog(target: DeployTarget, argv: readonly string[], staging: Staging): Promise<void> {
  const viaSystemd = argv[0] === 'systemd-run';
  const started = viaSystemd ? await runAsRoot(target.access, argv) : await target.executor.exec(argv);
  if (started.exitCode !== 0) {
    throw new HostError('rollback-unavailable', started.stderr.trim() || `starting the watchdog failed with code ${started.exitCode}`);
  }
  // Nothing is applied until the watchdog provably runs.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const running = await inStaging(target, staging, ['sh', '-c', 'test -s "$1/watchdog.pid" && test -d "/proc/$(cat "$1/watchdog.pid")"', 'sh', staging.dir]);
    if (running.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new HostError('rollback-unavailable', 'the watchdog did not start');
}

async function disarm(target: DeployTarget, staging: Staging): Promise<void> {
  const touched = await inStaging(target, staging, ['touch', `${staging.dir}/confirmed`]);
  if (touched.exitCode !== 0) throw new HostError('command-failed', touched.stderr.trim());
}

/** The watchdog's record of a rollback: nft's exit code and output; undefined if it did not roll back. */
async function readRollback(target: DeployTarget, staging: Staging): Promise<string | undefined> {
  const read = await inStaging(target, staging, [
    'sh',
    '-c',
    'test -e "$1/rolled-back" || exit 3; echo "exit code $(cat "$1/rolled-back")"; cat "$1/rollback.log"',
    'sh',
    staging.dir,
  ]);
  if (read.exitCode === 3) return undefined;
  return read.stdout.trim();
}
