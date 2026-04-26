/**
 * Minimal Express server that implements CSRF double-submit cookie pattern.
 * Used in auth.form + preLogin integration tests.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';

export function createCsrfServer(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const sessions = new Map<string, string>(); // token -> role
  const csrfTokens = new Set<string>();

  // Pre-login: GET /csrf returns a CSRF token
  app.get('/csrf', (_req, res) => {
    const token = randomUUID();
    csrfTokens.add(token);
    res.json({ csrfToken: token });
  });

  // Login: POST /login with csrf token
  app.post('/login', (req, res) => {
    const { email, password, _csrf } = req.body as { email?: string; password?: string; _csrf?: string };

    if (!_csrf || !csrfTokens.has(_csrf)) {
      res.status(403).json({ error: 'Invalid CSRF token' });
      return;
    }
    csrfTokens.delete(_csrf);

    if (email === 'admin@test.local' && password === 'testpass') {
      const sessionToken = randomUUID();
      sessions.set(sessionToken, 'admin');
      res.setHeader('Set-Cookie', `session=${sessionToken}; HttpOnly; Path=/`);
      res.redirect(302, '/admin');
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  });

  // Protected route
  app.get('/admin', (req, res) => {
    const cookieHeader = req.headers['cookie'] ?? '';
    const sessionMatch = /session=([^;]+)/.exec(cookieHeader);
    if (!sessionMatch || !sessions.has(sessionMatch[1])) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.json({ message: 'Welcome admin' });
  });

  return app;
}
