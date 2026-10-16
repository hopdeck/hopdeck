// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import type {
  AvailableKey,
  DeploymentView,
  HistoryState,
  HistoryVersionDetail,
  HostSettings,
  Platform,
  Executor,
  HostErrorCode,
  HostKeyCheck,
  HostKind,
  HostStatus,
  GeneratedKey,
  HostSummary,
  KeySetupResult,
  KeyUse,
  PacketLogView,
  PersistenceStatus,
  PersistResult,
  RulesetSnapshot,
  SshKeysView,
  TableChange,
  LiveState,
  TraceFilter,
  TraceView,
  UsedKey,
} from '@hopdeck/core';
import { cpuPercent, liveState, parseUsage, platform, USAGE_COMMAND, type CpuSample, type HostUsage } from '@hopdeck/core';
import { HostError } from './errors.ts';
import { Deployments, type DeployLogEntry, type DeployTarget } from '../firewall/deploy.ts';
import { History, type HistoryTarget } from '../firewall/history.ts';
import { journal } from './journal.ts';
import { Traces, type TraceOptions } from '../firewall/trace.ts';
import { readPacketLog } from '../firewall/packet-log.ts';
import { collectFacts } from './facts.ts';
import { HostKeys } from './host-keys.ts';
import { addInclude, enableService, persistenceStatus, persistTables, saveAll, type PersistTarget } from '../firewall/persist.ts';
import { LocalExecutor } from './local.ts';
import { detectPrivilege, runNft, type NftAccess } from './privilege.ts';
import { isValidDestination, SshExecutor } from './ssh.ts';
import { KeyLogin } from './key-login.ts';
import { LoginGuard } from './login-guard.ts';
import { SessionExecutor, sshSessionsWanted } from './ssh-session.ts';
import { addIdentityToConfig } from './ssh-config.ts';
import { SshKeys, type KeySpec, type SshTarget } from './ssh-keys.ts';

interface Entry {
  id: string;
  kind: HostKind;
  name: string;
  destination?: string;
  executor: Executor;
  status: HostStatus;
  password?: string;
  /** Lifts the ownership rule; kept in memory only, so it ends with the session. */
  manualOverride: boolean;
  /** The last CPU reading, so the next one measures the time in between. */
  cpu?: CpuSample & { at: number };
  /** SSH only: a key hopdeck adds for this host (ssh -i), as hosts.json keeps it. */
  identityFile?: string | undefined;
}

/** What hosts.json stores: SSH hosts only; localhost and the sandbox are built in. */
interface StoredHost {
  id: string;
  destination: string;
  name?: string;
  /** A key hopdeck adds for this host, apart from ~/.ssh/config. */
  identityFile?: string;
}

export interface HostManagerOptions {
  /** Where hosts.json lives, e.g. ~/.config/hopdeck. */
  configDir: string;
  /** Directory for SSH ControlMaster sockets. */
  controlDir: string;
  /** An ssh config file used instead of ~/.ssh/config. */
  sshConfigFile?: string | undefined;
  /** Where keys generated in the panel go, instead of ~/.ssh (HOPDECK_SSH_DIR). */
  sshDir?: string | undefined;
  /** The sandbox host, when one runs: its executor, and where it keeps hopdeck's files (Sandbox.directory). */
  sandbox?: { executor: Executor; directory: string };
  /** Who runs hopdeck, and on which computer; recorded as the author of changes. Defaults to this process's user and machine. */
  operator?: { user: string; computer: string };
  /** Replaces the SSH executor, for tests; `shared: false` asks for a connection that shares nothing. */
  createSshExecutor?: (destination: string, options?: { shared: boolean; identityFile?: string | undefined }) => Executor;
  /** Seconds until a host rolls back an unconfirmed change. */
  rollbackSeconds?: number;
  /** Replaces host key handling, for tests. */
  hostKeys?: HostKeys;
  /** Replaces the keys and agent ssh uses, for tests; started by open(). */
  sshKeys?: SshKeys;
}

/** Bad input for a new host: an invalid or duplicate destination, a name too long. */
export class InvalidHostError extends Error {
  override name = 'InvalidHostError';
}

/** The request does not fit the host's current state, e.g. a password it does not need. */
export class HostStateError extends Error {
  override name = 'HostStateError';
}

export class HostManager {
  readonly #options: HostManagerOptions;
  readonly #entries = new Map<string, Entry>();
  readonly #hostKeys: HostKeys;
  readonly #deployments: Deployments;
  readonly #traces = new Traces();
  readonly #history: History;
  readonly #sshKeys: SshKeys;
  readonly #keyLogin: KeyLogin;

  private constructor(options: HostManagerOptions) {
    this.#options = options;
    this.#sshKeys = options.sshKeys ?? new SshKeys({ configFile: options.sshConfigFile, runtimeDir: options.controlDir, sshDir: options.sshDir });
    this.#keyLogin = new KeyLogin({ keys: this.#sshKeys, configFile: options.sshConfigFile });
    this.#hostKeys = options.hostKeys ?? new HostKeys({ configFile: options.sshConfigFile });
    const entryOf = (hostId: string) => {
      const entry = this.#entries.get(hostId);
      if (entry === undefined) throw new Error(`host ${hostId} is gone`);
      return entry;
    };
    this.#deployments = new Deployments({
      ...(options.rollbackSeconds !== undefined && { seconds: options.rollbackSeconds }),
      log: (entry) => this.#logChange(entry),
      afterConfirm: (view) => persistTables(this.#persistTarget(entryOf(view.hostId)), view.tables),
      record: (view) => this.#history.record(this.#historyTarget(entryOf(view.hostId)), view),
    });
    this.#history = new History({
      operator: options.operator ?? { user: userInfo().username, computer: hostname() },
      busy: (hostId) => this.#deployments.busy(hostId),
    });
  }

  static async open(options: HostManagerOptions): Promise<HostManager> {
    const manager = new HostManager(options);
    // Before any ssh runs: it has to know which agent to ask for keys.
    await manager.#sshKeys.start();
    // nftables is Linux's: on Windows, the machine hopdeck runs on is no host for it.
    if (process.platform !== 'win32') {
      manager.#put({ id: 'local', kind: 'local', name: 'localhost', executor: new LocalExecutor(), status: { state: 'new' }, manualOverride: false });
    }
    if (options.sandbox !== undefined) {
      manager.#put({ id: 'sandbox', kind: 'sandbox', name: 'sandbox', executor: options.sandbox.executor, status: { state: 'new' }, manualOverride: false });
    }
    for (const host of await readInventory(options.configDir)) {
      manager.#put(manager.#sshEntry(host));
    }
    return manager;
  }

  list(): HostSummary[] {
    return [...this.#entries.values()].map(summary);
  }

  get(id: string): HostSummary | undefined {
    const entry = this.#entries.get(id);
    return entry && summary(entry);
  }

  async add(input: { destination: string; name?: string | undefined }): Promise<HostSummary> {
    const destination = input.destination.trim();
    if (!isValidDestination(destination)) throw new InvalidHostError(`invalid SSH destination: ${destination}`);
    const name = input.name?.trim() || destination;
    if (name.length > 100) throw new InvalidHostError('name is too long');
    const exists = [...this.#entries.values()].some((entry) => entry.destination === destination);
    if (exists) throw new InvalidHostError(`host already added: ${destination}`);

    const entry = this.#sshEntry({ id: randomUUID(), destination, name });
    this.#put(entry);
    await this.#save();
    return summary(entry);
  }

  /** Returns false for unknown ids; built-in hosts cannot be removed. */
  async remove(id: string): Promise<boolean> {
    const entry = this.#entries.get(id);
    if (entry?.kind !== 'ssh') return false;
    this.#entries.delete(id);
    closeExecutor(entry.executor);
    await this.#save();
    return true;
  }

  /** Collects facts and detects privileges; failures become an error status. */
  async connect(id: string): Promise<HostSummary | undefined> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    this.#history.reset(id);
    // Connecting is the user asking to log in again.
    if (entry.executor instanceof LoginGuard) entry.executor.reset();
    try {
      const facts = await collectFacts(entry.executor);
      const privilege = await detectPrivilege(entry.executor, facts);
      if (privilege.kind !== 'sudo-password') delete entry.password;
      entry.status = { state: 'connected', facts, privilege, passwordStored: entry.password !== undefined };
    } catch (error) {
      entry.status = { state: 'error', error: toStatusError(error) };
    }
    return summary(entry);
  }

  /** Checks the password by running `nft --version` through sudo, then keeps it in memory. */
  async setSudoPassword(id: string, password: string): Promise<HostSummary | undefined> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    const { status } = entry;
    if (status.state !== 'connected' || status.privilege.kind !== 'sudo-password' || status.facts.nft === undefined) {
      throw new HostStateError(`${entry.name} does not need a sudo password in its current state; reconnect to refresh it`);
    }
    const access = { executor: entry.executor, nftPath: status.facts.nft.path, privilege: status.privilege, password };
    let result;
    try {
      result = await runNft(access, ['--version']);
    } catch (error) {
      // The password was right, but sudo will not run nft for this user: that is
      // the host's real state, so the status says so instead of an error popup.
      if (error instanceof HostError && error.code === 'sudo-not-allowed') {
        entry.status = { ...status, privilege: { kind: 'none', reason: 'sudo-not-allowed', detail: error.detail } };
        return summary(entry);
      }
      throw error;
    }
    if (result.exitCode !== 0) {
      throw new HostError('command-failed', result.stderr.trim() || `nft exited with code ${result.exitCode}`);
    }
    entry.password = password;
    entry.status = { ...status, passwordStored: true };
    return summary(entry);
  }

  /** Switches Manual override for this session: tables may then be changed without adopting them. */
  setManualOverride(id: string, enabled: boolean): HostSummary | undefined {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    entry.manualOverride = enabled;
    return summary(entry);
  }

  /**
   * Checks changes and stages them on the host; nothing changes until apply.
   * Whatever changed the managed tables since the last version goes into the
   * history first, so the change is recorded against what it really changed.
   */
  async prepareDeployment(id: string, changes: readonly TableChange[], options: { restoredFrom?: number } = {}): Promise<DeploymentView | undefined> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    const target = this.#target(entry);
    if (target.platform.firewall !== 'read-only') await this.#observe(entry, await this.#readJson(entry));
    return this.#deployments.prepare(target, changes, options);
  }

  async deployment(id: string, action: 'get' | 'apply' | 'confirm' | 'rollback' | 'discard'): Promise<DeploymentView | undefined> {
    const hostId = this.#deployments.hostOf(id);
    const entry = hostId === undefined ? undefined : this.#entries.get(hostId);
    if (entry === undefined) return undefined;
    const target = this.#target(entry);
    switch (action) {
      case 'get':
        return this.#deployments.refresh(id, target);
      case 'apply':
        return this.#deployments.apply(id, target);
      case 'confirm':
        return this.#deployments.confirm(id, target);
      case 'rollback':
        return this.#deployments.rollback(id, target);
      case 'discard': {
        const view = this.#deployments.get(id);
        await this.#deployments.discard(id, target);
        return view;
      }
    }
  }

  /** Starts tracing packets that match the filter; the host removes the tracing table on its own at the end. */
  async startTrace(id: string, filter: TraceFilter, options: TraceOptions): Promise<TraceView | undefined> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    return this.#traces.start(this.#target(entry), filter, options);
  }

  async trace(id: string, action: 'get' | 'stop' | 'discard'): Promise<TraceView | undefined> {
    const hostId = this.#traces.hostOf(id);
    const entry = hostId === undefined ? undefined : this.#entries.get(hostId);
    if (entry === undefined) return undefined;
    const target = this.#target(entry);
    if (action === 'stop') return this.#traces.stop(id, target);
    const view = await this.#traces.get(id, target);
    if (action === 'discard') this.#traces.discard(id);
    return view;
  }

  /** Sends a ping, and with a port a TCP connection attempt, over loopback in the sandbox: traffic to trace. */
  async testTraffic(id: string, port: number | undefined): Promise<string | undefined> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    if (entry.kind !== 'sandbox') throw new HostStateError('test traffic is only sent inside the sandbox');
    const commands = ['ping -c 1 -W 1 127.0.0.1', ...(port === undefined ? [] : [`nc -z -w 1 127.0.0.1 ${port}`])];
    const script = commands.map((command) => `echo "$ ${command}"; ${command} 2>&1; echo "exit code $?"`).join('; ');
    const result = await entry.executor.exec(['sh', '-c', `PATH="$PATH:/usr/sbin:/sbin"; ${script}`]);
    return result.stdout.trim();
  }

  async persistence(id: string): Promise<PersistenceStatus | undefined> {
    const entry = this.#entries.get(id);
    return entry === undefined ? undefined : persistenceStatus(this.#persistTarget(entry));
  }

  /** save: write every managed table; include: add the include line (the user agreed); service: enable nftables.service. */
  async persist(id: string, action: 'save' | 'include' | 'service'): Promise<{ status: PersistenceStatus; result?: PersistResult } | undefined> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    const target = this.#persistTarget(entry);
    let result: PersistResult | undefined;
    if (action === 'save') result = await saveAll(target);
    else if (action === 'include') await addInclude(target);
    else await enableService(target);
    return { status: await persistenceStatus(target), ...(result && { result }) };
  }

  /** The history of the managed tables on a host, newest first. */
  async history(id: string): Promise<HistoryState | undefined> {
    const entry = this.#entries.get(id);
    return entry === undefined ? undefined : this.#history.state(this.#historyTarget(entry));
  }

  /** One version with its tables; undefined for an unknown host or version. */
  async historyVersion(id: string, version: number): Promise<HistoryVersionDetail | undefined> {
    const entry = this.#entries.get(id);
    return entry === undefined ? undefined : this.#history.version(this.#historyTarget(entry), version);
  }

  /** Saves settings on the host itself, where every admin shares them. */
  async saveSettings(id: string, settings: HostSettings): Promise<HistoryState | undefined> {
    const entry = this.#entries.get(id);
    return entry === undefined ? undefined : this.#history.saveSettings(this.#historyTarget(entry), settings);
  }

  /** Where hopdeck keeps its files on the host, and what it may change there. */
  #platform(entry: Entry): Platform {
    const status = entry.status as Extract<HostStatus, { state: 'connected' }>;
    if (entry.kind !== 'sandbox' || this.#options.sandbox === undefined) return platform(status.facts.platform);
    const { directory } = this.#options.sandbox;
    return { ...platform('linux'), configDir: `${directory}/etc/hopdeck`, stateDir: `${directory}/var/lib/hopdeck` };
  }

  #historyTarget(entry: Entry): HistoryTarget {
    const access = this.#access(entry);
    const status = entry.status as Extract<HostStatus, { state: 'connected' }>;
    return { hostId: entry.id, kind: entry.kind, executor: entry.executor, access, platform: this.#platform(entry), login: status.facts.user };
  }

  #persistTarget(entry: Entry): PersistTarget {
    const access = this.#access(entry);
    const status = entry.status as Extract<HostStatus, { state: 'connected' }>;
    return { kind: entry.kind, executor: entry.executor, access, facts: status.facts };
  }

  #target(entry: Entry): DeployTarget {
    const access = this.#access(entry);
    const status = entry.status as Extract<HostStatus, { state: 'connected' }>;
    return {
      hostId: entry.id,
      name: entry.name,
      kind: entry.kind,
      executor: entry.executor,
      access,
      platform: this.#platform(entry),
      systemd: status.facts.systemd,
      manualOverride: entry.manualOverride,
      freshExecutor: entry.kind === 'ssh' ? this.#freshExecutor(entry) : undefined,
    };
  }

  #freshExecutor(entry: Entry): Executor {
    const { destination, identityFile } = this.#sshTarget(entry);
    return (
      this.#options.createSshExecutor?.(destination, { shared: false, identityFile }) ??
      new SshExecutor({
        destination,
        identityFile,
        controlDir: this.#options.controlDir,
        configFile: this.#options.sshConfigFile,
        env: this.#sshKeys.env,
        shareConnection: false,
      })
    );
  }

  /** One JSON line per event in changes.log next to hosts.json, and a line in the host's system log. */
  async #logChange(entry: DeployLogEntry): Promise<void> {
    const host = this.#entries.get(entry.host);
    const line = { time: new Date().toISOString(), ...entry, destination: host?.destination ?? host?.name };
    await mkdir(this.#options.configDir, { recursive: true, mode: 0o700 });
    await appendFile(join(this.#options.configDir, 'changes.log'), `${JSON.stringify(line)}\n`, { mode: 0o600 });
    // The sandbox shares this machine's system log, which is not its own.
    if (host === undefined || host.kind === 'sandbox') return;
    const override = entry.manualOverride ? ' with Manual override' : '';
    const detail = entry.detail === undefined ? '' : `: ${entry.detail}`;
    await journal(host.executor, `deployment ${entry.deployment} ${entry.event}${override}: ${entry.tables.join(', ')}${detail}`);
  }

  /** The private keys ssh would offer an SSH host, and which of them need a passphrase. */
  async sshKeys(id: string): Promise<SshKeysView | undefined> {
    const entry = this.#entries.get(id);
    return entry === undefined ? undefined : this.#sshKeys.list(this.#sshTarget(entry));
  }

  /** Puts a key into the agent with its passphrase, for `seconds` or as long as the agent runs; the passphrase is kept nowhere. */
  async unlockSshKey(id: string, file: string, passphrase: string, seconds: number | undefined): Promise<SshKeysView | undefined> {
    const entry = this.#entries.get(id);
    return entry === undefined ? undefined : this.#sshKeys.unlock(this.#sshTarget(entry), file, passphrase, seconds);
  }

  /**
   * Puts a key into the account's authorized_keys with one password login and
   * checks that it gets in alone; with `allow`, first adds to sshd's
   * configuration what lets keys in. The password is kept nowhere.
   */
  async setUpKeyLogin(id: string, file: string, password: string, allow: boolean): Promise<KeySetupResult | undefined> {
    const entry = this.#entries.get(id);
    return entry === undefined ? undefined : this.#keyLogin.setUp(this.#sshTarget(entry), file, password, { allow });
  }

  /**
   * Generates a key for an SSH host and makes ssh offer it there: hopdeck adds
   * it itself (hosts.json, ssh -i), or a Host block in ~/.ssh/config names it.
   * With a passphrase, the key goes to the agent at once, for `seconds`.
   */
  async generateKey(id: string, spec: KeySpec, use: KeyUse, seconds: number | undefined): Promise<{ key: GeneratedKey; keys: SshKeysView } | undefined> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    const destination = this.#destination(entry);
    const comment = spec.comment.trim() || `${userInfo().username}@${hostname()}`;
    const made = await this.#sshKeys.generate({ ...spec, comment });
    const used = await this.#offerKey(entry, destination, made.file, use);
    if (spec.passphrase !== '') await this.#sshKeys.unlock(this.#sshTarget(entry), made.file, spec.passphrase, seconds);
    return { key: { ...made, ...used }, keys: await this.#sshKeys.list(this.#sshTarget(entry)) };
  }

  /** The private keys in ~/.ssh (or HOPDECK_SSH_DIR), which a host can be given instead of a new one. */
  async availableKeys(): Promise<{ dir: string; keys: AvailableKey[] }> {
    return { dir: this.#sshKeys.sshDir, keys: await this.#sshKeys.available() };
  }

  /** Makes ssh offer an SSH host one of the keys availableKeys() lists, as generateKey() does a new one. */
  async useKey(id: string, file: string, use: KeyUse): Promise<{ used: UsedKey; keys: SshKeysView } | undefined> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    const destination = this.#destination(entry);
    if (!(await this.#sshKeys.available()).some((key) => key.file === file)) {
      throw new HostError('command-failed', `${file} is not a private key in ${this.#sshKeys.sshDir}`);
    }
    const used = await this.#offerKey(entry, destination, file, use);
    return { used, keys: await this.#sshKeys.list(this.#sshTarget(entry)) };
  }

  /** Makes ssh offer the host the key: hopdeck adds it itself (hosts.json, ssh -i), or a Host block in ~/.ssh/config names it. */
  async #offerKey(entry: Entry, destination: string, file: string, use: KeyUse): Promise<UsedKey> {
    if (use === 'hopdeck') {
      await this.#rememberKey(entry, file);
      return { file, use };
    }
    const config = await addIdentityToConfig({ configFile: this.#options.sshConfigFile ?? join(homedir(), '.ssh', 'config'), destination, identityFile: file });
    return { file, use, config };
  }

  /** Stops adding the key hopdeck remembers for an SSH host; ~/.ssh/config decides alone again. */
  async forgetKey(id: string): Promise<SshKeysView | undefined> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    this.#destination(entry);
    await this.#rememberKey(entry, undefined);
    return this.#sshKeys.list(this.#sshTarget(entry));
  }

  /** Changes the key hopdeck adds for a host: a new executor with it, kept in hosts.json. */
  async #rememberKey(entry: Entry, file: string | undefined): Promise<void> {
    closeExecutor(entry.executor);
    entry.identityFile = file;
    entry.executor = this.#sshExecutor(entry.destination!, file);
    await this.#save();
  }

  /** Ends what hopdeck started for its hosts: its own ssh-agent, if any. */
  async close(): Promise<void> {
    for (const entry of this.#entries.values()) closeExecutor(entry.executor);
    await this.#sshKeys.close();
  }

  /** Reads the key an SSH host presents and what known_hosts says about it. */
  async checkHostKey(id: string): Promise<HostKeyCheck | undefined> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    return this.#hostKeys.check(this.#destination(entry));
  }

  /** Records the host key the user confirmed by its fingerprint, then connects again. */
  async trustHostKey(id: string, fingerprint: string, replace: boolean): Promise<HostSummary | undefined> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    await this.#hostKeys.trust(this.#destination(entry), fingerprint, replace);
    return this.connect(id);
  }

  /** How ssh reaches an SSH host: its destination, and the key hopdeck adds for it. */
  #sshTarget(entry: Entry): SshTarget {
    return { destination: this.#destination(entry), identityFile: entry.identityFile };
  }

  #destination(entry: Entry): string {
    if (entry.kind !== 'ssh' || entry.destination === undefined) {
      throw new HostStateError(`${entry.name} is not an SSH host, so it has no host key`);
    }
    return entry.destination;
  }

  /**
   * Reads the live ruleset twice, as JSON and as text with handles. The two
   * reads are separate, so a tool changing the ruleset in between can leave a
   * rule without its text; the UI says so instead of guessing.
   */
  async readRuleset(id: string): Promise<RulesetSnapshot | undefined> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    const access = this.#access(entry);

    const json = await runNft(access, ['-j', 'list', 'ruleset']);
    if (json.exitCode !== 0) throw new HostError('command-failed', json.stderr.trim() || `nft exited with code ${json.exitCode}`);
    const listing = await runNft(access, ['-a', 'list', 'ruleset']);
    if (listing.exitCode !== 0) {
      throw new HostError('command-failed', listing.stderr.trim() || `nft exited with code ${listing.exitCode}`);
    }

    const parsed = parseJson(json.stdout);
    await this.#observe(entry, parsed);
    return { json: parsed, listing: listing.stdout, readAt: new Date().toISOString() };
  }

  /** Counter values and table fingerprints: one `nft -j list ruleset`, reduced to what the panel polls for. */
  async live(id: string): Promise<LiveState | undefined> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    const parsed = await this.#readJson(entry);
    await this.#observe(entry, parsed);
    return liveState(parsed, new Date().toISOString());
  }

  /** `nft -j list ruleset`, parsed. */
  async #readJson(entry: Entry): Promise<unknown> {
    const json = await runNft(this.#access(entry), ['-j', 'list', 'ruleset']);
    if (json.exitCode !== 0) throw new HostError('command-failed', json.stderr.trim() || `nft exited with code ${json.exitCode}`);
    return parseJson(json.stdout);
  }

  /** Every look at the ruleset may find a change made outside hopdeck; see History.observe(). */
  async #observe(entry: Entry, json: unknown): Promise<void> {
    if (this.#platform(entry).firewall !== 'read-only') await this.#history.observe(this.#historyTarget(entry), json);
  }

  /**
   * The packets log statements wrote to the host's kernel log, newest first;
   * with `after`, those since that journal cursor. The sandbox has none: the
   * kernel writes no packets from a network namespace of its own.
   */
  async packetLog(id: string, after: string | undefined): Promise<PacketLogView | undefined> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    // Its commands would read this machine's own kernel log, which is not the sandbox's.
    if (entry.kind === 'sandbox') throw new HostStateError('the sandbox has no packet log: the kernel writes none from a network namespace of its own');
    return readPacketLog(this.#access(entry), after);
  }

  /**
   * CPU and memory use. CPU is measured since the previous reading; the first
   * one, or one after a long pause, reads twice a moment apart. No root needed.
   */
  async usage(id: string): Promise<HostUsage | undefined> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    if (entry.status.state !== 'connected') throw new HostStateError(`${entry.name} is not connected; connect to it first`);
    const read = async () => {
      const result = await entry.executor.exec(['sh', '-c', USAGE_COMMAND]);
      if (result.exitCode !== 0) throw new HostError('command-failed', result.stderr.trim() || `reading /proc failed with code ${result.exitCode}`);
      try {
        return { ...parseUsage(result.stdout), at: Date.now() };
      } catch (error) {
        throw new HostError('command-failed', error instanceof Error ? error.message : String(error));
      }
    };
    let previous = entry.cpu;
    if (previous === undefined || Date.now() - previous.at > 60_000) {
      previous = { ...(await read()).cpu, at: Date.now() };
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const now = await read();
    entry.cpu = { ...now.cpu, at: now.at };
    return {
      readAt: new Date(now.at).toISOString(),
      cpu: { percent: Math.round(cpuPercent(previous, now.cpu)), threads: now.cpu.threads },
      memory: now.memory,
    };
  }

  /** How to run nft as root on a connected host; throws when that is not possible yet. */
  #access(entry: Entry): NftAccess {
    const { status } = entry;
    if (status.state !== 'connected') throw new HostStateError(`${entry.name} is not connected; connect to it first`);
    if (status.facts.nft === undefined) throw new HostError('nft-missing');
    return { executor: entry.executor, nftPath: status.facts.nft.path, privilege: status.privilege, password: entry.password };
  }

  #sshEntry(host: StoredHost): Entry {
    return {
      id: host.id,
      kind: 'ssh',
      name: host.name ?? host.destination,
      destination: host.destination,
      executor: this.#sshExecutor(host.destination, host.identityFile),
      status: { state: 'new' },
      manualOverride: false,
      identityFile: host.identityFile,
    };
  }

  /** The shared executor of an SSH host. */
  #sshExecutor(destination: string, identityFile: string | undefined): Executor {
    const connection = { destination, identityFile, configFile: this.#options.sshConfigFile, env: this.#sshKeys.env };
    return new LoginGuard(
      this.#options.createSshExecutor?.(destination, { shared: true, identityFile }) ??
        // Where ssh has no ControlMaster (Windows), one long session per host does its work.
        (sshSessionsWanted() ? new SessionExecutor(connection) : new SshExecutor({ ...connection, controlDir: this.#options.controlDir })),
    );
  }

  #put(entry: Entry): void {
    this.#entries.set(entry.id, entry);
  }

  async #save(): Promise<void> {
    const hosts: StoredHost[] = [...this.#entries.values()]
      .filter((entry) => entry.kind === 'ssh')
      .map((entry) => ({
        id: entry.id,
        destination: entry.destination!,
        name: entry.name,
        ...(entry.identityFile !== undefined && { identityFile: entry.identityFile }),
      }));
    await writeInventory(this.#options.configDir, hosts);
  }
}

function summary(entry: Entry): HostSummary {
  const { id, kind, name, destination, status, manualOverride } = entry;
  return destination === undefined
    ? { id, kind, name, status, manualOverride }
    : { id, kind, name, destination, status, manualOverride };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new HostError('command-failed', `nft -j printed something that is not JSON (${reason}): ${text.slice(0, 300)}`);
  }
}

function toStatusError(error: unknown): { code: HostErrorCode | 'unknown'; detail: string } {
  if (error instanceof HostError) return { code: error.code, detail: error.detail };
  return { code: 'unknown', detail: error instanceof Error ? error.message : String(error) };
}

const INVENTORY_FILE = 'hosts.json';

async function readInventory(configDir: string): Promise<StoredHost[]> {
  let text: string;
  try {
    text = await readFile(join(configDir, INVENTORY_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const data = JSON.parse(text) as { hosts?: StoredHost[] };
  return (data.hosts ?? []).filter(
    (host) =>
      typeof host.id === 'string' &&
      typeof host.destination === 'string' &&
      isValidDestination(host.destination) &&
      (host.identityFile === undefined || typeof host.identityFile === 'string'),
  );
}

/** Writes a temporary file and renames it, so a crash never leaves a half-written inventory. */
async function writeInventory(configDir: string, hosts: StoredHost[]): Promise<void> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const path = join(configDir, INVENTORY_FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, hosts }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/** Ends what an executor keeps open, such as an SSH session. */
function closeExecutor(executor: Executor): void {
  (executor as Executor & { close?(): void }).close?.();
}
