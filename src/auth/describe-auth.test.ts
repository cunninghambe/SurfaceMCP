import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildDescribeAuth } from './describe-auth.js';
import type { AuthConfig, RoleConfig } from '../types.js';
import { loadConfig } from '../config.js';
import { writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const formAuth: AuthConfig = {
  kind: 'form',
  loginMethod: 'POST',
  loginPath: '/auth/login',
  loginFields: { email: 'email', password: 'password' },
  bodyFormat: 'json',
  successCheck: { kind: 'cookie', name: 'session' },
};

const nextauthAuth: AuthConfig = {
  kind: 'nextauth',
  // nextauth orientation: postFieldName -> credentialKey
  fields: { username: 'email', password: 'password' },
};

const ownerRole: RoleConfig = {
  name: 'owner',
  credentials: { email: 'test@example.com', password: 'secret' },
};

const anonymousRole: RoleConfig = { name: 'anon' };

describe('buildDescribeAuth', () => {
  it('form auth — redacts values by default (names + shapes only)', () => {
    const result = buildDescribeAuth(formAuth, ownerRole);
    expect(result.authKind).toBe('form');
    if (result.authKind !== 'form') return;
    expect(result.uiLoginPath).toBe('/auth/login');
    expect(result.fields).toEqual({ email: 'email', password: 'password' });
    // Redacted by default: no plaintext values, shape metadata instead.
    expect(result.redacted).toBe(true);
    expect(result.values).toBeUndefined();
    expect(result.valueMeta).toEqual({
      email: { present: true, length: 'test@example.com'.length, source: 'literal' },
      password: { present: true, length: 'secret'.length, source: 'literal' },
    });
    expect(result.successCheck).toEqual({ kind: 'cookie', name: 'session' });
    expect(result.cookieName).toBe('session');
  });

  it('form auth with revealSecrets — returns resolved values keyed by post field name', () => {
    const result = buildDescribeAuth(formAuth, ownerRole, true);
    expect(result.authKind).toBe('form');
    if (result.authKind !== 'form') return;
    expect(result.redacted).toBe(false);
    expect(result.fields).toEqual({ email: 'email', password: 'password' });
    expect(result.values).toEqual({ email: 'test@example.com', password: 'secret' });
  });

  it('form auth with uiLoginFields + revealSecrets — returns values keyed by domFieldName', () => {
    const auth: AuthConfig = {
      ...formAuth,
      uiLoginPath: '/',
      uiLoginFields: { email: 'identifier', password: 'password' },
      uiTriggerSelector: 'button:has-text("Sign in")',
    };
    const result = buildDescribeAuth(auth, ownerRole, true);
    expect(result.authKind).toBe('form');
    if (result.authKind !== 'form') return;
    expect(result.uiLoginPath).toBe('/');
    expect(result.uiTriggerSelector).toBe('button:has-text("Sign in")');
    expect(result.fields).toEqual({ email: 'identifier', password: 'password' });
    expect(result.values).toEqual({ identifier: 'test@example.com', password: 'secret' });
    expect(result.redacted).toBe(false);
  });

  it('form auth with uiTriggerSelector — passed through in result', () => {
    const auth: AuthConfig = { ...formAuth, uiTriggerSelector: '#sign-in-btn' };
    const result = buildDescribeAuth(auth, ownerRole);
    expect(result.authKind).toBe('form');
    if (result.authKind !== 'form') return;
    expect(result.uiTriggerSelector).toBe('#sign-in-btn');
  });

  it('form auth with non-cookie successCheck — cookieName is absent', () => {
    const auth: AuthConfig = { ...formAuth, successCheck: { kind: 'redirect', to: '/dashboard' } };
    const result = buildDescribeAuth(auth, ownerRole);
    expect(result.authKind).toBe('form');
    if (result.authKind !== 'form') return;
    expect(result.successCheck).toEqual({ kind: 'redirect', to: '/dashboard' });
    expect(result.cookieName).toBeUndefined();
  });

  it('nextauth without uiLoginFields + revealSecrets — inverts auth.fields correctly', () => {
    const result = buildDescribeAuth(nextauthAuth, ownerRole, true);
    expect(result.authKind).toBe('nextauth');
    if (result.authKind !== 'nextauth') return;
    expect(result.uiLoginPath).toBe('/api/auth/signin');
    // auth.fields = { username: 'email', password: 'password' }
    // inverted: { email: 'username', password: 'password' }
    expect(result.fields).toEqual({ email: 'username', password: 'password' });
    expect(result.values).toEqual({ username: 'test@example.com', password: 'secret' });
    expect(result.successCheck).toEqual({ kind: 'cookie', name: 'authjs.session-token' });
    expect(result.cookieName).toBe('authjs.session-token');
  });

  it('nextauth — redacts values by default with valueMeta', () => {
    const result = buildDescribeAuth(nextauthAuth, ownerRole);
    expect(result.authKind).toBe('nextauth');
    if (result.authKind !== 'nextauth') return;
    expect(result.redacted).toBe(true);
    expect(result.values).toBeUndefined();
    expect(result.valueMeta).toEqual({
      username: { present: true, length: 'test@example.com'.length, source: 'literal' },
      password: { present: true, length: 'secret'.length, source: 'literal' },
    });
  });

  it('nextauth with uiLoginFields + revealSecrets — uses it verbatim (no inversion)', () => {
    const auth: AuthConfig = {
      ...nextauthAuth,
      uiLoginFields: { email: 'auth-email', password: 'auth-pass' },
    };
    const result = buildDescribeAuth(auth, ownerRole, true);
    expect(result.authKind).toBe('nextauth');
    if (result.authKind !== 'nextauth') return;
    expect(result.fields).toEqual({ email: 'auth-email', password: 'auth-pass' });
    expect(result.values).toEqual({ 'auth-email': 'test@example.com', 'auth-pass': 'secret' });
  });

  it('auth.kind === none — returns sentinel', () => {
    const result = buildDescribeAuth({ kind: 'none' }, ownerRole);
    expect(result).toEqual({ authKind: 'none', reason: 'no_auth_configured' });
  });

  it('auth.kind === bearer — returns programmatic_only sentinel', () => {
    const result = buildDescribeAuth({ kind: 'bearer' }, ownerRole);
    expect(result.authKind).toBe('bearer');
    if (result.authKind !== 'bearer') return;
    expect(result.reason).toBe('programmatic_only');
  });

  it('auth.kind === api_key — returns programmatic_only sentinel', () => {
    const result = buildDescribeAuth({ kind: 'api_key' }, ownerRole);
    expect(result.authKind).toBe('api_key');
    if (result.authKind !== 'api_key') return;
    expect(result.reason).toBe('programmatic_only');
  });

  it('anonymous role (no credentials) — returns role_has_no_credentials sentinel', () => {
    const result = buildDescribeAuth(formAuth, anonymousRole);
    expect(result).toEqual({ authKind: 'anonymous', reason: 'role_has_no_credentials' });
  });

  it('$env:VAR resolution — resolves value from process.env (reveal) and reports source: env', () => {
    const savedEnv = process.env['TEST_SECRET'];
    process.env['TEST_SECRET'] = 'env-resolved-password';
    try {
      const role: RoleConfig = { name: 'owner', credentials: { email: 'a@b.com', password: '$env:TEST_SECRET' } };
      const revealed = buildDescribeAuth(formAuth, role, true);
      expect(revealed.authKind).toBe('form');
      if (revealed.authKind !== 'form') return;
      expect(revealed.values?.password).toBe('env-resolved-password');

      // Default (redacted) reports provenance without the value.
      const redacted = buildDescribeAuth(formAuth, role);
      expect(redacted.authKind).toBe('form');
      if (redacted.authKind !== 'form') return;
      expect(redacted.values).toBeUndefined();
      expect(redacted.valueMeta.password).toEqual({
        present: true,
        length: 'env-resolved-password'.length,
        source: 'env',
      });
    } finally {
      if (savedEnv === undefined) delete process.env['TEST_SECRET'];
      else process.env['TEST_SECRET'] = savedEnv;
    }
  });

  it('missing env var — reveals empty string and reports present: false, source: env', () => {
    // Ensure the env var is not set
    const key = 'SURFACEMCP_NONEXISTENT_VAR_12345';
    delete process.env[key];
    const role: RoleConfig = { name: 'owner', credentials: { email: 'a@b.com', password: `$env:${key}` } };
    const revealed = buildDescribeAuth(formAuth, role, true);
    expect(revealed.authKind).toBe('form');
    if (revealed.authKind !== 'form') return;
    expect(revealed.values?.password).toBe('');

    const redacted = buildDescribeAuth(formAuth, role);
    expect(redacted.authKind).toBe('form');
    if (redacted.authKind !== 'form') return;
    expect(redacted.valueMeta.password).toEqual({ present: false, length: 0, source: 'env' });
  });
});

// ─── v0.18 successCheck Zod parsing tests ────────────────────────────────────

function makeTmpConfig(successCheck: unknown): string {
  const configPath = resolve(tmpdir(), `surfacemcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const config = {
    surfaces: [{
      name: 'test',
      stack: 'vite',
      root: '.',
      baseUrl: 'http://localhost:3000',
      port: 3102,
      auth: {
        kind: 'form',
        loginMethod: 'POST',
        loginPath: '/login',
        loginFields: { email: 'email', password: 'password' },
        bodyFormat: 'json',
        successCheck,
      },
      roles: [{ name: 'owner', credentials: { email: 'a@b.com', password: 'secret' } }],
    }],
  };
  writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try { rmSync(f); } catch { /* ignore */ }
  }
});

describe('SuccessCheckSchema — v0.18 localStorage + dom_signal variants', () => {
  it('localStorage kind with key only — parses cleanly', () => {
    const configPath = makeTmpConfig({ kind: 'localStorage', key: 'auth-storage' });
    tmpFiles.push(configPath);
    const config = loadConfig(configPath);
    const check = config.surfaces[0]!.auth;
    expect(check.kind).toBe('form');
    if (check.kind !== 'form') return;
    expect(check.successCheck).toEqual({ kind: 'localStorage', key: 'auth-storage' });
  });

  it('localStorage kind with tokenJsonPath + minLength — parses cleanly', () => {
    const configPath = makeTmpConfig({ kind: 'localStorage', key: 'auth-storage', tokenJsonPath: 'state.token', minLength: 32 });
    tmpFiles.push(configPath);
    const config = loadConfig(configPath);
    const check = config.surfaces[0]!.auth;
    expect(check.kind).toBe('form');
    if (check.kind !== 'form') return;
    expect(check.successCheck).toEqual({ kind: 'localStorage', key: 'auth-storage', tokenJsonPath: 'state.token', minLength: 32 });
  });

  it('localStorage kind round-trips through buildDescribeAuth', () => {
    const auth: AuthConfig = {
      ...formAuth,
      successCheck: { kind: 'localStorage', key: 'auth-storage', tokenJsonPath: 'state.token' },
    };
    const result = buildDescribeAuth(auth, ownerRole);
    expect(result.authKind).toBe('form');
    if (result.authKind !== 'form') return;
    expect(result.successCheck).toEqual({ kind: 'localStorage', key: 'auth-storage', tokenJsonPath: 'state.token' });
    expect(result.cookieName).toBeUndefined();
  });

  it('dom_signal kind — parses cleanly', () => {
    const configPath = makeTmpConfig({ kind: 'dom_signal', selector: '[data-testid="user-menu"]' });
    tmpFiles.push(configPath);
    const config = loadConfig(configPath);
    const check = config.surfaces[0]!.auth;
    expect(check.kind).toBe('form');
    if (check.kind !== 'form') return;
    expect(check.successCheck).toEqual({ kind: 'dom_signal', selector: '[data-testid="user-menu"]' });
  });

  it('dom_signal kind round-trips through buildDescribeAuth', () => {
    const auth: AuthConfig = {
      ...formAuth,
      successCheck: { kind: 'dom_signal', selector: '[data-testid="user-menu"]' },
    };
    const result = buildDescribeAuth(auth, ownerRole);
    expect(result.authKind).toBe('form');
    if (result.authKind !== 'form') return;
    expect(result.successCheck).toEqual({ kind: 'dom_signal', selector: '[data-testid="user-menu"]' });
    expect(result.cookieName).toBeUndefined();
  });

  it('localStorage kind missing key — Zod parse fails', () => {
    const configPath = makeTmpConfig({ kind: 'localStorage' });
    tmpFiles.push(configPath);
    expect(() => loadConfig(configPath)).toThrow();
  });

  it('localStorage kind with empty key — Zod parses OK (runtime rejects)', () => {
    const configPath = makeTmpConfig({ kind: 'localStorage', key: '', tokenJsonPath: 'a.b' });
    tmpFiles.push(configPath);
    const config = loadConfig(configPath);
    const check = config.surfaces[0]!.auth;
    expect(check.kind).toBe('form');
    if (check.kind !== 'form') return;
    expect(check.successCheck.kind).toBe('localStorage');
  });

  it('existing cookie / redirect / status successCheck kinds are unchanged', () => {
    for (const sc of [
      { kind: 'cookie', name: 'session' },
      { kind: 'redirect', to: '/dashboard' },
      { kind: 'status', code: 200 },
    ] as const) {
      const configPath = makeTmpConfig(sc);
      tmpFiles.push(configPath);
      const config = loadConfig(configPath);
      const check = config.surfaces[0]!.auth;
      expect(check.kind).toBe('form');
      if (check.kind !== 'form') return;
      expect(check.successCheck).toEqual(sc);
    }
  });
});
