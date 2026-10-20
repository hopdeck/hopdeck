// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import {
  includeVersion,
  INCLUDE_DIRECTORY,
  mergeHosts,
  parseLeaseFile,
  parseLuciLeases,
  staticHosts,
  type DhcpHost,
  openwrtFirewall,
  parseUciChanges,
  parseUciGet,
  sectionLabel,
  uciCall,
  type UciChange,
  type UciConfig,
  type UciPlanView,
} from '@hopdeck/core';
import { randomUUID } from 'node:crypto';
import type { DeployLogEntry, DeployTarget } from '../firewall/deploy.ts';
import { HostError } from '../hosts/errors.ts';
import { runAsRoot } from '../hosts/privilege.ts';

/** How long a plan may wait before it is applied, and so how long its rpcd session lives without use. */
const PLAN_LIFETIME_S = 15 * 60;
const FW4 = '/sbin/fw4';
/** A confirmation this close to the deadline may race rpcd's rollback; hopdeck then checks what happened. */
const RACE_MARGIN_MS = 3000;

export interface UciPlansOptions {
  /** Seconds until rpcd rolls back an unconfirmed change. */
  seconds?: number;
  /** Before a plan is made: the history notes the configuration as it is, if it has to. */
  beforeChange?: (target: DeployTarget) => Promise<void>;
  /** After a change is kept: the history records it. */
  record?: (view: UciPlanView, target: DeployTarget) => Promise<NonNullable<UciPlanView['recorded']>>;
  /** Records what happened, as deployments do. */
  log?: (entry: DeployLogEntry) => void | Promise<void>;
}

interface Plan {
  view: UciPlanView;
  /** hopdeck's rpcd session: the changes are staged in it, and only it may confirm them. */
  session: string;
  /** /etc/config/<config> when the plan was made, and when it was applied: a change elsewhere in between stops it, and the first tells a rollback. */
  hashBefore: string;
  createdAt: number;
  /** Include files this plan wrote, which no kept configuration points to unless it is kept. */
  written: string[];
}

/** An nftables file for fw4 that a plan writes, at a path of includePath()'s. */
export interface IncludeFile {
  path: string;
  content: string;
}

/** The most an include file may hold. */
export const MAX_INCLUDE_BYTES = 1024 * 1024;

/**
 * Changes of OpenWrt's UCI configuration, as LuCI makes them: staged in a
 * session of rpcd's of their own, applied with `uci apply` and its rollback,
 * so that rpcd restores the configuration unless hopdeck confirms in time,
 * whatever becomes of hopdeck or its connection meanwhile.
 */
export class UciPlans {
  readonly #plans = new Map<string, Plan>();
  readonly #seconds: number;
  readonly #log: UciPlansOptions['log'];
  readonly #beforeChange: UciPlansOptions['beforeChange'];
  readonly #recordKept: UciPlansOptions['record'];
  readonly #working = new Map<string, number>();

  constructor(options: UciPlansOptions = {}) {
    this.#seconds = options.seconds ?? 60;
    this.#log = options.log;
    this.#beforeChange = options.beforeChange;
    this.#recordKept = options.record;
  }

  hostOf(id: string): string | undefined {
    return this.#plans.get(id)?.view.hostId;
  }

  get(id: string): UciPlanView | undefined {
    return this.#plans.get(id)?.view;
  }

  /** Whether hopdeck is changing the host just now, or waits for a change there to be kept or undone. */
  busy(hostId: string): boolean {
    if ((this.#working.get(hostId) ?? 0) > 0) return true;
    return [...this.#plans.values()].some(({ view }) => view.hostId === hostId && view.state === 'awaiting-confirmation');
  }

  /**
   * Stages the changes in a new rpcd session and lists them as rpcd will write
   * them. Nothing changes on the router yet. `base` is the hash of the
   * configuration the changes were made on: UCI names anonymous sections by
   * their place in the file, so after a change elsewhere the same name may
   * mean another section, and the plan is refused.
   */
  async prepare(
    target: DeployTarget,
    config: string,
    changes: readonly UciChange[],
    options: { base?: string; files?: readonly IncludeFile[]; restoredFrom?: number } = {},
  ): Promise<UciPlanView> {
    if (target.platform.id !== 'openwrt') throw new HostError('platform-read-only', 'UCI is OpenWrt’s configuration; this host is not OpenWrt');
    if (!/^[a-z0-9_-]+$/.test(config)) throw new HostError('invalid-definition', `not a UCI configuration: ${config}`);
    if (changes.length === 0) throw new HostError('invalid-definition', 'no changes');

    const hashBefore = await configHash(target, config);
    if (options.base !== undefined && options.base !== hashBefore) {
      throw new HostError('ruleset-changed', `/etc/config/${config} changed since the panel read it, in LuCI or elsewhere; read it again and make the changes on what is there now`);
    }
    // The history notes what the change is made on, a change of LuCI's say, before it is staged.
    if (config === 'firewall') await this.#beforeChange?.(target);
    const files = options.files ?? [];
    if (files.length > 0 && config !== 'firewall') throw new HostError('invalid-definition', 'only the firewall has include files');
    for (const file of files) {
      if (includeVersion(file.path) === undefined) throw new HostError('invalid-definition', `not a path of hopdeck's for an include: ${file.path}`);
      if (Buffer.byteLength(file.content) > MAX_INCLUDE_BYTES || file.content.includes('\0')) throw new HostError('invalid-definition', `${file.path} is too large, or not text`);
    }
    // The files go first: the changes point to them, and fw4 reads them when the changes are applied.
    let written: string[];
    try {
      written = await writeIncludes(target, files);
    } catch (error) {
      if (error instanceof HostError && error.code === 'invalid-definition') {
        return this.#keep(
          {
            id: randomUUID(),
            hostId: target.hostId,
            config,
            state: 'invalid',
            staged: [],
            validation: { ok: false, message: error.detail },
            pendingElsewhere: { cli: false, sessions: 0 },
            safety: { seconds: this.#seconds, freshConnectionCheck: target.freshExecutor !== undefined },
          },
          '',
          hashBefore,
          [],
        );
      }
      throw error;
    }
    const session = await openSession(target, config).catch(async (error: unknown) => {
      await removeFiles(target, written).catch(() => undefined);
      throw error;
    });
    const view: UciPlanView = {
      id: randomUUID(),
      hostId: target.hostId,
      config,
      state: 'planned',
      staged: [],
      validation: { ok: true, message: '' },
      pendingElsewhere: { cli: false, sessions: 0 },
      safety: { seconds: this.#seconds, freshConnectionCheck: target.freshExecutor !== undefined },
      ...(options.restoredFrom !== undefined && { restoredFrom: options.restoredFrom }),
    };
    try {
      // Sections the panel added go by their ref until rpcd names them.
      const refs = new Map<string, string>();
      const named = (section: string) => refs.get(section) ?? section;
      for (const change of changes) {
        const resolved: UciChange =
          change.kind === 'order' ? { ...change, sections: change.sections.map(named) } : change.kind === 'add' ? change : { ...change, section: named(change.section) };
        const { method, message } = uciCall(config, resolved);
        const refused = await ubus(target, 'uci', method, { ...message, ubus_rpc_session: session }).then(
          (answer) => {
            const section = (answer as { section?: unknown } | undefined)?.section;
            if (change.kind === 'add' && change.ref !== undefined && typeof section === 'string') refs.set(change.ref, section);
            return undefined;
          },
          (error: unknown) => {
            // rpcd's refusal is the plan's validation, as nft -c is a deployment's.
            if (error instanceof HostError && error.code === 'uci-failed') return error.detail;
            throw error;
          },
        );
        if (refused !== undefined) {
          await closeSession(target, session, config).catch(() => undefined);
          await removeFiles(target, written).catch(() => undefined);
          view.state = 'invalid';
          view.validation = { ok: false, message: refused };
          return this.#keep(view, session, hashBefore, []);
        }
      }
      const staged = parseUciChanges(JSON.stringify((await ubus(target, 'uci', 'changes', { config, ubus_rpc_session: session })) ?? {}));
      // Sections are named from the configuration with the changes, so that new ones have their names too.
      const after = await readConfig(target, config, session);
      const before = await readConfig(target, config, undefined);
      view.staged = staged.map((change) => ({ ...change, label: labelOf(change.section, after, before) }));
      view.pendingElsewhere = await pendingElsewhere(target, config, session);
    } catch (error) {
      await closeSession(target, session, config).catch(() => undefined);
      await removeFiles(target, written).catch(() => undefined);
      throw error;
    }
    return this.#keep(view, session, hashBefore, written);
  }

  /**
   * Applies the plan with rpcd's rollback armed, reloads the firewall at once
   * to see it take, then tries a new connection. If the reload fails, or new
   * connections do, the change is rolled back at once.
   */
  apply(id: string, target: DeployTarget): Promise<UciPlanView> {
    return this.#during(target.hostId, () => this.#apply(id, target));
  }

  async #apply(id: string, target: DeployTarget): Promise<UciPlanView> {
    const plan = this.#require(id, 'planned');
    const { view, session } = plan;
    if (Date.now() - plan.createdAt > PLAN_LIFETIME_S * 1000) throw new HostError('deployment-state', 'this plan is older than 15 minutes; prepare it again');
    if ((await configHash(target, view.config)) !== plan.hashBefore) {
      throw new HostError('ruleset-changed', `/etc/config/${view.config} changed after this plan was made, in LuCI or elsewhere; prepare it again`);
    }
    const before = await fw4Table(target);
    await ubus(target, 'uci', 'apply', { rollback: true, timeout: view.safety.seconds, ubus_rpc_session: session }).catch((error: unknown) => {
      if (error instanceof HostError && /Permission denied/i.test(error.detail)) {
        throw new HostError('uci-apply-pending', error.detail);
      }
      throw error;
    });
    const armedAt = Date.now();
    view.state = 'awaiting-confirmation';
    view.deadline = new Date(armedAt + view.safety.seconds * 1000).toISOString();
    await this.#record(view, 'applied');

    // rpcd has procd reload the firewall a second later; reloading now gives the change a moment it takes effect.
    const reload = await runAsRoot(target.access, [FW4, 'reload']);
    const said = `${reload.stdout}${reload.stderr}`.trim();
    if (said !== '') view.warnings = said;
    // fw4 reload exits with 0 even when nft refused the ruleset (and kept the one before); fw4 check says so.
    const check = await runAsRoot(target.access, [FW4, 'check']);
    if (reload.exitCode !== 0 || check.exitCode !== 0) {
      const detail = `${check.stdout}${check.stderr}`.trim() || said || `fw4 exited with code ${reload.exitCode || check.exitCode}`;
      return this.#undo(view, target, session, { reason: 'reload-failed', detail });
    }
    view.ruleset = { before, after: await fw4Table(target) };

    if (target.freshExecutor !== undefined) {
      const blocked = await target.freshExecutor.exec(['true']).then(
        () => undefined,
        (error: unknown) => (error instanceof HostError ? error.detail || error.code : String(error)),
      );
      if (blocked !== undefined) return this.#undo(view, target, session, { reason: 'fresh-connection-failed', detail: blocked });
    }
    return view;
  }

  /** Keeps the change: rpcd drops its snapshot. Close to the deadline, hopdeck checks whether rpcd rolled back first. */
  confirm(id: string, target: DeployTarget): Promise<UciPlanView> {
    return this.#during(target.hostId, () => this.#confirm(id, target));
  }

  async #confirm(id: string, target: DeployTarget): Promise<UciPlanView> {
    const plan = this.#require(id, 'awaiting-confirmation');
    const { view, session } = plan;
    const confirmed = await ubus(target, 'uci', 'confirm', { ubus_rpc_session: session }).then(
      () => undefined,
      (error: unknown) => (error instanceof HostError ? error.detail : String(error)),
    );
    if (confirmed !== undefined) {
      // rpcd no longer holds the rollback: it ran out, so the configuration is back as it was.
      if ((await configHash(target, view.config)) === plan.hashBefore) return this.#rolledBack(plan, target, 'timeout', confirmed);
      throw new HostError('uci-failed', `rpcd did not take the confirmation: ${confirmed}`);
    }
    view.state = 'confirmed';
    delete view.deadline;
    await closeSession(target, session, view.config).catch(() => undefined);
    await this.#record(view, 'confirmed');
    // Versions of includes that nothing points to any more go, now that the change is kept.
    if (view.config === 'firewall') await removeUnusedIncludes(target).catch(() => undefined);
    if (view.config === 'firewall' && this.#recordKept !== undefined) view.recorded = await this.#recordKept(view, target);
    return view;
  }

  /** Restores the configuration now, before the deadline. */
  rollback(id: string, target: DeployTarget): Promise<UciPlanView> {
    return this.#during(target.hostId, async () => {
      const plan = this.#require(id, 'awaiting-confirmation');
      await ubus(target, 'uci', 'rollback', { ubus_rpc_session: plan.session });
      await runAsRoot(target.access, [FW4, 'reload']).catch(() => undefined);
      return this.#rolledBack(plan, target, 'user', '');
    });
  }

  /** After the deadline, reads whether rpcd rolled back. */
  async refresh(id: string, target: DeployTarget): Promise<UciPlanView> {
    const plan = this.#plans.get(id);
    if (plan === undefined) throw new HostError('deployment-state', 'no such plan');
    const { view } = plan;
    if (view.state !== 'awaiting-confirmation' || Date.now() < Date.parse(view.deadline!) + RACE_MARGIN_MS) return view;
    if ((await configHash(target, view.config)) === plan.hashBefore) return this.#rolledBack(plan, target, 'timeout', 'not confirmed in time');
    return view;
  }

  /** Drops a plan that was never applied, with its session and the changes staged there. */
  async discard(id: string, target: DeployTarget): Promise<void> {
    const { view, session, written } = this.#require(id, 'planned', 'invalid');
    this.#plans.delete(id);
    // An invalid plan's session went when rpcd refused.
    if (view.state === 'planned') await closeSession(target, session, view.config);
    await removeFiles(target, written);
  }

  #keep(view: UciPlanView, session: string, hashBefore: string, written: string[]): UciPlanView {
    this.#plans.set(view.id, { view, session, hashBefore, createdAt: Date.now(), written });
    return view;
  }

  async #undo(view: UciPlanView, target: DeployTarget, session: string, outcome: NonNullable<UciPlanView['outcome']>): Promise<UciPlanView> {
    view.outcome = outcome;
    const undone = await ubus(target, 'uci', 'rollback', { ubus_rpc_session: session }).then(
      () => true,
      () => false,
    );
    if (!undone) return view; // rpcd rolls back at the deadline all the same.
    await runAsRoot(target.access, [FW4, 'reload']).catch(() => undefined);
    view.state = 'rolled-back';
    delete view.deadline;
    await closeSession(target, session, view.config).catch(() => undefined);
    await removeFiles(target, this.#plans.get(view.id)?.written ?? []).catch(() => undefined);
    await this.#record(view, 'rolled-back', `${outcome.reason}: ${outcome.detail}`);
    return view;
  }

  async #rolledBack(plan: Plan, target: DeployTarget, reason: 'timeout' | 'user', detail: string): Promise<UciPlanView> {
    const { view, session } = plan;
    view.state = 'rolled-back';
    view.outcome = { reason, detail };
    delete view.deadline;
    await closeSession(target, session, view.config).catch(() => undefined);
    // The configuration back as it was points to none of the files this plan wrote.
    await removeFiles(target, plan.written).catch(() => undefined);
    await this.#record(view, 'rolled-back', reason === 'timeout' ? `not confirmed in time. ${detail}`.trim() : 'by the user');
    return view;
  }

  #require(id: string, ...states: UciPlanView['state'][]): Plan {
    const plan = this.#plans.get(id);
    if (plan === undefined) throw new HostError('deployment-state', 'no such plan');
    if (!states.includes(plan.view.state)) throw new HostError('deployment-state', `the plan is ${plan.view.state}, not ${states.join(' or ')}`);
    return plan;
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

  async #record(view: UciPlanView, event: DeployLogEntry['event'], detail?: string): Promise<void> {
    await this.#log?.({
      host: view.hostId,
      deployment: view.id,
      event,
      tables: [`uci ${view.config}: ${view.staged.length} change${view.staged.length === 1 ? '' : 's'}`],
      manualOverride: false,
      ...(detail !== undefined && { detail }),
    });
  }
}

/** Calls a ubus method as root and reads its answer; a failure is a HostError carrying ubus's message. */
export async function ubus(target: Pick<DeployTarget, 'access'>, object: string, method: string, message: Record<string, unknown>): Promise<unknown> {
  const result = await runAsRoot(target.access, ['ubus', 'call', object, method, JSON.stringify(message)]);
  if (result.exitCode !== 0) {
    const said = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new HostError('uci-failed', `ubus call ${object} ${method}: ${said}`);
  }
  const out = result.stdout.trim();
  if (out === '') return undefined;
  try {
    return JSON.parse(out);
  } catch {
    throw new HostError('uci-failed', `ubus call ${object} ${method} printed no JSON: ${out.slice(0, 200)}`);
  }
}

/** A session of hopdeck's own, allowed to read and write one configuration, alive as long as a plan may wait. */
async function openSession(target: DeployTarget, config: string): Promise<string> {
  const created = (await ubus(target, 'session', 'create', { timeout: PLAN_LIFETIME_S + 300 })) as { ubus_rpc_session?: unknown } | undefined;
  const session = created?.ubus_rpc_session;
  if (typeof session !== 'string' || !/^[0-9a-f]{32}$/.test(session)) throw new HostError('uci-failed', `rpcd made no session: ${JSON.stringify(created)}`);
  await ubus(target, 'session', 'grant', { ubus_rpc_session: session, scope: 'uci', objects: [[config, 'read'], [config, 'write']] });
  return session;
}

/** Drops what is still staged in the session, and the session. */
async function closeSession(target: DeployTarget, session: string, config: string): Promise<void> {
  await ubus(target, 'uci', 'revert', { config, ubus_rpc_session: session }).catch(() => undefined);
  await ubus(target, 'session', 'destroy', { ubus_rpc_session: session });
}

/**
 * A configuration as UCI has it: committed, with the changes staged in the
 * session when one is given. Without a session, ubus would mix in the
 * uncommitted changes of the uci command, so the committed file is read
 * through a session of its own.
 */
export async function readConfig(target: DeployTarget, config: string, session: string | undefined): Promise<UciConfig> {
  if (session !== undefined) return parseUciGet(config, JSON.stringify(await ubus(target, 'uci', 'get', { config, ubus_rpc_session: session })));
  const own = await openSession(target, config);
  try {
    return parseUciGet(config, JSON.stringify(await ubus(target, 'uci', 'get', { config, ubus_rpc_session: own })));
  } finally {
    await ubus(target, 'session', 'destroy', { ubus_rpc_session: own }).catch(() => undefined);
  }
}

/** The SHA-256 of /etc/config/<config>, which tells whether it changed. */
export async function configHash(target: Pick<DeployTarget, 'access'>, config: string): Promise<string> {
  const result = await runAsRoot(target.access, ['sha256sum', `/etc/config/${config}`]);
  if (result.exitCode !== 0) throw new HostError('uci-failed', `reading /etc/config/${config}: ${result.stderr.trim()}`);
  return result.stdout.split(/\s/)[0]!;
}

/** Uncommitted changes to the configuration besides the session's: the uci command's, and other rpcd sessions' (LuCI's). */
async function pendingElsewhere(target: DeployTarget, config: string, session: string): Promise<UciPlanView['pendingElsewhere']> {
  const script = 'uci -q changes "$1" | grep -c . ; for f in /var/run/rpcd/uci-*/"$1"; do [ -s "$f" ] && [ "$f" != "/var/run/rpcd/uci-$2/$1" ] && echo "$f"; done | grep -c .';
  const result = await runAsRoot(target.access, ['sh', '-c', script, 'sh', config, session]);
  const [cli, sessions] = result.stdout.trim().split(/\s+/).map(Number);
  return { cli: (cli ?? 0) > 0, sessions: sessions ?? 0 };
}

/**
 * Writes the include files, each through a temporary file renamed into place.
 * A file that is there already with the same content stays as it is; with
 * other content, it is written over only when no include of the kept
 * configuration points to it (one a rolled-back plan left). Returns the
 * files written, for them to go again if the plan does not get kept.
 */
async function writeIncludes(target: DeployTarget, files: readonly IncludeFile[]): Promise<string[]> {
  if (files.length === 0) return [];
  const used = new Set(openwrtFirewall(await readConfig(target, 'firewall', undefined)).includes.map((include) => include.path));
  const written: string[] = [];
  for (const file of files) {
    const there = await runAsRoot(target.access, ['cat', file.path]);
    if (there.exitCode === 0 && there.stdout === file.content) continue;
    if (there.exitCode === 0 && used.has(file.path)) {
      throw new HostError('invalid-definition', `${file.path} is in use with other content; read the configuration again`);
    }
    const write = await runAsRoot(target.access, ['sh', '-c', 'umask 077 && mkdir -p "$(dirname "$1")" && cat > "$1.hopdeck-new" && mv -f "$1.hopdeck-new" "$1"', 'sh', file.path], {
      stdin: file.content,
    });
    if (write.exitCode !== 0) throw new HostError('command-failed', `writing ${file.path}: ${write.stderr.trim()}`);
    written.push(file.path);
  }
  return written;
}

async function removeFiles(target: DeployTarget, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  await runAsRoot(target.access, ['rm', '-f', '--', ...paths]);
}

/** Removes the files in hopdeck's include directory that no include of the kept configuration points to. */
async function removeUnusedIncludes(target: DeployTarget): Promise<void> {
  const used = openwrtFirewall(await readConfig(target, 'firewall', undefined)).includes.flatMap((include) => (include.path === undefined ? [] : [include.path]));
  const script = `for f in ${INCLUDE_DIRECTORY}/*.nft; do [ -f "$f" ] || continue; keep=0; for k in "$@"; do [ "$f" = "$k" ] && keep=1; done; [ "$keep" = 1 ] || rm -f -- "$f"; done`;
  await runAsRoot(target.access, ['sh', '-c', script, 'sh', ...used]);
}

/**
 * The content of a file fw4 includes, for the panel to show: one an include
 * of the kept configuration points to, or one fw4 includes by itself
 * (/etc/nftables.d, /usr/share/nftables.d); no other file.
 */
export async function readInclude(target: DeployTarget, path: string): Promise<string> {
  const used = openwrtFirewall(await readConfig(target, 'firewall', undefined)).includes.some((include) => include.path === path);
  const automatic = (await automaticIncludes(target)).includes(path);
  if (!used && !automatic) throw new HostError('invalid-definition', `fw4 includes no file ${path}`);
  const read = await runAsRoot(target.access, ['head', '-c', String(MAX_INCLUDE_BYTES), path]);
  if (read.exitCode !== 0) throw new HostError('command-failed', `reading ${path}: ${read.stderr.trim()}`);
  return read.stdout;
}

/** The files fw4 includes without a UCI section: *.nft in /etc/nftables.d, and by position in /usr/share/nftables.d. */
export async function automaticIncludes(target: Pick<DeployTarget, 'access'>): Promise<string[]> {
  const script = 'for f in /etc/nftables.d/*.nft /usr/share/nftables.d/*/*.nft /usr/share/nftables.d/*/*/*.nft; do [ -f "$f" ] && echo "$f"; done; true';
  const result = await runAsRoot(target.access, ['sh', '-c', script]);
  return result.stdout.split('\n').filter((line) => line !== '');
}

/**
 * The hosts the router knows on its networks: its DHCP leases, through
 * luci-rpc where LuCI's rpcd plugin is there, else from dnsmasq's lease file,
 * and the host sections of /etc/config/dhcp.
 */
export async function dhcpHosts(target: DeployTarget): Promise<DhcpHost[]> {
  const luci = await runAsRoot(target.access, ['ubus', 'call', 'luci-rpc', 'getDHCPLeases', '{}']);
  const leases =
    luci.exitCode === 0 ? parseLuciLeases(luci.stdout) : parseLeaseFile((await runAsRoot(target.access, ['sh', '-c', 'cat /tmp/dhcp.leases 2>/dev/null; true'])).stdout);
  const hosts = await readConfig(target, 'dhcp', undefined).then(staticHosts, () => []);
  return mergeHosts(leases, hosts);
}

/** The table fw4 made, as nft lists it without counter values, which a reload sets to zero; empty when there is none. */
async function fw4Table(target: DeployTarget): Promise<string> {
  const result = await runAsRoot(target.access, [target.access.nftPath, '-s', 'list', 'table', 'inet', 'fw4']);
  return result.exitCode === 0 ? result.stdout : '';
}

function labelOf(section: string, after: UciConfig, before: UciConfig): string {
  const found = after.sections.find((candidate) => candidate.name === section) ?? before.sections.find((candidate) => candidate.name === section);
  if (found === undefined) return section;
  return sectionLabel(after.sections.includes(found) ? after : before, found);
}
