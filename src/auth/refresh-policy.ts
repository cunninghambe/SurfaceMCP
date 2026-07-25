import type { AuthConfig } from '../types.js';

/**
 * Determines whether a response should trigger an auto-relogin.
 *
 * Per spec § 3.5: refresh only on 401/403 + a session-clear signal.
 * Bare 401s pass through unchanged.
 *
 * `authKind` is optional and purely additive: when it is `'oauth2'`, the
 * RFC 6750 bearer-challenge signals below also apply. Omitting it (or passing
 * any of the five pre-existing kinds) leaves the decision byte-identical to
 * before.
 */
export function shouldAutoRelogin(
  status: number,
  headers: Record<string, string>,
  body: unknown,
  sessionCookieName: string,
  authKind?: AuthConfig['kind']
): boolean {
  if (status !== 401 && status !== 403) return false;

  // Signal 0 (oauth2 only): RFC 6750 §3 — a resource server rejects an expired or
  // revoked bearer token with 401 + a `Bearer` challenge, with or without an
  // error code. Scoped to 401 (not 403) so an authorization failure such as
  // `insufficient_scope`, which re-minting the same token cannot fix, does not
  // spin the login loop.
  if (authKind === 'oauth2' && status === 401) {
    const challenge = headers['www-authenticate'] ?? '';
    if (/^\s*bearer\b/i.test(challenge)) return true;
    if (challenge.includes('error="expired_token"')) return true;
  }

  // Signal 1: Set-Cookie clears the session cookie
  const setCookie = headers['set-cookie'] ?? '';
  if (setCookie.includes(`${sessionCookieName}=;`) || setCookie.includes(`${sessionCookieName}=`) && setCookie.includes('Max-Age=0')) {
    return true;
  }
  if (setCookie.includes(`__Secure-${sessionCookieName}=;`)) return true;

  // Signal 2: WWW-Authenticate with error="invalid_token"
  const wwwAuth = headers['www-authenticate'] ?? '';
  if (wwwAuth.includes('error="invalid_token"')) return true;

  // Signal 3: common framework JSON error shapes
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (
      b['code'] === 'token_not_valid' || // DRF SimpleJWT
      b['error'] === 'invalid_token' ||
      b['message'] === 'Session expired' ||
      b['detail'] === 'Authentication credentials were not provided.' ||
      (typeof b['message'] === 'string' && /session.*(expired|invalid)/i.test(b['message']))
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Detect the effective session cookie name from auth config,
 * handling Auth.js v5 __Secure- prefix.
 */
export function getSessionCookieName(
  configured: string | undefined,
  isSecure: boolean
): string {
  const base = configured ?? 'next-auth.session-token';
  return isSecure ? `__Secure-${base}` : base;
}
