// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { HISTORY_MAX_BYTES, RSA_BITS, validMaxBytes, type Family, type KeyUse, type TableChange, type TraceFilter } from '@hopdeck/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HostError } from './hosts/errors.ts';
import { HostStateError, InvalidHostError, type HostManager } from './hosts/manager.ts';
import { ApiError, readJson, sendError, sendJson } from './http.ts';
import { MAX_KEY_LIFETIME } from './hosts/ssh-keys.ts';
import { SECURITY_HEADERS } from './security.ts';
import { errorForTerminal } from './terminal.ts';

export interface ApiContext {
  hosts: HostManager;
  version: string;
}

interface Reply {
  status?: number;
  /** Omitted for 204 No Content. */
  body?: unknown;
}

interface Route {
  method: string;
  pattern: RegExp;
  handle(req: IncomingMessage, params: string[], ctx: ApiContext): Promise<Reply>;
}

const ROUTES: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/health$/,
    handle: async (_req, _params, ctx) => ({ body: { ok: true, version: ctx.version } }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/hosts$/,
    handle: async (_req, _params, ctx) => ({ body: { hosts: ctx.hosts.list() } }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/hosts$/,
    async handle(req, _params, ctx) {
      const body = asObject(await readJson(req));
      const host = await ctx.hosts.add({
        destination: requiredString(body, 'destination', 255),
        name: optionalString(body, 'name', 100),
      });
      return { status: 201, body: { host } };
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/hosts\/([^/]+)$/,
    async handle(_req, [id], ctx) {
      if (!(await ctx.hosts.remove(id!))) throw new ApiError(404, 'host-not-found');
      return { status: 204 };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/hosts\/([^/]+)\/connect$/,
    async handle(_req, [id], ctx) {
      return { body: { host: found(await ctx.hosts.connect(id!)) } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/hosts\/([^/]+)\/ruleset$/,
    async handle(_req, [id], ctx) {
      return { body: { ruleset: found(await ctx.hosts.readRuleset(id!)) } };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/hosts\/([^/]+)\/manual-override$/,
    async handle(req, [id], ctx) {
      const body = asObject(await readJson(req));
      if (typeof body['enabled'] !== 'boolean') throw new ApiError(400, 'invalid-body', 'enabled must be true or false');
      return { body: { host: found(ctx.hosts.setManualOverride(id!, body['enabled'])) } };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/hosts\/([^/]+)\/deployments$/,
    async handle(req, [id], ctx) {
      // Table definitions can hold large sets, hence the bigger limit.
      const body = asObject(await readJson(req, 8 * 1024 * 1024));
      if (!Array.isArray(body['changes'])) throw new ApiError(400, 'invalid-body', 'changes must be a list');
      const changes = body['changes'].map(toChange);
      const restoredFrom = body['restoredFrom'];
      if (restoredFrom !== undefined && !(typeof restoredFrom === 'number' && Number.isInteger(restoredFrom) && restoredFrom > 0)) {
        throw new ApiError(400, 'invalid-body', 'restoredFrom must be a version number');
      }
      const options = restoredFrom === undefined ? {} : { restoredFrom };
      return { status: 201, body: { deployment: found(await ctx.hosts.prepareDeployment(id!, changes, options)) } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/hosts\/([^/]+)\/history$/,
    async handle(_req, [id], ctx) {
      return { body: { history: found(await ctx.hosts.history(id!)) } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/hosts\/([^/]+)\/history\/(\d{1,9})$/,
    async handle(_req, [id, version], ctx) {
      found(ctx.hosts.get(id!));
      const detail = await ctx.hosts.historyVersion(id!, Number(version));
      if (detail === undefined) throw new ApiError(404, 'version-not-found');
      return { body: { version: detail } };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/hosts\/([^/]+)\/settings$/,
    async handle(req, [id], ctx) {
      const body = asObject(await readJson(req));
      const history = body['history'];
      const maxBytes = typeof history === 'object' && history !== null ? (history as Record<string, unknown>)['maxBytes'] : undefined;
      if (!validMaxBytes(maxBytes)) {
        throw new ApiError(400, 'invalid-body', `history.maxBytes must be a whole number of bytes from ${HISTORY_MAX_BYTES.min} to ${HISTORY_MAX_BYTES.max}`);
      }
      return { body: { history: found(await ctx.hosts.saveSettings(id!, { history: { maxBytes } })) } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/hosts\/([^/]+)\/live$/,
    async handle(_req, [id], ctx) {
      return { body: { live: found(await ctx.hosts.live(id!)) } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/hosts\/([^/]+)\/packet-log$/,
    async handle(req, [id], ctx) {
      const after = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('after') ?? undefined;
      // A journal cursor: "s=…;i=…;b=…;m=…;t=…;x=…", hex digits and those letters.
      if (after !== undefined && !/^[A-Za-z0-9=;_-]{1,512}$/.test(after)) throw new ApiError(400, 'invalid-query', 'after must be a journal cursor');
      return { body: { log: found(await ctx.hosts.packetLog(id!, after)) } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/hosts\/([^/]+)\/usage$/,
    async handle(_req, [id], ctx) {
      return { body: { usage: found(await ctx.hosts.usage(id!)) } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/hosts\/([^/]+)\/persistence$/,
    async handle(_req, [id], ctx) {
      return { body: { persistence: found(await ctx.hosts.persistence(id!)) } };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/hosts\/([^/]+)\/persistence\/(save|include|service)$/,
    async handle(_req, [id, action], ctx) {
      const done = found(await ctx.hosts.persist(id!, action as 'save' | 'include' | 'service'));
      return { body: { persistence: done.status, ...(done.result && { result: done.result }) } };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/hosts\/([^/]+)\/traces$/,
    async handle(req, [id], ctx) {
      const body = asObject(await readJson(req));
      const filter = toTraceFilter(body['filter']);
      const seconds = typeof body['seconds'] === 'number' ? body['seconds'] : 60;
      const perSecond = typeof body['perSecond'] === 'number' ? body['perSecond'] : 10;
      return { status: 201, body: { trace: found(await ctx.hosts.startTrace(id!, filter, { seconds, perSecond })) } };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/hosts\/([^/]+)\/test-traffic$/,
    async handle(req, [id], ctx) {
      const body = asObject(await readJson(req));
      const port = body['port'];
      if (port !== undefined && !(typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536)) {
        throw new ApiError(400, 'invalid-body', 'port must be a number from 1 to 65535');
      }
      return { body: { output: found(await ctx.hosts.testTraffic(id!, port)) } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/traces\/([^/]+)$/,
    async handle(_req, [id], ctx) {
      return { body: { trace: foundTrace(await ctx.hosts.trace(id!, 'get')) } };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/traces\/([^/]+)\/(stop|discard)$/,
    async handle(_req, [id, action], ctx) {
      return { body: { trace: foundTrace(await ctx.hosts.trace(id!, action as 'stop' | 'discard')) } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/deployments\/([^/]+)$/,
    async handle(_req, [id], ctx) {
      return { body: { deployment: foundDeployment(await ctx.hosts.deployment(id!, 'get')) } };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/deployments\/([^/]+)\/(apply|confirm|rollback|discard)$/,
    async handle(_req, [id, action], ctx) {
      const deployment = await ctx.hosts.deployment(id!, action as 'apply' | 'confirm' | 'rollback' | 'discard');
      return { body: { deployment: foundDeployment(deployment) } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/hosts\/([^/]+)\/host-key$/,
    async handle(_req, [id], ctx) {
      return { body: { hostKey: found(await ctx.hosts.checkHostKey(id!)) } };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/hosts\/([^/]+)\/host-key$/,
    async handle(req, [id], ctx) {
      const body = asObject(await readJson(req));
      const fingerprint = requiredString(body, 'fingerprint', 200);
      return { body: { host: found(await ctx.hosts.trustHostKey(id!, fingerprint, body['replace'] === true)) } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/hosts\/([^/]+)\/ssh-keys$/,
    async handle(_req, [id], ctx) {
      return { body: { keys: found(await ctx.hosts.sshKeys(id!)) } };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/hosts\/([^/]+)\/ssh-keys\/unlock$/,
    async handle(req, [id], ctx) {
      const body = asObject(await readJson(req));
      const file = requiredString(body, 'file', 4096);
      const passphrase = requiredString(body, 'passphrase', 1024);
      return { body: { keys: found(await ctx.hosts.unlockSshKey(id!, file, passphrase, lifetime(body['seconds']))) } };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/hosts\/([^/]+)\/ssh-keys\/generate$/,
    async handle(req, [id], ctx) {
      const body = asObject(await readJson(req));
      const type = body['type'];
      if (type !== 'ed25519' && type !== 'rsa') throw new ApiError(400, 'invalid-body', 'type must be "ed25519" or "rsa"');
      const bits = body['bits'];
      if (type === 'rsa' && !(RSA_BITS as readonly unknown[]).includes(bits)) throw new ApiError(400, 'invalid-body', `bits must be ${RSA_BITS.join(', ')} for RSA`);
      const use = keyUse(body['use']);
      const seconds = lifetime(body['seconds']);
      const spec = {
        type,
        bits: type === 'rsa' ? (bits as number) : undefined,
        name: requiredString(body, 'name', 64),
        comment: optionalString(body, 'comment', 200) ?? '',
        // Empty: a key without a passphrase.
        passphrase: optionalString(body, 'passphrase', 1024) ?? '',
      } as const;
      return { body: found(await ctx.hosts.generateKey(id!, spec, use, seconds)) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/ssh-keys$/,
    async handle(_req, _params, ctx) {
      return { body: await ctx.hosts.availableKeys() };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/hosts\/([^/]+)\/ssh-keys\/use$/,
    async handle(req, [id], ctx) {
      const body = asObject(await readJson(req));
      const file = requiredString(body, 'file', 4096);
      const use = keyUse(body['use']);
      return { body: found(await ctx.hosts.useKey(id!, file, use)) };
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/hosts\/([^/]+)\/ssh-keys\/remembered$/,
    async handle(_req, [id], ctx) {
      return { body: { keys: found(await ctx.hosts.forgetKey(id!)) } };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/hosts\/([^/]+)\/ssh-keys\/setup$/,
    async handle(req, [id], ctx) {
      const body = asObject(await readJson(req));
      const file = requiredString(body, 'file', 4096);
      const password = requiredString(body, 'password', 1024);
      return { body: { setup: found(await ctx.hosts.setUpKeyLogin(id!, file, password, body['allow'] === true)) } };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/hosts\/([^/]+)\/sudo-password$/,
    async handle(req, [id], ctx) {
      const body = asObject(await readJson(req));
      const password = requiredString(body, 'password', 1024);
      return { body: { host: found(await ctx.hosts.setSudoPassword(id!, password)) } };
    },
  },
];

export async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, ctx: ApiContext) {
  const candidates = ROUTES.filter((route) => route.pattern.test(path));
  const route = candidates.find((candidate) => candidate.method === req.method);
  try {
    if (candidates.length === 0) throw new ApiError(404, 'not-found');
    if (route === undefined) throw new ApiError(405, 'method-not-allowed');
    const params = route.pattern.exec(path)!.slice(1).map(decodeURIComponent);
    const reply = await route.handle(req, params, ctx);
    if (reply.body === undefined) {
      res.writeHead(reply.status ?? 204, SECURITY_HEADERS).end();
    } else {
      sendJson(res, reply.status ?? 200, reply.body);
    }
  } catch (error) {
    sendError(res, toApiError(error));
  }
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof InvalidHostError) return new ApiError(400, 'invalid-host', error.message);
  if (error instanceof HostStateError) return new ApiError(409, 'host-state-changed', error.message);
  if (error instanceof HostError) return new ApiError(hostErrorStatus(error), error.code, error.detail || error.code);
  // The panel is local and for its owner only; the real message helps more than hiding it.
  // It may quote a host's output, so it reaches the terminal escaped.
  console.error(errorForTerminal(error));
  return new ApiError(500, 'internal-error', error instanceof Error ? error.message : String(error));
}

/** 403 when access is missing, 400 for a wrong password, 502 when the host or the connection failed. */
function hostErrorStatus(error: HostError): number {
  switch (error.code) {
    case 'wrong-password':
    case 'wrong-passphrase':
    case 'login-password-rejected':
      return 400;
    case 'key-exists':
      return 409;
    case 'password-required':
    case 'password-login-disabled':
    case 'no-privileges':
    case 'sudo-not-allowed':
    case 'known-hosts-unwritable':
    case 'host-key-in-global-file':
      return 403;
    case 'host-key-mismatch':
    case 'ssh-host-key-changed':
    case 'ruleset-changed':
    case 'rollback-unavailable':
    case 'deployment-state':
    case 'persistence-unavailable':
    case 'include-rejected':
      return 409;
    case 'table-not-editable':
      return 403;
    case 'invalid-definition':
    case 'invalid-filter':
      return 400;
    case 'trace-unavailable':
    case 'platform-read-only':
      return 409;
    default:
      return 502;
  }
}

function found<T>(value: T | undefined): T {
  if (value === undefined) throw new ApiError(404, 'host-not-found');
  return value;
}

function foundDeployment<T>(value: T | undefined): T {
  if (value === undefined) throw new ApiError(404, 'deployment-not-found');
  return value;
}

function foundTrace<T>(value: T | undefined): T {
  if (value === undefined) throw new ApiError(404, 'trace-not-found');
  return value;
}

/** Only the known fields, each a string; traceFilterProblem() checks the values. */
function toTraceFilter(value: unknown): TraceFilter {
  const body = asObject(value ?? {});
  const filter: TraceFilter = {};
  for (const key of ['protocol', 'saddr', 'daddr', 'sport', 'dport', 'iif'] as const) {
    const field = optionalString(body, key, 1024)?.trim();
    if (field) filter[key] = field;
  }
  return filter;
}

const FAMILIES: readonly Family[] = ['ip', 'ip6', 'inet', 'arp', 'bridge', 'netdev'];

function toChange(value: unknown): TableChange {
  const change = asObject(value);
  const family = change['family'];
  if (typeof family !== 'string' || !FAMILIES.includes(family as Family)) {
    throw new ApiError(400, 'invalid-body', `family must be one of ${FAMILIES.join(', ')}`);
  }
  const table = nftObjectName(change, 'table');
  switch (change['kind']) {
    case 'adopt':
    case 'delete':
      return { kind: change['kind'], family: family as Family, table };
    case 'replace': {
      const base = optionalString(change, 'base', 8 * 1024 * 1024);
      return {
        kind: 'replace',
        family: family as Family,
        table,
        definition: requiredString(change, 'definition', 8 * 1024 * 1024),
        ...(base !== undefined && { base }),
      };
    }
    case 'elements': {
      const setKind = change['setKind'];
      if (setKind !== 'set' && setKind !== 'map') throw new ApiError(400, 'invalid-body', 'setKind must be set or map');
      return {
        kind: 'elements',
        family: family as Family,
        table,
        set: nftObjectName(change, 'set'),
        setKind,
        add: stringList(change, 'add'),
        remove: stringList(change, 'remove'),
      };
    }
    default:
      throw new ApiError(400, 'invalid-body', 'kind must be adopt, replace, delete or elements');
  }
}

/**
 * A table's or set's name as nft input can hold it: a name in quotes ends at
 * the next '"', as nft knows no escapes, and no name holds control characters.
 */
function nftObjectName(body: Record<string, unknown>, key: string): string {
  const name = requiredString(body, key, 256);
  if (/["\u0000-\u001f\u007f]/.test(name)) {
    throw new ApiError(400, 'invalid-body', `${key} ${JSON.stringify(name)} cannot be written in nft input: it holds a double quote or a control character`);
  }
  return name;
}

/** Elements: nft syntax each, checked in full when the change is planned. */
function stringList(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.length > 100_000 || value.some((item) => typeof item !== 'string' || item.length > 4096)) {
    throw new ApiError(400, 'invalid-body', `${key} must be a list of strings`);
  }
  return value as string[];
}

/** How long the agent keeps an unlocked key: null for as long as it runs. */
function lifetime(seconds: unknown): number | undefined {
  if (seconds === null) return undefined;
  if (typeof seconds === 'number' && Number.isInteger(seconds) && seconds > 0 && seconds <= MAX_KEY_LIFETIME) return seconds;
  throw new ApiError(400, 'invalid-body', `seconds must be null or a whole number from 1 to ${MAX_KEY_LIFETIME}`);
}

/** How ssh is to offer a host its key: hopdeck adds it, or ~/.ssh/config names it. */
function keyUse(use: unknown): KeyUse {
  if (use === 'hopdeck' || use === 'config') return use;
  throw new ApiError(400, 'invalid-body', 'use must be "hopdeck" or "config"');
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'invalid-body', 'expected a JSON object');
  }
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string, maxLength: number): string {
  const value = optionalString(body, key, maxLength);
  if (value === undefined || value === '') throw new ApiError(400, 'invalid-body', `${key} is required`);
  return value;
}

function optionalString(body: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new ApiError(400, 'invalid-body', `${key} must be a string of at most ${maxLength} characters`);
  }
  return value;
}
