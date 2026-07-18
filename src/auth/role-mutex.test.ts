import { describe, it, expect } from 'vitest';
import { RoleMutex } from './role-mutex.js';
import type { AuthConfig } from '../types.js';

const NONE: AuthConfig = { kind: 'none' };
const BASE = 'http://127.0.0.1:4104';

describe('RoleMutex — built-in anonymous role', () => {
  it('returns an unauthenticated session for "anonymous" even when roles[] is empty', async () => {
    // BugHunter exercises the public surface as role "anonymous". SurfaceMCP must
    // not reject it with "Unknown role" just because the config declares no roles.
    const mutex = new RoleMutex(BASE, NONE, []);
    const session = await mutex.refresh('anonymous');
    expect(session.cookies).toEqual([]);
    expect(session.token).toBeUndefined();
  });

  it('caches the anonymous session via ensureSession', async () => {
    const mutex = new RoleMutex(BASE, NONE, []);
    const first = await mutex.ensureSession('anonymous');
    const second = await mutex.ensureSession('anonymous');
    expect(second).toBe(first);
  });

  it('still throws for a genuinely unknown (non-anonymous) role', async () => {
    const mutex = new RoleMutex(BASE, NONE, []);
    await expect(mutex.refresh('owner')).rejects.toThrow('Unknown role: owner');
  });

  it('honors an explicitly declared "anonymous" role identically', async () => {
    const mutex = new RoleMutex(BASE, NONE, [{ name: 'anonymous' }]);
    const session = await mutex.refresh('anonymous');
    expect(session.cookies).toEqual([]);
    expect(session.token).toBeUndefined();
  });
});
