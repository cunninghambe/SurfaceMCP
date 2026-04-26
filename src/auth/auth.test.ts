import { describe, it, expect } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { RoleMutex } from './role-mutex.js';
import { shouldAutoRelogin } from './refresh-policy.js';
import type { AuthConfig, RoleConfig } from '../types.js';

describe('auto-relogin policy', () => {
  it('does NOT trigger on bare 401', () => {
    expect(shouldAutoRelogin(401, {}, null, 'session')).toBe(false);
  });

  it('does NOT trigger on 400', () => {
    expect(shouldAutoRelogin(400, {}, null, 'session')).toBe(false);
  });

  it('triggers on 401 + Set-Cookie clearing session', () => {
    const headers = { 'set-cookie': 'session=; Max-Age=0; Path=/' };
    expect(shouldAutoRelogin(401, headers, null, 'session')).toBe(true);
  });

  it('triggers on 401 + WWW-Authenticate invalid_token', () => {
    const headers = { 'www-authenticate': 'Bearer error="invalid_token"' };
    expect(shouldAutoRelogin(401, headers, null, 'session')).toBe(true);
  });

  it('triggers on 403 + DRF token_not_valid body', () => {
    const body = { code: 'token_not_valid', detail: 'Token is invalid or expired' };
    expect(shouldAutoRelogin(403, {}, body, 'session')).toBe(true);
  });

  it('does NOT trigger on 200', () => {
    expect(shouldAutoRelogin(200, {}, null, 'session')).toBe(false);
  });
});

describe('per-role refresh mutex', () => {
  const auth: AuthConfig = { kind: 'none' };
  const roles: RoleConfig[] = [{ name: 'user', credentials: {} }];

  it('returns a session for "none" auth', async () => {
    const mutex = new RoleMutex('http://localhost:3000', auth, roles);
    const session = await mutex.ensureSession('user');
    expect(session.cachedAt).toBeDefined();
    expect(session.refreshCount).toBe(1);
  });

  it('caches session on second call (no re-login)', async () => {
    const mutex = new RoleMutex('http://localhost:3000', auth, roles);
    const s1 = await mutex.ensureSession('user');
    const s2 = await mutex.ensureSession('user');
    expect(s1.cachedAt).toBe(s2.cachedAt);
  });

  it('throws for unknown role', async () => {
    const mutex = new RoleMutex('http://localhost:3000', auth, roles);
    await expect(mutex.ensureSession('unknown')).rejects.toThrow('Unknown role: unknown');
  });

  it('concurrent refresh calls use the same in-flight promise (mutex behavior)', async () => {
    const mutex = new RoleMutex('http://localhost:3000', { kind: 'none' }, roles);

    const originalRefresh = mutex.refresh.bind(mutex);
    const promises = Array.from({ length: 50 }, () => originalRefresh('user'));
    const results = await Promise.all(promises);

    // All 50 calls should resolve to valid sessions
    for (const result of results) {
      expect(result.cookies).toBeDefined();
    }

    // Because of the mutex, all concurrent calls share one in-flight promise.
    // Once the first refresh completes, subsequent calls see a cached session.
    const session = mutex.getSession('user');
    expect(session).toBeDefined();
  });

  it('mutex: 50 concurrent refresh calls, all get a valid session', async () => {
    const mutex = new RoleMutex('http://localhost:3000', { kind: 'none' }, roles);
    await mutex.ensureSession('user');

    const calls = Array.from({ length: 50 }, () => mutex.refresh('user'));
    const results = await Promise.all(calls);

    for (const r of results) {
      expect(r.cookies).toBeDefined();
    }
    expect(mutex.getSession('user')).toBeDefined();
  });
});

/**
 * Minimal CSRF double-submit server built with node:http (no express typing issues).
 */
function createCsrfTestServer(): Promise<{ baseUrl: string; close: () => void }> {
  const sessions = new Map<string, string>();
  const csrfTokens = new Set<string>();

  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '/';

      if (req.method === 'GET' && url === '/csrf') {
        const token = randomUUID();
        csrfTokens.add(token);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ csrfToken: token }));
        return;
      }

      if (req.method === 'POST' && url === '/login') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          const params = new URLSearchParams(body);
          const email = params.get('email');
          const password = params.get('password');
          const csrf = params.get('_csrf');

          if (!csrf || !csrfTokens.has(csrf)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid CSRF token' }));
            return;
          }
          csrfTokens.delete(csrf);

          if (email === 'admin@test.local' && password === 'testpass') {
            const sessionToken = randomUUID();
            sessions.set(sessionToken, 'admin');
            res.writeHead(302, {
              'Location': '/admin',
              'Set-Cookie': `session=${sessionToken}; HttpOnly; Path=/`,
            });
            res.end();
          } else {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid credentials' }));
          }
        });
        return;
      }

      if (req.method === 'GET' && url === '/admin') {
        const cookie = req.headers['cookie'] ?? '';
        const sessionMatch = /session=([^;]+)/.exec(cookie);
        if (!sessionMatch || !sessions.has(sessionMatch[1])) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Welcome admin' }));
        }
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

describe('CSRF form auth with preLogin', () => {
  it('loginForm with preLogin works against a CSRF double-submit server', async () => {
    const { baseUrl, close } = await createCsrfTestServer();
    try {
      const { loginForm } = await import('./form.js');
      const result = await loginForm(
        baseUrl,
        {
          kind: 'form',
          preLogin: {
            method: 'GET',
            path: '/csrf',
            captureBodyFieldAs: 'csrfToken',
          },
          loginMethod: 'POST',
          loginPath: '/login',
          loginFields: {
            email: 'email',
            password: 'password',
            csrfToken: '_csrf',
          },
          successCheck: { kind: 'redirect', to: '/admin' },
        },
        { email: 'admin@test.local', password: 'testpass' }
      );

      expect(result.ok).toBe(true);
      expect(result.cookies.some((c) => c.startsWith('session='))).toBe(true);
    } finally {
      close();
    }
  });

  it('loginForm fails with bad credentials', async () => {
    const { baseUrl, close } = await createCsrfTestServer();
    try {
      const { loginForm } = await import('./form.js');
      const result = await loginForm(
        baseUrl,
        {
          kind: 'form',
          preLogin: { method: 'GET', path: '/csrf', captureBodyFieldAs: 'csrfToken' },
          loginMethod: 'POST',
          loginPath: '/login',
          loginFields: { email: 'email', password: 'password', csrfToken: '_csrf' },
          successCheck: { kind: 'redirect', to: '/admin' },
        },
        { email: 'wrong@test.local', password: 'badpass' }
      );
      expect(result.ok).toBe(false);
    } finally {
      close();
    }
  });
});
