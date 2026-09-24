import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * The panel holds root-level SSH access to firewalls, so every request is
 * checked three ways:
 * - Host header: defeats DNS rebinding (a remote site resolving to 127.0.0.1),
 * - Origin header: other sites open in the same browser,
 * - token: other local users and processes that can reach 127.0.0.1.
 */
export interface AccessPolicy {
  token: string;
  /** Accepted Host header values, e.g. "127.0.0.1:7400". */
  allowedHosts: ReadonlySet<string>;
  /** Accepted Origin header values, checked when a browser sends one. */
  allowedOrigins: ReadonlySet<string>;
}

export type AccessDecision = { ok: true } | { ok: false; status: 401 | 403; reason: string };

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function createAccessPolicy(token: string, port: number, extraOrigins: readonly string[] = []): AccessPolicy {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  return {
    token,
    allowedHosts: new Set(hosts),
    allowedOrigins: new Set([...hosts.map((host) => `http://${host}`), ...extraOrigins]),
  };
}

/** Static UI files need a valid Host and Origin; the API also needs the token. */
export function checkAccess(headers: IncomingHttpHeaders, policy: AccessPolicy, requireToken: boolean): AccessDecision {
  if (headers.host === undefined || !policy.allowedHosts.has(headers.host)) {
    return { ok: false, status: 403, reason: 'unexpected Host header' };
  }
  if (headers.origin !== undefined && !policy.allowedOrigins.has(headers.origin)) {
    return { ok: false, status: 403, reason: 'unexpected Origin header' };
  }
  if (requireToken && !tokenMatches(headers.authorization, policy.token)) {
    return { ok: false, status: 401, reason: 'missing or invalid token' };
  }
  return { ok: true };
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function tokenMatches(authorization: string | undefined, token: string): boolean {
  const prefix = 'Bearer ';
  if (authorization === undefined || !authorization.startsWith(prefix)) return false;
  const given = Buffer.from(authorization.slice(prefix.length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
