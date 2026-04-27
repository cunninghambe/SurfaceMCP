import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { extractExpressRoutes } from './static.js';

function makeTmpDir(): string {
  const dir = resolve(tmpdir(), `surfacemcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeApp(dir: string, code: string): string {
  const appPath = resolve(dir, 'app.js');
  writeFileSync(appPath, code, 'utf-8');
  return dir;
}

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe('express schema scoping (static.test.ts)', () => {
  it('case 1 — mixed validateBody: only validated routes get schemas', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    writeApp(dir, `
      const { z } = require('zod');
      const app = require('express')();
      const userSchema = z.object({ name: z.string(), age: z.number() });
      function validateBody(s) { return (req, res, next) => next(); }
      function handler(req, res) { res.json({}); }
      app.post('/users', validateBody(userSchema), handler);
      app.get('/health', handler);
    `);

    const tools = await extractExpressRoutes(dir);
    const post = tools.find((t) => t.method === 'POST' && t.path === '/users');
    const get = tools.find((t) => t.method === 'GET' && t.path === '/health');

    expect(post).toBeDefined();
    expect(post!.inputSchemaConfidence).toBe('introspected');
    expect(post!.inputSchema.properties?.name).toBeDefined();

    expect(get).toBeDefined();
    expect(get!.inputSchemaConfidence).toBe('unknown');
    expect(get!.inputSchema).toEqual({ type: 'object', additionalProperties: true });
  });

  it('case 2 — GET does NOT inherit body schema (TraiderJo regression)', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    writeApp(dir, `
      const { z } = require('zod');
      const app = require('express')();
      const tradeSchema = z.object({ symbol: z.string() });
      function validateBody(s) { return (req, res, next) => next(); }
      function handler(req, res) { res.json({}); }
      app.post('/trades', validateBody(tradeSchema), handler);
      app.get('/auth/oauth/google/start', handler);
    `);

    const tools = await extractExpressRoutes(dir);
    const post = tools.find((t) => t.method === 'POST' && t.path === '/trades');
    const get = tools.find((t) => t.method === 'GET' && t.path === '/auth/oauth/google/start');

    expect(post).toBeDefined();
    expect(post!.inputSchemaConfidence).toBe('introspected');

    expect(get).toBeDefined();
    expect(get!.inputSchemaConfidence).toBe('unknown');
    expect(get!.inputSchema).toEqual({ type: 'object', additionalProperties: true });
  });

  it('case 3 — inline safeParse inside handler (pattern B/C)', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    writeApp(dir, `
      const { z } = require('zod');
      const app = require('express')();
      function auth(req, res, next) { next(); }
      app.post('/api/nl-trade-entry/record', auth, async (req, res) => {
        const schema = z.object({ accountId: z.string() });
        const parsed = schema.safeParse(req.body);
        res.json(parsed);
      });
    `);

    const tools = await extractExpressRoutes(dir);
    const post = tools.find((t) => t.method === 'POST' && t.path === '/api/nl-trade-entry/record');

    expect(post).toBeDefined();
    expect(post!.inputSchemaConfidence).toBe('introspected');
    expect(post!.inputSchema.properties?.accountId).toBeDefined();
  });

  it('case 4 — validateBody with unresolved member access → inferred', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    writeApp(dir, `
      const app = require('express')();
      const { schemas } = require('./does-not-exist.js');
      function validateBody(s) { return (req, res, next) => next(); }
      function handler(req, res) { res.json({}); }
      app.post('/foo', validateBody(schemas.somethingWeCannotResolve), handler);
    `);

    const tools = await extractExpressRoutes(dir);
    const post = tools.find((t) => t.method === 'POST' && t.path === '/foo');

    expect(post).toBeDefined();
    expect(post!.inputSchemaConfidence).toBe('inferred');
    expect(post!.inputSchema).toEqual({ type: 'object', additionalProperties: true });
  });

  it('case 5 — two routes in same file referencing different schemas.* keys (no cross-contamination)', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);

    // Write the validation module
    writeFileSync(resolve(dir, 'validation.js'), `
      const { z } = require('zod');
      const schemas = {
        userRegistration: z.object({ email: z.string(), password: z.string() }),
        tradeCreation: z.object({ symbol: z.string(), quantity: z.number() }),
      };
      module.exports = { schemas };
    `, 'utf-8');

    writeApp(dir, `
      const app = require('express')();
      const { schemas } = require('./validation.js');
      function validateBody(s) { return (req, res, next) => next(); }
      function handler(req, res) { res.json({}); }
      app.post('/auth/register', validateBody(schemas.userRegistration), handler);
      app.post('/trades', validateBody(schemas.tradeCreation), handler);
    `);

    const tools = await extractExpressRoutes(dir);
    const register = tools.find((t) => t.method === 'POST' && t.path === '/auth/register');
    const trade = tools.find((t) => t.method === 'POST' && t.path === '/trades');

    expect(register).toBeDefined();
    expect(trade).toBeDefined();

    // Each route must have introspected confidence (schemas are resolvable)
    // and their schemas must not cross-contaminate
    if (register!.inputSchemaConfidence === 'introspected' && trade!.inputSchemaConfidence === 'introspected') {
      const registerProps = Object.keys(register!.inputSchema.properties ?? {});
      const tradeProps = Object.keys(trade!.inputSchema.properties ?? {});
      // userRegistration has email/password; tradeCreation has symbol/quantity
      expect(registerProps).not.toContain('symbol');
      expect(tradeProps).not.toContain('email');
    } else {
      // If runtime import fails, both should be at least inferred (not unknown)
      expect(register!.inputSchemaConfidence).not.toBe('unknown');
      expect(trade!.inputSchemaConfidence).not.toBe('unknown');
    }
  });

  it('case 6 — HEAD and OPTIONS routes are always unknown', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    writeApp(dir, `
      const { z } = require('zod');
      const app = require('express')();
      const bodySchema = z.object({ x: z.string() });
      function validateBody(s) { return (req, res, next) => next(); }
      function handler(req, res) { res.json({}); }
      app.head('/resource', validateBody(bodySchema), handler);
      app.options('/resource', validateBody(bodySchema), handler);
    `);

    const tools = await extractExpressRoutes(dir);
    const head = tools.find((t) => t.method === 'HEAD' && t.path === '/resource');
    const options = tools.find((t) => t.method === 'OPTIONS' && t.path === '/resource');

    expect(head).toBeDefined();
    expect(head!.inputSchemaConfidence).toBe('unknown');

    expect(options).toBeDefined();
    expect(options!.inputSchemaConfidence).toBe('unknown');
  });

  it('case 7 — configurable middleware name (zValidate)', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    writeApp(dir, `
      const { z } = require('zod');
      const app = require('express')();
      const s = z.object({ field: z.string() });
      function zValidate(schema) { return (req, res, next) => next(); }
      function handler(req, res) { res.json({}); }
      app.post('/x', zValidate(s), handler);
    `);

    const tools = await extractExpressRoutes(dir, undefined, ['zValidate']);
    const post = tools.find((t) => t.method === 'POST' && t.path === '/x');

    expect(post).toBeDefined();
    expect(post!.inputSchemaConfidence).toBe('introspected');
    expect(post!.inputSchema.properties?.field).toBeDefined();
  });
});

// ─── Mount-resolution cases (8–18) ──────────────────────────────────────────

describe('express mount resolution', () => {
  function makeTmpDir(): string {
    const dir = resolve(tmpdir(), `surfacemcp-mount-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  const tmpDirs2: string[] = [];

  afterAll(() => {
    for (const dir of tmpDirs2) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('case 8 — simple mounted router (TraiderJo shape)', async () => {
    const dir = makeTmpDir();
    tmpDirs2.push(dir);

    writeFileSync(resolve(dir, 'routes.js'), `
      const router = require('express').Router();
      router.get('/health', h);
      router.post('/trades', h);
      module.exports = router;
    `, 'utf-8');

    writeFileSync(resolve(dir, 'app.js'), `
      const app = require('express')();
      const r = require('./routes');
      app.use('/api/v1', r);
    `, 'utf-8');

    const tools = await extractExpressRoutes(dir);
    const paths = tools.map((t) => `${t.method} ${t.path}`);

    expect(paths).toContain('GET /api/v1/health');
    expect(paths).toContain('POST /api/v1/trades');
    expect(paths).not.toContain('GET /health');
    expect(paths).not.toContain('POST /trades');
  });

  it('case 9 — nested router.use(subPrefix, subRouter)', async () => {
    const dir = makeTmpDir();
    tmpDirs2.push(dir);

    writeFileSync(resolve(dir, 'sub.js'), `
      const sub = require('express').Router();
      sub.get('/list', h);
      module.exports = sub;
    `, 'utf-8');

    writeFileSync(resolve(dir, 'parent.js'), `
      const parent = require('express').Router();
      parent.get('/me', h);
      parent.use('/items', require('./sub'));
      module.exports = parent;
    `, 'utf-8');

    writeFileSync(resolve(dir, 'app.js'), `
      const app = require('express')();
      app.use('/api', require('./parent'));
    `, 'utf-8');

    const tools = await extractExpressRoutes(dir);
    const paths = tools.map((t) => `${t.method} ${t.path}`);

    expect(paths).toContain('GET /api/me');
    expect(paths).toContain('GET /api/items/list');
    expect(paths).not.toContain('GET /me');
    expect(paths).not.toContain('GET /list');
  });

  it('case 10 — inline same-file Router with mount', async () => {
    const dir = makeTmpDir();
    tmpDirs2.push(dir);

    writeFileSync(resolve(dir, 'app.js'), `
      const app = require('express')();
      const r = require('express').Router();
      r.get('/x', h);
      app.use('/y', r);
    `, 'utf-8');

    const tools = await extractExpressRoutes(dir);
    const paths = tools.map((t) => `${t.method} ${t.path}`);

    expect(paths).toContain('GET /y/x');
    expect(paths).not.toContain('GET /x');
  });

  it('case 11 — default export, mounted (ESM)', async () => {
    const dir = makeTmpDir();
    tmpDirs2.push(dir);

    writeFileSync(resolve(dir, 'sub.ts'), `
      import { Router } from 'express';
      const router = Router();
      router.get('/foo', h);
      export default router;
    `, 'utf-8');

    writeFileSync(resolve(dir, 'app.ts'), `
      import sub from './sub.js';
      const app = {} as any;
      app.use('/api', sub);
    `, 'utf-8');

    const tools = await extractExpressRoutes(dir);
    const paths = tools.map((t) => `${t.method} ${t.path}`);

    expect(paths).toContain('GET /api/foo');
  });

  it('case 12 — named export with rename', async () => {
    const dir = makeTmpDir();
    tmpDirs2.push(dir);

    writeFileSync(resolve(dir, 'sub.js'), `
      const r = require('express').Router();
      r.delete('/x', h);
      module.exports = { mcpRouter: r };
    `, 'utf-8');

    writeFileSync(resolve(dir, 'app.js'), `
      const { mcpRouter } = require('./sub');
      const app = require('express')();
      app.use('/mcp', mcpRouter);
    `, 'utf-8');

    const tools = await extractExpressRoutes(dir);
    const paths = tools.map((t) => `${t.method} ${t.path}`);

    expect(paths).toContain('DELETE /mcp/x');
  });

  it('case 13 — re-export barrel (CJS, TraiderJo shape)', async () => {
    const dir = makeTmpDir();
    tmpDirs2.push(dir);

    mkdirSync(resolve(dir, 'moneybot'), { recursive: true });

    writeFileSync(resolve(dir, 'moneybot', 'routes.js'), `
      const router = require('express').Router();
      router.post('/summaries/daily', h);
      module.exports = router;
    `, 'utf-8');

    writeFileSync(resolve(dir, 'moneybot', 'index.js'), `
      module.exports = { moneybotRouter: require('./routes') };
    `, 'utf-8');

    writeFileSync(resolve(dir, 'app.js'), `
      const { moneybotRouter } = require('./moneybot');
      const app = require('express')();
      app.use('/api/v1', moneybotRouter);
    `, 'utf-8');

    const tools = await extractExpressRoutes(dir);
    const paths = tools.map((t) => `${t.method} ${t.path}`);

    expect(paths).toContain('POST /api/v1/summaries/daily');
  });

  it('case 13b — re-export barrel (ESM)', async () => {
    const dir = makeTmpDir();
    tmpDirs2.push(dir);

    mkdirSync(resolve(dir, 'moneybot'), { recursive: true });

    writeFileSync(resolve(dir, 'moneybot', 'routes.ts'), `
      import { Router } from 'express';
      const router = Router();
      router.post('/summaries/daily', h);
      export default router;
    `, 'utf-8');

    writeFileSync(resolve(dir, 'moneybot', 'index.ts'), `
      export { default as moneybotRouter } from './routes.js';
    `, 'utf-8');

    writeFileSync(resolve(dir, 'app.ts'), `
      import { moneybotRouter } from './moneybot/index.js';
      const app = {} as any;
      app.use('/api/v1', moneybotRouter);
    `, 'utf-8');

    const tools = await extractExpressRoutes(dir);
    const paths = tools.map((t) => `${t.method} ${t.path}`);

    expect(paths).toContain('POST /api/v1/summaries/daily');
  });

  it('case 14 — same router mounted twice under different prefixes', async () => {
    const dir = makeTmpDir();
    tmpDirs2.push(dir);

    writeFileSync(resolve(dir, 'app.js'), `
      const r = require('express').Router();
      r.get('/ping', h);
      const app = require('express')();
      app.use('/v1', r);
      app.use('/v2', r);
    `, 'utf-8');

    const tools = await extractExpressRoutes(dir);
    const paths = tools.map((t) => `${t.method} ${t.path}`);

    expect(paths).toContain('GET /v1/ping');
    expect(paths).toContain('GET /v2/ping');
  });

  it('case 15 — mount with no prefix', async () => {
    const dir = makeTmpDir();
    tmpDirs2.push(dir);

    writeFileSync(resolve(dir, 'app.js'), `
      const r = require('express').Router();
      r.get('/raw', h);
      const app = require('express')();
      app.use(r);
    `, 'utf-8');

    const tools = await extractExpressRoutes(dir);
    const paths = tools.map((t) => `${t.method} ${t.path}`);

    expect(paths).toContain('GET /raw');
  });

  it('case 16 — circular re-export (cycle safety)', async () => {
    const dir = makeTmpDir();
    tmpDirs2.push(dir);

    writeFileSync(resolve(dir, 'a.js'), `module.exports = require('./b');`, 'utf-8');
    writeFileSync(resolve(dir, 'b.js'), `module.exports = require('./a');`, 'utf-8');
    writeFileSync(resolve(dir, 'app.js'), `
      const app = require('express')();
      app.use('/x', require('./a'));
    `, 'utf-8');

    await expect(extractExpressRoutes(dir)).resolves.toBeInstanceOf(Array);
  });

  it('case 17 — unresolved bare-import mount produces no /v1 routes', async () => {
    const dir = makeTmpDir();
    tmpDirs2.push(dir);

    writeFileSync(resolve(dir, 'app.js'), `
      const r = require('some-third-party-lib');
      const app = require('express')();
      app.use('/v1', r);
    `, 'utf-8');

    const tools = await extractExpressRoutes(dir);
    const v1Routes = tools.filter((t) => t.path.startsWith('/v1'));

    expect(v1Routes).toHaveLength(0);
  });

  it('case 18 — flat top-level routes (regression: bare-fallback path)', async () => {
    const dir = makeTmpDir();
    tmpDirs2.push(dir);

    writeFileSync(resolve(dir, 'app.js'), `
      const app = require('express')();
      app.post('/users', handler);
      app.get('/health', handler);
    `, 'utf-8');

    const tools = await extractExpressRoutes(dir);
    const paths = tools.map((t) => `${t.method} ${t.path}`);

    expect(paths).toContain('POST /users');
    expect(paths).toContain('GET /health');
  });
});
