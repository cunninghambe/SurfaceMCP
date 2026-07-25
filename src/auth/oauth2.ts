import type { AuthConfig } from '../types.js';
import { resolveCredentials } from '../env/indirection.js';

type OAuth2Config = Extract<AuthConfig, { kind: 'oauth2' }>;

/**
 * Safety skew subtracted from the advertised `expires_in` so we re-authenticate
 * slightly before the authorization server considers the token dead. Capped at
 * half the lifetime so a short-lived token never computes an expiry in the past.
 */
const EXPIRY_SKEW_MS = 30_000;

const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

/** A token response is a few KB of JSON; anything larger is a broken or hostile
 * endpoint and is refused rather than buffered (mirrors call.ts's body cap). */
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

/**
 * Credential-key aliases accepted for each OAuth2 field, in precedence order.
 * Mirrors bearer.ts (`token` ?? `bearer`): snake_case is canonical, camelCase
 * is accepted for ergonomics.
 */
const CREDENTIAL_ALIASES = {
  client_id: ['client_id', 'clientId'],
  client_secret: ['client_secret', 'clientSecret'],
} as const;

/** Canonical OAuth2 credential field names, in a stable order. */
export const OAUTH2_CREDENTIAL_FIELDS = ['client_id', 'client_secret'] as const;
export type OAuth2CredentialField = (typeof OAUTH2_CREDENTIAL_FIELDS)[number];

/** A minted access token plus everything needed to know when to replace it. */
export type OAuth2Token = {
  accessToken: string;
  /** Normalized `token_type` from the response; 'Bearer' unless the AS says otherwise. */
  tokenType: string;
  /**
   * Epoch ms after which the access token must be re-fetched (derived from
   * `expires_in` minus a safety skew). Undefined when the AS returned no
   * `expires_in`, in which case only the reactive 401 path can refresh.
   */
  expiresAt?: number;
  /** Present only when the AS returned one (uncommon for client-credentials, RFC 6749 §4.4.3). */
  refreshToken?: string;
};

export type OAuth2Result =
  | { ok: true; token: OAuth2Token }
  | { ok: false; error: string };

/**
 * Map each canonical OAuth2 field to the raw credential key that supplies it,
 * or `undefined` when the role declares none. Returns KEY NAMES only — never values.
 */
export function resolveOAuth2CredentialKeys(
  credentials: Record<string, string>
): Record<OAuth2CredentialField, string | undefined> {
  return {
    client_id: CREDENTIAL_ALIASES.client_id.find((k) => k in credentials),
    client_secret: CREDENTIAL_ALIASES.client_secret.find((k) => k in credentials),
  };
}

/**
 * Canonical names of the OAuth2 credentials that are absent or resolve to an
 * empty string. Used by `doctor` to report credential presence. Returns KEY
 * NAMES only — never values.
 */
export function missingOAuth2CredentialKeys(credentials: Record<string, string>): string[] {
  const resolved = resolveCredentials(credentials);
  const keys = resolveOAuth2CredentialKeys(credentials);
  return OAUTH2_CREDENTIAL_FIELDS.filter((field) => {
    const rawKey = keys[field];
    return rawKey === undefined || (resolved[rawKey] ?? '') === '';
  });
}

/**
 * True when the token endpoint would send the client secret over a channel that
 * is neither TLS-protected nor loopback. Loopback http is allowed so local
 * fixtures / dev authorization servers work.
 */
export function isInsecureTokenUrl(tokenUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(tokenUrl);
  } catch {
    return true;
  }
  if (url.protocol === 'https:') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return !(host === 'localhost' || host === '127.0.0.1' || host === '::1');
}

/**
 * RFC 7230 `token` charset — what may safely appear in a header value we build
 * ourselves. A `token_type` outside it (or an access token containing control
 * characters) is rejected rather than concatenated into an `Authorization`
 * header, so a hostile/broken AS response cannot inject headers.
 */
const HTTP_TOKEN_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
/** Printable ASCII only: an access token is spliced into a header value. */
const HEADER_SAFE_VALUE_RE = /^[\x20-\x7E]+$/;

/** Normalize `token_type`: canonicalize `bearer` and fall back to Bearer if unusable. */
function normalizeTokenType(raw: unknown): string {
  if (typeof raw !== 'string' || !HTTP_TOKEN_RE.test(raw)) return 'Bearer';
  return raw.toLowerCase() === 'bearer' ? 'Bearer' : raw;
}

/**
 * The `Authorization` header value for a session minted by this module.
 * Respects a non-Bearer `token_type` when the AS returned one.
 */
export function oauth2AuthorizationHeader(token: string, tokenType?: string): string {
  return `${normalizeTokenType(tokenType)} ${token}`;
}

/** Compute the effective expiry from an `expires_in` value, or undefined when absent/unusable. */
function computeExpiresAt(rawExpiresIn: unknown, now: number): number | undefined {
  const seconds =
    typeof rawExpiresIn === 'number'
      ? rawExpiresIn
      : typeof rawExpiresIn === 'string' && rawExpiresIn.trim() !== ''
        ? Number(rawExpiresIn)
        : NaN;
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  const lifetimeMs = seconds * 1000;
  const skew = Math.min(EXPIRY_SKEW_MS, lifetimeMs / 2);
  return now + lifetimeMs - skew;
}

/** RFC 6749 §5.2 error codes are short lowercase tokens; anything else is not echoed. */
const RFC6749_ERROR_CODE_RE = /^[a-z_]{1,64}$/;

/**
 * Describe a non-2xx token response without echoing the body. Only the standard
 * `error` code is included, and only when it matches the RFC's shape — the
 * response body may contain caller-supplied or sensitive material.
 */
function describeTokenError(status: number, parsed: unknown): string {
  let code: string | undefined;
  if (parsed && typeof parsed === 'object') {
    const err = (parsed as Record<string, unknown>)['error'];
    if (typeof err === 'string' && RFC6749_ERROR_CODE_RE.test(err)) code = err;
  }
  return code
    ? `OAuth2 token request failed: status ${status} (error="${code}")`
    : `OAuth2 token request failed: status ${status}`;
}

/** Read a response body, refusing anything over `maxBytes` instead of buffering it. */
async function readLimitedText(
  res: Response,
  maxBytes: number
): Promise<{ text: string; tooLarge: boolean }> {
  if (!res.body) return { text: '', tooLarge: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        return { text: '', tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    // Stream error / abort: treat as an empty (unparseable) body.
    return { text: '', tooLarge: false };
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder().decode(combined), tooLarge: false };
}

type TokenRequestBody = { grantType: 'client_credentials' | 'refresh_token'; refreshToken?: string };

/**
 * Perform one token request and parse the response.
 *
 * Secret handling: credentials travel only in the request (Basic header or form
 * body) — never in the URL, never in a log line, never in a returned error string.
 */
async function requestToken(
  auth: OAuth2Config,
  credentials: Record<string, string>,
  req: TokenRequestBody
): Promise<OAuth2Result> {
  const resolved = resolveCredentials(credentials);
  const keys = resolveOAuth2CredentialKeys(credentials);
  const clientId = keys.client_id ? (resolved[keys.client_id] ?? '') : '';
  const clientSecret = keys.client_secret ? (resolved[keys.client_secret] ?? '') : '';

  if (!clientId) {
    return { ok: false, error: 'No client_id found in credentials (expected key: "client_id")' };
  }
  if (!clientSecret) {
    return { ok: false, error: 'No client_secret found in credentials (expected key: "client_secret")' };
  }

  const form = new URLSearchParams({ grant_type: req.grantType });
  if (req.grantType === 'refresh_token') {
    form.set('refresh_token', req.refreshToken ?? '');
  }
  if (auth.scope) form.set('scope', auth.scope);
  if (auth.audience) form.set('audience', auth.audience);

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
  };

  if ((auth.clientAuth ?? 'basic') === 'body') {
    form.set('client_id', clientId);
    form.set('client_secret', clientSecret);
  } else {
    // RFC 6749 §2.3.1: form-urlencode each half before base64ing `id:secret`.
    const basic = Buffer.from(
      `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
      'utf-8'
    ).toString('base64');
    headers['Authorization'] = `Basic ${basic}`;
  }

  let res: Response;
  try {
    res = await fetch(auth.tokenUrl, {
      method: 'POST',
      headers,
      body: form.toString(),
      // Never chase a redirect from the token endpoint: a 3xx to another host
      // would replay the client credentials somewhere we never configured.
      redirect: 'manual',
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: `OAuth2 token request failed: ${String(err)}` };
  }

  const { text, tooLarge } = await readLimitedText(res, MAX_TOKEN_RESPONSE_BYTES);
  if (tooLarge) {
    return {
      ok: false,
      error: `OAuth2 token response exceeded ${MAX_TOKEN_RESPONSE_BYTES} bytes`,
    };
  }

  let parsed: unknown;
  let parseFailed = false;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parseFailed = true;
  }

  if (res.status < 200 || res.status >= 300) {
    return { ok: false, error: describeTokenError(res.status, parseFailed ? undefined : parsed) };
  }
  if (parseFailed || parsed === null || typeof parsed !== 'object') {
    return { ok: false, error: 'OAuth2 token response was not a JSON object' };
  }

  const body = parsed as Record<string, unknown>;
  const accessToken = body['access_token'];
  if (typeof accessToken !== 'string' || accessToken === '') {
    return { ok: false, error: 'OAuth2 token response missing "access_token"' };
  }
  if (!HEADER_SAFE_VALUE_RE.test(accessToken)) {
    return { ok: false, error: 'OAuth2 access_token contains characters that are not header-safe' };
  }

  const refreshToken = body['refresh_token'];

  return {
    ok: true,
    token: {
      accessToken,
      tokenType: normalizeTokenType(body['token_type']),
      expiresAt: computeExpiresAt(body['expires_in'], Date.now()),
      ...(typeof refreshToken === 'string' && refreshToken !== '' && { refreshToken }),
    },
  };
}

/**
 * Obtain an access token for a role.
 *
 * Grant selection (kept deliberately simple):
 * - Normally issues the configured grant (`client_credentials`).
 * - When the previous token response carried a `refresh_token` and one is passed
 *   in, a `refresh_token` grant is tried first; if it fails for any reason we
 *   fall back to a fresh `client_credentials` request, so a rejected/rotated
 *   refresh token can never wedge the role.
 */
export async function fetchOAuth2Token(
  auth: OAuth2Config,
  credentials: Record<string, string>,
  opts: { refreshToken?: string } = {}
): Promise<OAuth2Result> {
  if (opts.refreshToken) {
    const refreshed = await requestToken(auth, credentials, {
      grantType: 'refresh_token',
      refreshToken: opts.refreshToken,
    });
    if (refreshed.ok) return refreshed;
    // Fall through to a fresh client-credentials request.
  }
  return requestToken(auth, credentials, { grantType: auth.grantType ?? 'client_credentials' });
}
