import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { log } from '../log.js';

/** Env var holding the shared bearer secret for the `/mcp` endpoint. */
export const TOKEN_ENV = 'SURFACEMCP_TOKEN';
/**
 * Env var that, when truthy, disables the per-caller bearer-token gate.
 * DNS-rebinding (Host/Origin) protection stays on regardless. Default: gate ON.
 */
export const AUTH_DISABLED_ENV = 'SURFACEMCP_AUTH_DISABLED';

export type TokenSource = 'env' | 'generated' | 'disabled';

export type TokenState = {
  /** The active shared secret, or null when the token gate is disabled. */
  token: string | null;
  source: TokenSource;
};

export type SecurityOptions = {
  tokenState: TokenState;
  /** Allowed `Host` header authorities (host:port), lowercased. */
  allowedHosts: string[];
  /** Allowed `Origin` header values, lowercased. Empty ⇒ reject any request carrying an Origin. */
  allowedOrigins: string[];
};

function isTruthyEnv(v: string | undefined): boolean {
  if (v === undefined) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * Decide the `/mcp` shared-secret token from the environment.
 * - {@link AUTH_DISABLED_ENV} truthy → `{ token: null, source: 'disabled' }` (opt-out for trusted local dev)
 * - {@link TOKEN_ENV} set → `{ token: <value>, source: 'env' }`
 * - otherwise → `{ token: <random 32-byte hex>, source: 'generated' }`
 */
export function resolveTokenState(env: NodeJS.ProcessEnv = process.env): TokenState {
  if (isTruthyEnv(env[AUTH_DISABLED_ENV])) return { token: null, source: 'disabled' };
  const configured = env[TOKEN_ENV];
  if (configured !== undefined && configured.trim() !== '') {
    return { token: configured, source: 'env' };
  }
  return { token: randomBytes(32).toString('hex'), source: 'generated' };
}

/**
 * Constant-time string comparison. Both inputs are hashed to a fixed-width digest
 * first, so the comparison never throws on a length mismatch and does not leak the
 * secret's length via an early return.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/** Extract a bearer token from an `Authorization` header value; null when absent/malformed. */
export function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer[ \t]+(.+)$/i.exec(authHeader.trim());
  return m ? m[1]!.trim() : null;
}

/** True when the Authorization header presents a bearer token equal to `token`. */
export function isTokenAuthorized(authHeader: string | undefined, token: string): boolean {
  const presented = extractBearer(authHeader);
  if (presented === null) return false;
  return timingSafeEqualStr(presented, token);
}

/** Build the loopback `Host` header allowlist for a given listen port. */
export function buildAllowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

/** True when the `Host` header is in the allowlist. A missing Host is rejected. */
export function isHostAllowed(host: string | undefined, allowedHosts: string[]): boolean {
  if (!host) return false;
  return allowedHosts.includes(host.toLowerCase());
}

/**
 * True when the `Origin` header is acceptable.
 *
 * `allowedOrigins` is empty by default: a request that carries an Origin header
 * (i.e. a browser cross-context fetch — the DNS-rebinding threat) is rejected,
 * while a non-browser client that sends no Origin is allowed. A populated
 * allowlist permits those exact origins.
 */
export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (origin === undefined || origin === '') return true;
  return allowedOrigins.includes(origin.toLowerCase());
}

function deny(res: Response, status: number, code: string, message: string): void {
  // JSON-RPC-shaped error envelope so MCP clients surface a clean failure.
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code: -32600, message: `${code}: ${message}` },
    id: null,
  });
}

/**
 * Express middleware guarding the `/mcp` endpoint, in order:
 *  1. DNS-rebinding protection — `Host` must be a known loopback authority (403).
 *  2. Origin allowlist — reject browser cross-origin requests (403).
 *  3. Shared-secret bearer token — unless the gate is explicitly disabled (401).
 */
export function createMcpSecurityMiddleware(opts: SecurityOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isHostAllowed(req.headers.host, opts.allowedHosts)) {
      log.warn({ host: req.headers.host }, 'mcp request rejected: host header not allowed');
      deny(res, 403, 'forbidden_host', 'Host header is not an allowed loopback authority');
      return;
    }

    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!isOriginAllowed(origin, opts.allowedOrigins)) {
      log.warn({ origin }, 'mcp request rejected: origin not allowed');
      deny(res, 403, 'forbidden_origin', 'Origin header is not allowed');
      return;
    }

    if (opts.tokenState.token !== null) {
      if (!isTokenAuthorized(req.headers.authorization, opts.tokenState.token)) {
        log.warn('mcp request rejected: missing or invalid bearer token');
        deny(res, 401, 'unauthorized', 'Missing or invalid bearer token');
        return;
      }
    }

    next();
  };
}

/**
 * Log the token disposition ONCE at startup. The generated value is printed a
 * single time so the operator can copy it; it is never logged per-request.
 */
export function logTokenStartup(state: TokenState, endpoint: string): void {
  switch (state.source) {
    case 'disabled':
      log.warn(
        { endpoint },
        `SurfaceMCP /mcp token gate DISABLED via ${AUTH_DISABLED_ENV} — any local process that can reach the port may call it`
      );
      break;
    case 'env':
      log.info(
        { endpoint },
        `SurfaceMCP /mcp requires "Authorization: Bearer <token>" (token from ${TOKEN_ENV})`
      );
      break;
    case 'generated':
      log.info(
        { endpoint, token: state.token },
        `SurfaceMCP /mcp generated a one-time bearer token — send it as "Authorization: Bearer <token>". Set ${TOKEN_ENV} to pin a stable value.`
      );
      break;
  }
}
