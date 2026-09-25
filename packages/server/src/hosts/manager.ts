import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeploymentView, Executor, HostErrorCode, HostKeyCheck, HostKind, HostStatus, HostSummary, RulesetSnapshot, TableChange } from '@nftm/core';
import { HostError } from './errors.ts';
import { Deployments, type DeployLogEntry, type DeployTarget } from './deploy.ts';
import { collectFacts } from './facts.ts';
import { HostKeys } from './host-keys.ts';
import { LocalExecutor } from './local.ts';
import { detectPrivilege, runNft, type NftAccess } from './privilege.ts';
import { isValidDestination, SshExecutor } from './ssh.ts';

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
}

/** What hosts.json stores: SSH hosts only; localhost and the sandbox are built in. */
interface StoredHost {
  id: string;
  destination: string;
  name?: string;
}

export interface HostManagerOptions {
  /** Where hosts.json lives, e.g. ~/.config/nftm. */
  configDir: string;
  /** Directory for SSH ControlMaster sockets. */
  controlDir: string;
  /** An ssh config file used instead of ~/.ssh/config. */
  sshConfigFile?: string | undefined;
  /** Executor of the sandbox host, when one runs. */
  sandbox?: Executor;
  /** Replaces the SSH executor, for tests; `shared: false` asks for a connection that shares nothing. */
  createSshExecutor?: (destination: string, options?: { shared: boolean }) => Executor;
  /** Seconds until a host rolls back an unconfirmed change. */
  rollbackSeconds?: number;
  /** Replaces host key handling, for tests. */
  hostKeys?: HostKeys;
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

  private constructor(options: HostManagerOptions) {
    this.#options = options;
    this.#hostKeys = options.hostKeys ?? new HostKeys({ configFile: options.sshConfigFile });
    this.#deployments = new Deployments({
      ...(options.rollbackSeconds !== undefined && { seconds: options.rollbackSeconds }),
      log: (entry) => this.#logChange(entry),
    });
  }

  static async open(options: HostManagerOptions): Promise<HostManager> {
    const manager = new HostManager(options);
    manager.#put({ id: 'local', kind: 'local', name: 'localhost', executor: new LocalExecutor(), status: { state: 'new' }, manualOverride: false });
    if (options.sandbox !== undefined) {
      manager.#put({ id: 'sandbox', kind: 'sandbox', name: 'sandbox', executor: options.sandbox, status: { state: 'new' }, manualOverride: false });
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
    await this.#save();
    return true;
  }

  /** Collects facts and detects privileges; failures become an error status. */
  async connect(id: string): Promise<HostSummary | undefined> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
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

  /** Checks changes and stages them on the host; nothing changes until apply. */
  async prepareDeployment(id: string, changes: readonly TableChange[]): Promise<DeploymentView | undefined> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    return this.#deployments.prepare(this.#target(entry), changes);
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

  #target(entry: Entry): DeployTarget {
    const access = this.#access(entry);
    const status = entry.status as Extract<HostStatus, { state: 'connected' }>;
    return {
      hostId: entry.id,
      name: entry.name,
      kind: entry.kind,
      executor: entry.executor,
      access,
      systemd: status.facts.systemd,
      manualOverride: entry.manualOverride,
      freshExecutor: entry.kind === 'ssh' ? this.#freshExecutor(entry.destination!) : undefined,
    };
  }

  #freshExecutor(destination: string): Executor {
    return (
      this.#options.createSshExecutor?.(destination, { shared: false }) ??
      new SshExecutor({
        destination,
        controlDir: this.#options.controlDir,
        configFile: this.#options.sshConfigFile,
        shareConnection: false,
      })
    );
  }

  /** One JSON line per event in changes.log next to hosts.json. */
  async #logChange(entry: DeployLogEntry): Promise<void> {
    const host = this.#entries.get(entry.host);
    const line = { time: new Date().toISOString(), ...entry, destination: host?.destination ?? host?.name };
    await mkdir(this.#options.configDir, { recursive: true, mode: 0o700 });
    await appendFile(join(this.#options.configDir, 'changes.log'), `${JSON.stringify(line)}\n`, { mode: 0o600 });
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(json.stdout);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new HostError('command-failed', `nft -j printed something that is not JSON (${reason}): ${json.stdout.slice(0, 300)}`);
    }
    return { json: parsed, listing: listing.stdout, readAt: new Date().toISOString() };
  }

  /** How to run nft as root on a connected host; throws when that is not possible yet. */
  #access(entry: Entry): NftAccess {
    const { status } = entry;
    if (status.state !== 'connected') throw new HostStateError(`${entry.name} is not connected; connect to it first`);
    if (status.facts.nft === undefined) throw new HostError('nft-missing');
    return { executor: entry.executor, nftPath: status.facts.nft.path, privilege: status.privilege, password: entry.password };
  }

  #sshEntry(host: StoredHost): Entry {
    const executor =
      this.#options.createSshExecutor?.(host.destination) ??
      new SshExecutor({
        destination: host.destination,
        controlDir: this.#options.controlDir,
        configFile: this.#options.sshConfigFile,
      });
    return {
      id: host.id,
      kind: 'ssh',
      name: host.name ?? host.destination,
      destination: host.destination,
      executor,
      status: { state: 'new' },
      manualOverride: false,
    };
  }

  #put(entry: Entry): void {
    this.#entries.set(entry.id, entry);
  }

  async #save(): Promise<void> {
    const hosts: StoredHost[] = [...this.#entries.values()]
      .filter((entry) => entry.kind === 'ssh')
      .map((entry) => ({ id: entry.id, destination: entry.destination!, name: entry.name }));
    await writeInventory(this.#options.configDir, hosts);
  }
}

function summary(entry: Entry): HostSummary {
  const { id, kind, name, destination, status, manualOverride } = entry;
  return destination === undefined
    ? { id, kind, name, status, manualOverride }
    : { id, kind, name, destination, status, manualOverride };
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
    (host) => typeof host.id === 'string' && typeof host.destination === 'string' && isValidDestination(host.destination),
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
