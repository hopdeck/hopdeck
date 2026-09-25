import type { Family, TableChange } from '@nftm/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HostError } from './hosts/errors.ts';
import { HostStateError, InvalidHostError, type HostManager } from './hosts/manager.ts';
import { ApiError, readJson, sendError, sendJson } from './http.ts';
import { SECURITY_HEADERS } from './security.ts';

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
      return { status: 201, body: { deployment: found(await ctx.hosts.prepareDeployment(id!, changes)) } };
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
  console.error(error);
  return new ApiError(500, 'internal-error', error instanceof Error ? error.message : String(error));
}

/** 403 when access is missing, 400 for a wrong password, 502 when the host or the connection failed. */
function hostErrorStatus(error: HostError): number {
  switch (error.code) {
    case 'wrong-password':
      return 400;
    case 'password-required':
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
      return 400;
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

const FAMILIES: readonly Family[] = ['ip', 'ip6', 'inet', 'arp', 'bridge', 'netdev'];

function toChange(value: unknown): TableChange {
  const change = asObject(value);
  const family = change['family'];
  if (typeof family !== 'string' || !FAMILIES.includes(family as Family)) {
    throw new ApiError(400, 'invalid-body', `family must be one of ${FAMILIES.join(', ')}`);
  }
  const table = requiredString(change, 'table', 256);
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
        set: requiredString(change, 'set', 256),
        setKind,
        add: stringList(change, 'add'),
        remove: stringList(change, 'remove'),
      };
    }
    default:
      throw new ApiError(400, 'invalid-body', 'kind must be adopt, replace, delete or elements');
  }
}

/** Elements: nft syntax each, checked in full when the change is planned. */
function stringList(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.length > 100_000 || value.some((item) => typeof item !== 'string' || item.length > 4096)) {
    throw new ApiError(400, 'invalid-body', `${key} must be a list of strings`);
  }
  return value as string[];
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
