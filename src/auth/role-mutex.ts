import type { RoleSession, AuthConfig, RoleConfig } from '../types.js';
import { loginForm } from './form.js';
import { loginNextAuth } from './nextauth.js';
import { getBearer } from './bearer.js';
import { fetchOAuth2Token } from './oauth2.js';
import { resolveCredentials } from '../env/indirection.js';
import { log } from '../log.js';

type LoginFn = () => Promise<RoleSession>;

/**
 * The canonical anonymous role. A built-in: it need not be declared in
 * surfacemcp.config.json roles[]. Requests made as this role go unauthenticated,
 * so the public surface can always be exercised (BugHunter's no-login default).
 */
const ANONYMOUS_ROLE_NAME = 'anonymous';

/**
 * True when a session carries a known expiry that has passed. Only OAuth2
 * sessions set `expiresAt`, so every other auth kind is unaffected (a session
 * without an expiry is never considered stale — those kinds rely on the
 * reactive 401 path, exactly as before).
 */
export function isSessionExpired(session: RoleSession, now = Date.now()): boolean {
  return session.expiresAt !== undefined && now >= session.expiresAt;
}

/**
 * Per-role mutex: ensures only one login is in-flight at a time per role.
 * Concurrent callers that arrive during a refresh queue and reuse the result.
 */
export class RoleMutex {
  private sessions = new Map<string, RoleSession>();
  private inflight = new Map<string, Promise<RoleSession>>();
  private baseUrl: string;
  private auth: AuthConfig;
  private roles: RoleConfig[];

  constructor(baseUrl: string, auth: AuthConfig, roles: RoleConfig[]) {
    this.baseUrl = baseUrl;
    this.auth = auth;
    this.roles = roles;
  }

  getSession(roleName: string): RoleSession | undefined {
    return this.sessions.get(roleName);
  }

  /**
   * Return the cached session for a role, minting one if absent — or replacing
   * it when it carries an expiry that has passed (OAuth2). The expired case goes
   * through `refresh()`, so concurrent callers still collapse onto a single
   * in-flight token request rather than stampeding the authorization server.
   */
  async ensureSession(roleName: string): Promise<RoleSession> {
    const existing = this.sessions.get(roleName);
    if (existing && !isSessionExpired(existing)) return existing;
    // One line per actual re-authentication, not one per queued caller.
    if (existing && !this.inflight.has(roleName)) {
      log.info({ role: roleName }, 'session expired — re-authenticating proactively');
    }
    return this.refresh(roleName);
  }

  async refresh(roleName: string): Promise<RoleSession> {
    // If already refreshing, queue on the same promise
    const existing = this.inflight.get(roleName);
    if (existing) return existing;

    let role = this.roles.find((r) => r.name === roleName);
    // 'anonymous' is a built-in credential-less role — synthesize it when the
    // config declares no matching role, so doLogin() returns an unauthenticated
    // session instead of throwing "Unknown role: anonymous".
    if (!role && roleName === ANONYMOUS_ROLE_NAME) {
      role = { name: ANONYMOUS_ROLE_NAME };
    }
    if (!role) throw new Error(`Unknown role: ${roleName}`);

    const promise = this.doLogin(role);
    this.inflight.set(roleName, promise);

    try {
      const session = await promise;
      this.sessions.set(roleName, session);
      return session;
    } finally {
      this.inflight.delete(roleName);
    }
  }

  private async doLogin(role: RoleConfig): Promise<RoleSession> {
    const now = new Date().toISOString();
    const existing = this.sessions.get(role.name);
    const refreshCount = (existing?.refreshCount ?? 0) + 1;

    if (refreshCount > 1) {
      log.info({ role: role.name, refreshCount }, 'refreshing session');
      if (refreshCount > 10) {
        log.warn({ role: role.name, refreshCount }, 'high refresh count — possible auth loop');
      }
    }

    let cookies: string[] = [];
    let token: string | undefined;
    let tokenType: string | undefined;
    let expiresAt: number | undefined;
    let refreshToken: string | undefined;

    // Anonymous role: no credentials configured. Skip login regardless of auth.kind;
    // requests go unauthenticated so we can exercise the public surface as the role.
    if (!role.credentials || Object.keys(role.credentials).length === 0) {
      return {
        cookies: [],
        token: undefined,
        cachedAt: new Date().toISOString(),
        refreshCount,
      };
    }

    switch (this.auth.kind) {
      case 'none':
        break;

      case 'form': {
        const result = await loginForm(this.baseUrl, this.auth, role.credentials);
        if (!result.ok) throw new Error(result.error ?? 'Form login failed');
        cookies = result.cookies;
        break;
      }

      case 'nextauth': {
        const result = await loginNextAuth(this.baseUrl, this.auth, role.credentials);
        if (!result.ok) throw new Error(result.error ?? 'NextAuth login failed');
        cookies = result.cookies;
        break;
      }

      case 'bearer': {
        const result = getBearer(resolveCredentials(role.credentials));
        if (!result.ok) throw new Error(result.error ?? 'Bearer token missing');
        token = result.token;
        break;
      }

      case 'api_key':
        // No login step; api key is sent per-request
        break;

      case 'oauth2': {
        // Reuse a refresh token from the session being replaced, when the AS
        // issued one; fetchOAuth2Token falls back to client_credentials if the
        // refresh grant is rejected. Nothing here is ever logged.
        const result = await fetchOAuth2Token(this.auth, role.credentials, {
          ...(existing?.refreshToken !== undefined && { refreshToken: existing.refreshToken }),
        });
        if (!result.ok) throw new Error(result.error);
        token = result.token.accessToken;
        tokenType = result.token.tokenType;
        expiresAt = result.token.expiresAt;
        refreshToken = result.token.refreshToken;
        break;
      }
    }

    return {
      cookies,
      token,
      cachedAt: now,
      lastRefreshAt: existing ? now : undefined,
      refreshCount,
      ...(tokenType !== undefined && { tokenType }),
      ...(expiresAt !== undefined && { expiresAt }),
      ...(refreshToken !== undefined && { refreshToken }),
    };
  }

  async loginAll(): Promise<Map<string, { ok: boolean; error?: string }>> {
    const results = new Map<string, { ok: boolean; error?: string }>();
    for (const role of this.roles) {
      try {
        await this.refresh(role.name);
        results.set(role.name, { ok: true });
      } catch (err) {
        results.set(role.name, { ok: false, error: String(err) });
      }
    }
    return results;
  }
}
