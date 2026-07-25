import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  fetchOAuth2Token,
  oauth2AuthorizationHeader,
  isInsecureTokenUrl,
  missingOAuth2CredentialKeys,
  resolveOAuth2CredentialKeys,
} from './oauth2.js';
import { RoleMutex, isSessionExpired } from './role-mutex.js';
import { shouldAutoRelogin } from './refresh-policy.js';
import { executeCall } from '../server/call.js';
import { log } from '../log.js';
import type { AuthConfig, RoleSession, ToolMeta } from '../types.js';

// ─── Throwaway authorization server + resource server ────────────────────────
// Both bind 127.0.0.1:0 (no fixed ports, no path assumptions) so the suite runs
// identically on Linux and Windows CI.

type AsRequest = { headers: http.IncomingHttpHeaders; form: URLSearchParams; raw: string; method?: string; url?: string };
type AsReply = { status: number; contentType?: string; body: string; delayMs?: number };

let asServer: http.Server;
let apiServer: http.Server;
let tokenUrl: string;
let apiBaseUrl: string;

let asRequests: AsRequest[] = [];
let asHandler: (req: AsRequest) => AsReply;

let apiRequests: Array<{ authorization?: string }> = [];
let apiHandler: () => { status: number; headers?: Record<string, string>; body: string };

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

beforeAll(async () => {
  asServer = http.createServer((req, res) => {
    void readBody(req).then((raw) => {
      const entry: AsRequest = {
        headers: req.headers,
        form: new URLSearchParams(raw),
        raw,
        method: req.method,
        url: req.url,
      };
      asRequests.push(entry);
      const reply = asHandler(entry);
      const send = () => {
        res.writeHead(reply.status, { 'content-type': reply.contentType ?? 'application/json' });
        res.end(reply.body);
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => asServer.listen(0, '127.0.0.1', resolve));
  tokenUrl = `http://127.0.0.1:${(asServer.address() as AddressInfo).port}/oauth2/token`;

  apiServer = http.createServer((req, res) => {
    void readBody(req).then(() => {
      apiRequests.push({ authorization: req.headers.authorization });
      const reply = apiHandler();
      res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  apiBaseUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => asServer.close(() => resolve()));
  await new Promise<void>((resolve) => apiServer.close(() => resolve()));
});

/** Default: a well-formed one-hour token response. */
function okToken(extra: Record<string, unknown> = {}): AsReply {
  return {
    status: 200,
    body: JSON.stringify({ access_token: 'access-1', token_type: 'Bearer', expires_in: 3600, ...extra }),
  };
}

beforeEach(() => {
  asRequests = [];
  apiRequests = [];
  asHandler = () => okToken();
  apiHandler = () => ({ status: 200, body: JSON.stringify({ ok: true }) });
});

function auth(overrides: Partial<Extract<AuthConfig, { kind: 'oauth2' }>> = {}): Extract<AuthConfig, { kind: 'oauth2' }> {
  return { kind: 'oauth2', tokenUrl, ...overrides };
}

const CREDS = { client_id: 'svc-client', client_secret: 'svc-secret' };

// ─── Token request ───────────────────────────────────────────────────────────

describe('fetchOAuth2Token — successful client-credentials fetch', () => {
  it('POSTs a form-urlencoded client_credentials grant and returns the access token', async () => {
    const result = await fetchOAuth2Token(auth(), CREDS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token.accessToken).toBe('access-1');
    expect(result.token.tokenType).toBe('Bearer');

    const req = asRequests[0]!;
    expect(req.method).toBe('POST');
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(req.form.get('grant_type')).toBe('client_credentials');
    // Secrets must never ride in the URL / query string.
    expect(req.url).toBe('/oauth2/token');
  });

  it('normalizes a lowercase token_type and honors a non-Bearer one', async () => {
    asHandler = () => okToken({ token_type: 'bearer' });
    const lower = await fetchOAuth2Token(auth(), CREDS);
    expect(lower.ok && lower.token.tokenType).toBe('Bearer');

    asHandler = () => okToken({ token_type: 'DPoP' });
    const dpop = await fetchOAuth2Token(auth(), CREDS);
    expect(dpop.ok && dpop.token.tokenType).toBe('DPoP');
  });

  it('resolves credentials through $env: indirection', async () => {
    process.env['SURFACEMCP_TEST_CLIENT_SECRET'] = 'env-secret';
    try {
      const result = await fetchOAuth2Token(auth(), {
        client_id: 'svc-client',
        client_secret: '$env:SURFACEMCP_TEST_CLIENT_SECRET',
      });
      expect(result.ok).toBe(true);
      const basic = String(asRequests[0]!.headers.authorization).replace(/^Basic /, '');
      expect(Buffer.from(basic, 'base64').toString()).toBe('svc-client:env-secret');
    } finally {
      delete process.env['SURFACEMCP_TEST_CLIENT_SECRET'];
    }
  });

  it('accepts camelCase credential keys', async () => {
    const result = await fetchOAuth2Token(auth(), { clientId: 'a', clientSecret: 'b' });
    expect(result.ok).toBe(true);
    expect(resolveOAuth2CredentialKeys({ clientId: 'a', clientSecret: 'b' })).toEqual({
      client_id: 'clientId',
      client_secret: 'clientSecret',
    });
  });
});

describe('fetchOAuth2Token — client authentication style', () => {
  it('basic (default): sends HTTP Basic and keeps the secret out of the body', async () => {
    await fetchOAuth2Token(auth(), CREDS);
    const req = asRequests[0]!;
    const basic = String(req.headers.authorization).replace(/^Basic /, '');
    expect(Buffer.from(basic, 'base64').toString()).toBe('svc-client:svc-secret');
    expect(req.form.get('client_secret')).toBeNull();
    expect(req.form.get('client_id')).toBeNull();
  });

  it('basic: form-urlencodes each half before base64 (RFC 6749 §2.3.1)', async () => {
    await fetchOAuth2Token(auth(), { client_id: 'a b', client_secret: 'p:w@rd' });
    const basic = String(asRequests[0]!.headers.authorization).replace(/^Basic /, '');
    expect(Buffer.from(basic, 'base64').toString()).toBe('a%20b:p%3Aw%40rd');
  });

  it('body: sends client_id/client_secret as form fields and no Authorization header', async () => {
    await fetchOAuth2Token(auth({ clientAuth: 'body' }), CREDS);
    const req = asRequests[0]!;
    expect(req.headers.authorization).toBeUndefined();
    expect(req.form.get('client_id')).toBe('svc-client');
    expect(req.form.get('client_secret')).toBe('svc-secret');
  });
});

describe('fetchOAuth2Token — scope and audience passthrough', () => {
  it('sends scope and audience when configured', async () => {
    await fetchOAuth2Token(auth({ scope: 'read:things write:things', audience: 'https://api.example.com' }), CREDS);
    const req = asRequests[0]!;
    expect(req.form.get('scope')).toBe('read:things write:things');
    expect(req.form.get('audience')).toBe('https://api.example.com');
  });

  it('omits scope and audience when unset', async () => {
    await fetchOAuth2Token(auth(), CREDS);
    expect(asRequests[0]!.form.has('scope')).toBe(false);
    expect(asRequests[0]!.form.has('audience')).toBe(false);
  });
});

describe('fetchOAuth2Token — failure handling', () => {
  it('non-2xx: reports the status and echoes only an RFC 6749 error code', async () => {
    asHandler = () => ({
      status: 401,
      body: JSON.stringify({ error: 'invalid_client', error_description: 'secret svc-secret rejected' }),
    });
    const result = await fetchOAuth2Token(auth(), CREDS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('status 401');
    expect(result.error).toContain('invalid_client');
    // The response body (which may quote credentials) is never echoed.
    expect(result.error).not.toContain('svc-secret');
    expect(result.error).not.toContain('error_description');
  });

  it('non-2xx with an unusual error field: no echo at all', async () => {
    asHandler = () => ({ status: 500, body: JSON.stringify({ error: '<html>svc-secret</html>' }) });
    const result = await fetchOAuth2Token(auth(), CREDS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('OAuth2 token request failed: status 500');
  });

  it('malformed JSON: clear error, no body echo', async () => {
    asHandler = () => ({ status: 200, body: 'not json at all — svc-secret' });
    const result = await fetchOAuth2Token(auth(), CREDS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('OAuth2 token response was not a JSON object');
    expect(result.error).not.toContain('svc-secret');
  });

  it('missing access_token: clear error', async () => {
    asHandler = () => ({ status: 200, body: JSON.stringify({ token_type: 'Bearer', expires_in: 60 }) });
    const result = await fetchOAuth2Token(auth(), CREDS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('OAuth2 token response missing "access_token"');
  });

  it('rejects an access_token that is not header-safe (CRLF injection guard)', async () => {
    asHandler = () => ({ status: 200, body: JSON.stringify({ access_token: 'abc\r\nX-Evil: 1', token_type: 'Bearer' }) });
    const result = await fetchOAuth2Token(auth(), CREDS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('header-safe');
  });

  it('falls back to Bearer when token_type is not a valid HTTP token', async () => {
    asHandler = () => okToken({ token_type: 'Bearer\r\nX-Evil: 1' });
    const result = await fetchOAuth2Token(auth(), CREDS);
    expect(result.ok && result.token.tokenType).toBe('Bearer');
  });

  it('refuses an oversized token response instead of buffering it', async () => {
    asHandler = () => ({ status: 200, body: 'x'.repeat(70 * 1024) });
    const result = await fetchOAuth2Token(auth(), CREDS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('exceeded');
  });

  it('missing client_id / client_secret: fails before any request is issued', async () => {
    const noId = await fetchOAuth2Token(auth(), { client_secret: 'x' });
    expect(noId.ok).toBe(false);
    if (!noId.ok) expect(noId.error).toContain('client_id');

    const noSecret = await fetchOAuth2Token(auth(), { client_id: 'x' });
    expect(noSecret.ok).toBe(false);
    if (!noSecret.ok) expect(noSecret.error).toContain('client_secret');

    expect(asRequests).toHaveLength(0);
  });

  it('unreachable token endpoint: error mentions the failure, not the credentials', async () => {
    const result = await fetchOAuth2Token(auth({ tokenUrl: 'http://127.0.0.1:1/token' }), CREDS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('OAuth2 token request failed');
    expect(result.error).not.toContain('svc-secret');
  });
});

// ─── Expiry ──────────────────────────────────────────────────────────────────

describe('fetchOAuth2Token — expiry computation', () => {
  it('subtracts a 30s safety skew from expires_in', async () => {
    const before = Date.now();
    const result = await fetchOAuth2Token(auth(), CREDS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = before + 3600_000 - 30_000;
    expect(result.token.expiresAt).toBeGreaterThanOrEqual(expected);
    expect(result.token.expiresAt!).toBeLessThan(expected + 5_000);
  });

  it('caps the skew at half the lifetime for short-lived tokens', async () => {
    asHandler = () => okToken({ expires_in: 10 });
    const before = Date.now();
    const result = await fetchOAuth2Token(auth(), CREDS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 10s lifetime, skew capped at 5s → ~5s from now (never in the past).
    expect(result.token.expiresAt).toBeGreaterThanOrEqual(before + 5_000);
    expect(result.token.expiresAt!).toBeLessThan(before + 10_000);
  });

  it('accepts a numeric-string expires_in', async () => {
    asHandler = () => okToken({ expires_in: '3600' });
    const result = await fetchOAuth2Token(auth(), CREDS);
    expect(result.ok && typeof result.token.expiresAt).toBe('number');
  });

  it('leaves expiresAt undefined when expires_in is absent or unusable', async () => {
    asHandler = () => ({ status: 200, body: JSON.stringify({ access_token: 'a', token_type: 'Bearer' }) });
    const none = await fetchOAuth2Token(auth(), CREDS);
    expect(none.ok && none.token.expiresAt).toBeUndefined();

    asHandler = () => okToken({ expires_in: 'soon' });
    const bad = await fetchOAuth2Token(auth(), CREDS);
    expect(bad.ok && bad.token.expiresAt).toBeUndefined();
  });
});

describe('isSessionExpired', () => {
  const base: RoleSession = { cookies: [], cachedAt: 'now', refreshCount: 1 };

  it('is false for a session without an expiry (every non-oauth2 kind)', () => {
    expect(isSessionExpired(base)).toBe(false);
  });

  it('is true once the expiry has passed', () => {
    expect(isSessionExpired({ ...base, expiresAt: Date.now() - 1 })).toBe(true);
    expect(isSessionExpired({ ...base, expiresAt: Date.now() + 60_000 })).toBe(false);
  });
});

// ─── RoleMutex integration ───────────────────────────────────────────────────

const OAUTH_ROLE = [{ name: 'service', credentials: CREDS }];

describe('RoleMutex — oauth2 sessions', () => {
  it('stores the token, token_type and expiry on the session', async () => {
    const mutex = new RoleMutex(apiBaseUrl, auth(), OAUTH_ROLE);
    const session = await mutex.ensureSession('service');
    expect(session.token).toBe('access-1');
    expect(session.tokenType).toBe('Bearer');
    expect(session.expiresAt).toBeGreaterThan(Date.now());
    expect(asRequests).toHaveLength(1);
  });

  it('reuses a live token instead of re-minting', async () => {
    const mutex = new RoleMutex(apiBaseUrl, auth(), OAUTH_ROLE);
    const first = await mutex.ensureSession('service');
    const second = await mutex.ensureSession('service');
    expect(second).toBe(first);
    expect(asRequests).toHaveLength(1);
  });

  it('proactively re-authenticates an expired token without waiting for a 401', async () => {
    let n = 0;
    // expires_in: 0 → the token is stale the moment it is stored.
    asHandler = () => okToken({ access_token: `access-${++n}`, expires_in: 0 });
    const mutex = new RoleMutex(apiBaseUrl, auth(), OAUTH_ROLE);

    const first = await mutex.ensureSession('service');
    expect(first.token).toBe('access-1');
    const second = await mutex.ensureSession('service');
    expect(second.token).toBe('access-2');
    expect(asRequests).toHaveLength(2);
    expect(second.refreshCount).toBe(2);
  });

  it('does not re-authenticate a session with no known expiry', async () => {
    asHandler = () => ({ status: 200, body: JSON.stringify({ access_token: 'a', token_type: 'Bearer' }) });
    const mutex = new RoleMutex(apiBaseUrl, auth(), OAUTH_ROLE);
    await mutex.ensureSession('service');
    await mutex.ensureSession('service');
    expect(asRequests).toHaveLength(1);
  });

  it('serializes concurrent refreshes onto one token request (no thundering herd)', async () => {
    asHandler = () => ({ ...okToken(), delayMs: 40 });
    const mutex = new RoleMutex(apiBaseUrl, auth(), OAUTH_ROLE);

    const sessions = await Promise.all(Array.from({ length: 50 }, () => mutex.ensureSession('service')));
    expect(asRequests).toHaveLength(1);
    for (const s of sessions) expect(s.token).toBe('access-1');
    expect(new Set(sessions).size).toBe(1);
  });

  it('serializes a concurrent stampede on an EXPIRED session too', async () => {
    let n = 0;
    asHandler = () => ({ ...okToken({ access_token: `access-${++n}`, expires_in: 0 }), delayMs: 40 });
    const mutex = new RoleMutex(apiBaseUrl, auth(), OAUTH_ROLE);
    await mutex.ensureSession('service'); // 1 request; already expired
    expect(asRequests).toHaveLength(1);

    const sessions = await Promise.all(Array.from({ length: 50 }, () => mutex.ensureSession('service')));
    // All 50 collapse onto a single re-authentication.
    expect(asRequests).toHaveLength(2);
    for (const s of sessions) expect(s.token).toBe('access-2');
  });

  it('surfaces a token-request failure as a login error without leaking the secret', async () => {
    asHandler = () => ({ status: 403, body: JSON.stringify({ error: 'unauthorized_client' }) });
    const mutex = new RoleMutex(apiBaseUrl, auth(), OAUTH_ROLE);
    await expect(mutex.ensureSession('service')).rejects.toThrow('status 403');
    await expect(mutex.ensureSession('service')).rejects.not.toThrow('svc-secret');
  });

  it('anonymous (credential-less) roles stay unauthenticated under oauth2', async () => {
    const mutex = new RoleMutex(apiBaseUrl, auth(), []);
    const session = await mutex.refresh('anonymous');
    expect(session.token).toBeUndefined();
    expect(asRequests).toHaveLength(0);
  });
});

describe('RoleMutex — refresh_token grant', () => {
  it('uses a returned refresh_token on the next re-authentication', async () => {
    let n = 0;
    asHandler = (req) => {
      if (req.form.get('grant_type') === 'refresh_token') {
        expect(req.form.get('refresh_token')).toBe('refresh-1');
        return okToken({ access_token: 'access-refreshed', expires_in: 3600 });
      }
      return okToken({ access_token: `access-${++n}`, expires_in: 0, refresh_token: 'refresh-1' });
    };

    const mutex = new RoleMutex(apiBaseUrl, auth(), OAUTH_ROLE);
    const first = await mutex.ensureSession('service');
    expect(first.refreshToken).toBe('refresh-1');

    const second = await mutex.ensureSession('service');
    expect(second.token).toBe('access-refreshed');
    expect(asRequests[1]!.form.get('grant_type')).toBe('refresh_token');
  });

  it('falls back to client_credentials when the refresh grant is rejected', async () => {
    asHandler = (req) => {
      if (req.form.get('grant_type') === 'refresh_token') {
        return { status: 400, body: JSON.stringify({ error: 'invalid_grant' }) };
      }
      return okToken({ access_token: 'access-fresh', expires_in: 0, refresh_token: 'refresh-1' });
    };

    const mutex = new RoleMutex(apiBaseUrl, auth(), OAUTH_ROLE);
    await mutex.ensureSession('service');
    const second = await mutex.ensureSession('service');
    expect(second.token).toBe('access-fresh');
    // rejected refresh grant, then a fresh client-credentials request
    expect(asRequests.map((r) => r.form.get('grant_type'))).toEqual([
      'client_credentials',
      'refresh_token',
      'client_credentials',
    ]);
  });
});

// ─── Outbound header + reactive refresh via executeCall ──────────────────────

function tool(method: string, path: string): ToolMeta {
  return {
    name: 't', bareName: 't', surface: 's', toolId: 'deadbeef', method, path,
    inputSchema: { type: 'object' }, inputSchemaConfidence: 'unknown',
    sideEffectClass: method === 'GET' ? 'safe' : 'mutating',
    sourceFile: 'x', sourceLine: 1, isServerAction: false,
  };
}

describe('oauth2AuthorizationHeader', () => {
  it('emits a Bearer header by default and respects a non-Bearer token_type', () => {
    expect(oauth2AuthorizationHeader('tok')).toBe('Bearer tok');
    expect(oauth2AuthorizationHeader('tok', 'bearer')).toBe('Bearer tok');
    expect(oauth2AuthorizationHeader('tok', 'DPoP')).toBe('DPoP tok');
    expect(oauth2AuthorizationHeader('tok', 'not a token')).toBe('Bearer tok');
  });
});

describe('executeCall — oauth2', () => {
  it('sends Authorization: Bearer <access token> on the outbound call', async () => {
    const mutex = new RoleMutex(apiBaseUrl, auth(), OAUTH_ROLE);
    const result = await executeCall({
      tool: tool('GET', '/things'), role: 'service', input: {}, baseUrl: apiBaseUrl,
      projectName: 'test', auth: auth(), roleMutex: mutex, revision: 1, currentRevision: 1,
    });
    expect(result.ok).toBe(true);
    expect(apiRequests[0]!.authorization).toBe('Bearer access-1');
  });

  it('reactively re-authenticates on a 401 bearer challenge and retries', async () => {
    let n = 0;
    asHandler = () => okToken({ access_token: `access-${++n}` });
    let apiCalls = 0;
    apiHandler = () =>
      ++apiCalls === 1
        ? { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' }, body: '{}' }
        : { status: 200, body: JSON.stringify({ ok: true }) };

    const mutex = new RoleMutex(apiBaseUrl, auth(), OAUTH_ROLE);
    const result = await executeCall({
      tool: tool('GET', '/things'), role: 'service', input: {}, baseUrl: apiBaseUrl,
      projectName: 'test', auth: auth(), roleMutex: mutex, revision: 1, currentRevision: 1,
    });

    expect(result.ok).toBe(true);
    expect(apiRequests.map((r) => r.authorization)).toEqual(['Bearer access-1', 'Bearer access-2']);
  });
});

describe('shouldAutoRelogin — oauth2 opt-in signals', () => {
  it('triggers on a 401 Bearer challenge only when authKind is oauth2', () => {
    const headers = { 'www-authenticate': 'Bearer realm="api"' };
    expect(shouldAutoRelogin(401, headers, null, 'session', 'oauth2')).toBe(true);
    // The five pre-existing kinds are unchanged: a bare Bearer challenge is not a signal.
    expect(shouldAutoRelogin(401, headers, null, 'session', 'form')).toBe(false);
    expect(shouldAutoRelogin(401, headers, null, 'session')).toBe(false);
  });

  it('triggers on expired_token for oauth2', () => {
    const headers = { 'www-authenticate': 'Bearer error="expired_token"' };
    expect(shouldAutoRelogin(401, headers, null, 'session', 'oauth2')).toBe(true);
  });

  it('does NOT trigger on 403 insufficient_scope (re-minting the token cannot help)', () => {
    const headers = { 'www-authenticate': 'Bearer error="insufficient_scope"' };
    expect(shouldAutoRelogin(403, headers, null, 'session', 'oauth2')).toBe(false);
  });

  it('leaves the shared signals working for oauth2', () => {
    expect(shouldAutoRelogin(401, { 'www-authenticate': 'Bearer error="invalid_token"' }, null, 'session', 'oauth2')).toBe(true);
    expect(shouldAutoRelogin(200, {}, null, 'session', 'oauth2')).toBe(false);
    expect(shouldAutoRelogin(400, {}, null, 'session', 'oauth2')).toBe(false);
  });
});

// ─── Secret hygiene ──────────────────────────────────────────────────────────

describe('oauth2 secret hygiene', () => {
  it('never writes the client secret, access token or refresh token to the log', async () => {
    const SECRET = 'CLIENT-SECRET-MUST-NOT-BE-LOGGED';
    const ACCESS = 'ACCESS-TOKEN-MUST-NOT-BE-LOGGED';
    const REFRESH = 'REFRESH-TOKEN-MUST-NOT-BE-LOGGED';
    asHandler = () => okToken({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 0 });

    const captured: unknown[] = [];
    const spies = (['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const).map((level) =>
      vi.spyOn(log, level).mockImplementation(((...args: unknown[]) => {
        captured.push(args);
      }) as never)
    );

    try {
      const mutex = new RoleMutex(apiBaseUrl, auth(), [{ name: 'service', credentials: { client_id: 'id', client_secret: SECRET } }]);
      // Several cycles: initial login, proactive expiry refresh, refresh-token grant.
      await mutex.ensureSession('service');
      await mutex.ensureSession('service');
      await mutex.ensureSession('service');
      await executeCall({
        tool: tool('GET', '/things'), role: 'service', input: {}, baseUrl: apiBaseUrl,
        projectName: 'test', auth: auth(), roleMutex: mutex, revision: 1, currentRevision: 1,
      });
    } finally {
      for (const s of spies) s.mockRestore();
    }

    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(ACCESS);
    expect(serialized).not.toContain(REFRESH);
    // Sanity: the flow did log something (role-scoped refresh lines).
    expect(captured.length).toBeGreaterThan(0);
  });
});

// ─── doctor helpers ──────────────────────────────────────────────────────────

describe('isInsecureTokenUrl', () => {
  it('accepts https and loopback http, flags everything else', () => {
    expect(isInsecureTokenUrl('https://auth.example.com/token')).toBe(false);
    expect(isInsecureTokenUrl('http://localhost:8080/token')).toBe(false);
    expect(isInsecureTokenUrl('http://127.0.0.1:8080/token')).toBe(false);
    expect(isInsecureTokenUrl('http://[::1]:8080/token')).toBe(false);
    expect(isInsecureTokenUrl('http://auth.example.com/token')).toBe(true);
    expect(isInsecureTokenUrl('not a url')).toBe(true);
  });
});

describe('missingOAuth2CredentialKeys', () => {
  it('reports canonical key names only', () => {
    expect(missingOAuth2CredentialKeys(CREDS)).toEqual([]);
    expect(missingOAuth2CredentialKeys({ clientId: 'a', clientSecret: 'b' })).toEqual([]);
    expect(missingOAuth2CredentialKeys({ client_id: 'a' })).toEqual(['client_secret']);
    expect(missingOAuth2CredentialKeys({})).toEqual(['client_id', 'client_secret']);
  });

  it('treats an unresolved $env: reference as missing', () => {
    delete process.env['SURFACEMCP_ABSENT_VAR_98765'];
    expect(
      missingOAuth2CredentialKeys({ client_id: 'a', client_secret: '$env:SURFACEMCP_ABSENT_VAR_98765' })
    ).toEqual(['client_secret']);
  });
});
