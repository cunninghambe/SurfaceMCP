import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildDescribeAuth } from './describe-auth.js';
import type { AuthConfig, RoleConfig } from '../types.js';

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
  it('form auth — returns resolved values keyed by post field name', () => {
    const result = buildDescribeAuth(formAuth, ownerRole);
    expect(result.authKind).toBe('form');
    if (result.authKind !== 'form') return;
    expect(result.uiLoginPath).toBe('/auth/login');
    expect(result.fields).toEqual({ email: 'email', password: 'password' });
    expect(result.values).toEqual({ email: 'test@example.com', password: 'secret' });
    expect(result.successCheck).toEqual({ kind: 'cookie', name: 'session' });
    expect(result.cookieName).toBe('session');
  });

  it('form auth with uiLoginFields — returns values keyed by domFieldName', () => {
    const auth: AuthConfig = {
      ...formAuth,
      uiLoginPath: '/',
      uiLoginFields: { email: 'identifier', password: 'password' },
      uiTriggerSelector: 'button:has-text("Sign in")',
    };
    const result = buildDescribeAuth(auth, ownerRole);
    expect(result.authKind).toBe('form');
    if (result.authKind !== 'form') return;
    expect(result.uiLoginPath).toBe('/');
    expect(result.uiTriggerSelector).toBe('button:has-text("Sign in")');
    expect(result.fields).toEqual({ email: 'identifier', password: 'password' });
    expect(result.values).toEqual({ identifier: 'test@example.com', password: 'secret' });
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

  it('nextauth without uiLoginFields — inverts auth.fields correctly', () => {
    const result = buildDescribeAuth(nextauthAuth, ownerRole);
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

  it('nextauth with uiLoginFields — uses it verbatim (no inversion)', () => {
    const auth: AuthConfig = {
      ...nextauthAuth,
      uiLoginFields: { email: 'auth-email', password: 'auth-pass' },
    };
    const result = buildDescribeAuth(auth, ownerRole);
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

  it('$env:VAR resolution — resolves value from process.env', () => {
    const savedEnv = process.env['TEST_SECRET'];
    process.env['TEST_SECRET'] = 'env-resolved-password';
    try {
      const role: RoleConfig = { name: 'owner', credentials: { email: 'a@b.com', password: '$env:TEST_SECRET' } };
      const result = buildDescribeAuth(formAuth, role);
      expect(result.authKind).toBe('form');
      if (result.authKind !== 'form') return;
      expect(result.values.password).toBe('env-resolved-password');
    } finally {
      if (savedEnv === undefined) delete process.env['TEST_SECRET'];
      else process.env['TEST_SECRET'] = savedEnv;
    }
  });

  it('missing env var — returns empty string', () => {
    // Ensure the env var is not set
    const key = 'SURFACEMCP_NONEXISTENT_VAR_12345';
    delete process.env[key];
    const role: RoleConfig = { name: 'owner', credentials: { email: 'a@b.com', password: `$env:${key}` } };
    const result = buildDescribeAuth(formAuth, role);
    expect(result.authKind).toBe('form');
    if (result.authKind !== 'form') return;
    expect(result.values.password).toBe('');
  });
});
