import { describe, it, expect } from 'vitest';
import {
  resolveTokenState,
  timingSafeEqualStr,
  extractBearer,
  isTokenAuthorized,
  buildAllowedHosts,
  isHostAllowed,
  isOriginAllowed,
  TOKEN_ENV,
  AUTH_DISABLED_ENV,
} from './security.js';

describe('resolveTokenState', () => {
  it('uses SURFACEMCP_TOKEN when set', () => {
    const state = resolveTokenState({ [TOKEN_ENV]: 'my-secret' } as NodeJS.ProcessEnv);
    expect(state).toEqual({ token: 'my-secret', source: 'env' });
  });

  it('generates a random 32-byte hex token when unset', () => {
    const state = resolveTokenState({} as NodeJS.ProcessEnv);
    expect(state.source).toBe('generated');
    expect(state.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates a token when SURFACEMCP_TOKEN is empty/whitespace', () => {
    const state = resolveTokenState({ [TOKEN_ENV]: '   ' } as NodeJS.ProcessEnv);
    expect(state.source).toBe('generated');
  });

  it('disables the gate when SURFACEMCP_AUTH_DISABLED is truthy', () => {
    for (const v of ['1', 'true', 'YES', 'on']) {
      const state = resolveTokenState({ [AUTH_DISABLED_ENV]: v } as NodeJS.ProcessEnv);
      expect(state).toEqual({ token: null, source: 'disabled' });
    }
  });

  it('disable flag takes precedence over a configured token', () => {
    const state = resolveTokenState({
      [AUTH_DISABLED_ENV]: '1',
      [TOKEN_ENV]: 'ignored',
    } as NodeJS.ProcessEnv);
    expect(state.token).toBeNull();
  });

  it('does not disable for falsey-looking values', () => {
    const state = resolveTokenState({ [AUTH_DISABLED_ENV]: '0', [TOKEN_ENV]: 't' } as NodeJS.ProcessEnv);
    expect(state).toEqual({ token: 't', source: 'env' });
  });
});

describe('timingSafeEqualStr', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqualStr('abc123', 'abc123')).toBe(true);
  });
  it('returns false for different strings of equal length', () => {
    expect(timingSafeEqualStr('abc123', 'abc124')).toBe(false);
  });
  it('returns false for different-length strings without throwing', () => {
    expect(timingSafeEqualStr('short', 'a-much-longer-secret')).toBe(false);
  });
  it('handles empty strings', () => {
    expect(timingSafeEqualStr('', '')).toBe(true);
    expect(timingSafeEqualStr('', 'x')).toBe(false);
  });
});

describe('extractBearer', () => {
  it('extracts the token from a valid header', () => {
    expect(extractBearer('Bearer abc.def')).toBe('abc.def');
  });
  it('is case-insensitive on the scheme', () => {
    expect(extractBearer('bearer xyz')).toBe('xyz');
  });
  it('trims surrounding whitespace', () => {
    expect(extractBearer('  Bearer   tok  ')).toBe('tok');
  });
  it('returns null for missing/malformed headers', () => {
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer('')).toBeNull();
    expect(extractBearer('Basic abc')).toBeNull();
    expect(extractBearer('Bearer')).toBeNull();
  });
});

describe('isTokenAuthorized', () => {
  const token = 'the-real-token';
  it('accepts the correct bearer token', () => {
    expect(isTokenAuthorized(`Bearer ${token}`, token)).toBe(true);
  });
  it('rejects a wrong token', () => {
    expect(isTokenAuthorized('Bearer nope', token)).toBe(false);
  });
  it('rejects a missing header', () => {
    expect(isTokenAuthorized(undefined, token)).toBe(false);
  });
  it('rejects a non-bearer scheme', () => {
    expect(isTokenAuthorized(`Token ${token}`, token)).toBe(false);
  });
});

describe('buildAllowedHosts / isHostAllowed', () => {
  const hosts = buildAllowedHosts(3120);
  it('includes loopback authorities for the port', () => {
    expect(hosts).toContain('127.0.0.1:3120');
    expect(hosts).toContain('localhost:3120');
    expect(hosts).toContain('[::1]:3120');
  });
  it('allows an exact loopback host', () => {
    expect(isHostAllowed('127.0.0.1:3120', hosts)).toBe(true);
    expect(isHostAllowed('localhost:3120', hosts)).toBe(true);
  });
  it('is case-insensitive on the hostname', () => {
    expect(isHostAllowed('LOCALHOST:3120', hosts)).toBe(true);
  });
  it('rejects a wrong port', () => {
    expect(isHostAllowed('127.0.0.1:9999', hosts)).toBe(false);
  });
  it('rejects a foreign host (DNS rebinding)', () => {
    expect(isHostAllowed('evil.example.com:3120', hosts)).toBe(false);
  });
  it('rejects a missing Host header', () => {
    expect(isHostAllowed(undefined, hosts)).toBe(false);
  });
});

describe('isOriginAllowed', () => {
  it('allows a request with no Origin (non-browser client)', () => {
    expect(isOriginAllowed(undefined, [])).toBe(true);
    expect(isOriginAllowed('', [])).toBe(true);
  });
  it('rejects any Origin when allowlist is empty', () => {
    expect(isOriginAllowed('http://evil.example', [])).toBe(false);
    expect(isOriginAllowed('http://localhost:3120', [])).toBe(false);
  });
  it('allows an allowlisted Origin', () => {
    expect(isOriginAllowed('http://localhost:3120', ['http://localhost:3120'])).toBe(true);
  });
});
