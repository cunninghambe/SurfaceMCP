import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { extractExpressRoutes } from './static.js';

const FIXTURES = resolve(import.meta.dirname, '../../../fixtures');
const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(code: string): string {
  const dir = resolve(
    tmpdir(),
    `surfacemcp-express-response-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  writeFileSync(resolve(dir, 'app.ts'), code, 'utf-8');
  return dir;
}

describe('express response typing — fixture', () => {
  it('prefers a declared Response<T> body type over the json literal', async () => {
    const tools = await extractExpressRoutes(resolve(FIXTURES, 'express-app'));
    const get = tools.find((t) => t.method === 'GET' && t.path === '/api/products')!;
    expect(get.outputSchemaConfidence).toBe('inferred');
    expect(get.outputSchema).toEqual({
      type: 'object',
      properties: { products: { type: 'array', items: { type: 'string' } }, total: { type: 'number' } },
      required: ['products', 'total'],
    });
  });

  it('falls back to the res.json literal, reporting the key set', async () => {
    const tools = await extractExpressRoutes(resolve(FIXTURES, 'express-app'));
    const del = tools.find((t) => t.method === 'DELETE')!;
    expect(del.outputSchemaConfidence).toBe('inferred');
    expect(del.outputSchema).toEqual({ type: 'object', properties: { deleted: {} } });
  });

  it('leaves the pinned inputSchema and toolIds untouched', async () => {
    const tools = await extractExpressRoutes(resolve(FIXTURES, 'express-app'));
    const post = tools.find((t) => t.method === 'POST' && t.path === '/api/products')!;
    expect(post.inputSchemaConfidence).toBe('introspected');
    expect(post.inputSchema.properties?.name).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 200,
    });
  });
});

describe('express response typing — edge cases', () => {
  it('reads a res.status(...).json(...) chain', async () => {
    const dir = scratch(`
      const app = require('express')();
      app.post('/x', (req, res) => {
        res.status(201).json({ id: 'a', ok: true });
      });
    `);
    const tool = (await extractExpressRoutes(dir))[0];
    expect(tool.outputSchema).toEqual({
      type: 'object',
      properties: { id: { type: 'string' }, ok: { type: 'boolean' } },
    });
    expect(tool.outputSchemaConfidence).toBe('inferred');
  });

  it('emits nothing when branches return structurally different bodies', async () => {
    const dir = scratch(`
      const app = require('express')();
      app.get('/x', (req, res) => {
        if (!req.query.id) return res.status(400).json({ error: 'missing' });
        res.json({ item: { id: req.query.id } });
      });
    `);
    expect((await extractExpressRoutes(dir))[0].outputSchema).toBeUndefined();
  });

  it('accepts branches that agree on the shape', async () => {
    const dir = scratch(`
      const app = require('express')();
      app.get('/x', (req, res) => {
        if (!req.query.id) return res.json({ error: 'missing' });
        res.json({ error: 'other' });
      });
    `);
    expect((await extractExpressRoutes(dir))[0].outputSchema).toEqual({
      type: 'object',
      properties: { error: { type: 'string' } },
    });
  });

  it('emits nothing for a handler that never calls res.json', async () => {
    const dir = scratch(`
      const app = require('express')();
      app.get('/x', (req, res) => { res.send('plain text'); });
    `);
    expect((await extractExpressRoutes(dir))[0].outputSchema).toBeUndefined();
  });

  it('ignores json calls made on something other than the res parameter', async () => {
    const dir = scratch(`
      const app = require('express')();
      app.get('/x', async (req, res) => {
        const upstream = await fetch('/u');
        const data = upstream.json({ nope: 1 });
        res.end();
      });
    `);
    expect((await extractExpressRoutes(dir))[0].outputSchema).toBeUndefined();
  });

  it('follows a named handler declared elsewhere in the file', async () => {
    const dir = scratch(`
      const app = require('express')();
      function listUsers(req, res) { res.json({ users: [] }); }
      app.get('/users', listUsers);
    `);
    expect((await extractExpressRoutes(dir))[0].outputSchema).toEqual({
      type: 'object',
      properties: { users: { type: 'array' } },
    });
  });

  it('shares one response schema across every mount prefix of a router', async () => {
    const dir = scratch(`
      import express from 'express';
      const app = express();
      const router = express.Router();
      router.get('/ping', (req, res) => { res.json({ pong: true }); });
      app.use('/api/v1', router);
      app.use('/api/v2', router);
    `);
    const tools = await extractExpressRoutes(dir);
    expect(tools.map((t) => t.path).sort()).toEqual(['/api/v1/ping', '/api/v2/ping']);
    for (const tool of tools) {
      expect(tool.outputSchema).toEqual({
        type: 'object',
        properties: { pong: { type: 'boolean' } },
      });
    }
  });
});
