import type { RoleSession, AuthConfig, RoleConfig } from '../types.js';
import { loginForm } from './form.js';
import { loginNextAuth } from './nextauth.js';
import { getBearer } from './bearer.js';
import { resolveCredentials } from '../env/indirection.js';
import { log } from '../log.js';

type LoginFn = () => Promise<RoleSession>;

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

  async ensureSession(roleName: string): Promise<RoleSession> {
    const existing = this.sessions.get(roleName);
    if (existing) return existing;
    return this.refresh(roleName);
  }

  async refresh(roleName: string): Promise<RoleSession> {
    // If already refreshing, queue on the same promise
    const existing = this.inflight.get(roleName);
    if (existing) return existing;

    const role = this.roles.find((r) => r.name === roleName);
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
    }

    return {
      cookies,
      token,
      cachedAt: now,
      lastRefreshAt: existing ? now : undefined,
      refreshCount,
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
