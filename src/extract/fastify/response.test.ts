import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { extractFastifyRoutes } from './routes.js';

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
    `surfacemcp-fastify-response-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  writeFileSync(resolve(dir, 'app.js'), code, 'utf-8');
  return dir;
}

describe('fastify response typing — fixture', () => {
  const tools = extractFastifyRoutes(resolve(FIXTURES, 'fastify-app'));
  const byKey = new Map(tools.map((t) => [`${t.method} ${t.path}`, t]));

  it('reads a declared 200 response schema verbatim as introspected', () => {
    const get = byKey.get('GET /api/items')!;
    expect(get.outputSchemaConfidence).toBe('introspected');
    expect(get.outputSchema).toEqual({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              price: { type: 'number' },
            },
          },
        },
        total: { type: 'integer' },
      },
    });
  });

  it('falls through to 201 when there is no 200, ignoring the 4xx entry', () => {
    const post = byKey.get('POST /api/items')!;
    expect(post.outputSchemaConfidence).toBe('introspected');
    expect(post.outputSchema).toEqual({
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' }, name: { type: 'string' } },
    });
  });

  it("honours a lowercase '2xx' wildcard in the route-config form", () => {
    const put = byKey.get('PUT /api/items/:id')!;
    expect(put.outputSchemaConfidence).toBe('introspected');
    expect(put.outputSchema).toEqual({
      type: 'object',
      properties: { updated: { type: 'string' } },
    });
  });

  it('emits nothing for routes that declare no response schema', () => {
    for (const key of ['GET /users/:id', 'DELETE /api/items/:id']) {
      expect(byKey.get(key)!.outputSchema).toBeUndefined();
      expect(byKey.get(key)!.outputSchemaConfidence).toBeUndefined();
    }
  });

  it('leaves inputSchema and toolIds untouched', () => {
    const get = byKey.get('GET /api/items')!;
    expect(get.toolId).toBe('b05eaf6e57c0');
    expect(get.name).toBe('get_api_items');
    expect(get.inputSchemaConfidence).toBe('introspected');
    expect(get.inputSchema.properties?.limit).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 100,
    });
  });
});

describe('fastify response typing — edge cases', () => {
  it('unwraps the OpenAPI-flavoured content wrapper', () => {
    const dir = scratch(`
      const fastify = require('fastify')();
      fastify.get('/wrapped', {
        schema: {
          response: {
            200: {
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
                },
              },
            },
          },
        },
      }, async () => ({}));
    `);
    const tool = extractFastifyRoutes(dir)[0];
    expect(tool.outputSchema).toEqual({ type: 'object', properties: { ok: { type: 'boolean' } } });
    expect(tool.outputSchemaConfidence).toBe('introspected');
  });

  it('skips a response schema referencing an identifier it cannot inline', () => {
    const dir = scratch(`
      const fastify = require('fastify')();
      const itemSchema = { type: 'object' };
      fastify.get('/ref', { schema: { response: { 200: itemSchema } } }, async () => ({}));
    `);
    expect(extractFastifyRoutes(dir)[0].outputSchema).toBeUndefined();
  });

  it('skips a response map with no success status', () => {
    const dir = scratch(`
      const fastify = require('fastify')();
      fastify.get('/errors-only', {
        schema: { response: { 404: { type: 'object' }, 500: { type: 'object' } } },
      }, async () => ({}));
    `);
    expect(extractFastifyRoutes(dir)[0].outputSchema).toBeUndefined();
  });

  it('applies one response declaration to every verb of a multi-method route', () => {
    const dir = scratch(`
      const fastify = require('fastify')();
      fastify.route({
        method: ['GET', 'HEAD'],
        url: '/multi',
        schema: { response: { 200: { type: 'object', properties: { a: { type: 'string' } } } } },
        handler: async () => ({}),
      });
    `);
    const tools = extractFastifyRoutes(dir);
    expect(tools).toHaveLength(2);
    for (const tool of tools) {
      expect(tool.outputSchemaConfidence).toBe('introspected');
      expect(tool.outputSchema).toEqual({ type: 'object', properties: { a: { type: 'string' } } });
    }
  });
});
