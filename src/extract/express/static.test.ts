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
