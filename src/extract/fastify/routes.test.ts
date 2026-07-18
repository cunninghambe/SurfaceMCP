import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { extractFastifyRoutes } from './routes.js';

function makeTmpDir(): string {
  const dir = resolve(tmpdir(), `surfacemcp-fastify-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeApp(dir: string, code: string): string {
  writeFileSync(resolve(dir, 'app.js'), code, 'utf-8');
  return dir;
}

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(code: string): string {
  const dir = makeTmpDir();
  tmpDirs.push(dir);
  return writeApp(dir, code);
}

describe('fastify shorthand routes', () => {
  it('extracts a plain shorthand route with a stable toolId and name', () => {
    const dir = scratch(`
      const fastify = require('fastify')();
      function h(req, reply) { return {}; }
      fastify.get('/api/items', h);
    `);

    const tools = extractFastifyRoutes(dir);
    const get = tools.find((t) => t.method === 'GET' && t.path === '/api/items');

    expect(get).toBeDefined();
    expect(get!.name).toBe('get_api_items');
    expect(get!.toolId).toBe('b05eaf6e57c0');
    expect(get!.sideEffectClass).toBe('safe');
    expect(get!.isServerAction).toBe(false);
    expect(get!.sourceFile).toBe('app.js');
    // No schema → open object, unknown confidence.
    expect(get!.inputSchemaConfidence).toBe('unknown');
    expect(get!.inputSchema).toEqual({ type: 'object', additionalProperties: true });
  });

  it('covers every HTTP verb shorthand', () => {
    const dir = scratch(`
      const fastify = require('fastify')();
      function h(req, reply) { return {}; }
      fastify.get('/r', h);
      fastify.post('/r', h);
      fastify.put('/r', h);
      fastify.patch('/r', h);
      fastify.delete('/r', h);
      fastify.head('/r', h);
      fastify.options('/r', h);
    `);

    const methods = extractFastifyRoutes(dir).map((t) => t.method).sort();
    expect(methods).toEqual(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
  });

  it('introspects a GET querystring schema (introspected confidence)', () => {
    const dir = scratch(`
      const fastify = require('fastify')();
      function h(req, reply) { return {}; }
      fastify.get('/health', {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              limit: { type: 'integer', minimum: 1, maximum: 100 },
              cursor: { type: 'string' },
            },
          },
        },
      }, h);
    `);

    const tools = extractFastifyRoutes(dir);
    const get = tools.find((t) => t.method === 'GET' && t.path === '/health');

    expect(get).toBeDefined();
    expect(get!.toolId).toBe('389ff1e1c9e3');
    expect(get!.inputSchemaConfidence).toBe('introspected');
    expect(get!.inputSchema.type).toBe('object');
    expect(get!.inputSchema.properties?.limit).toEqual({ type: 'integer', minimum: 1, maximum: 100 });
    expect(get!.inputSchema.properties?.cursor).toEqual({ type: 'string' });
  });

  it('introspects a POST body schema (introspected confidence)', () => {
    const dir = scratch(`
      const fastify = require('fastify')();
      function h(req, reply) { return {}; }
      fastify.post('/things', {
        schema: {
          body: {
            type: 'object',
            required: ['name', 'price'],
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 200 },
              price: { type: 'number', minimum: 0 },
            },
          },
        },
      }, h);
    `);

    const tools = extractFastifyRoutes(dir);
    const post = tools.find((t) => t.method === 'POST' && t.path === '/things');

    expect(post).toBeDefined();
    expect(post!.toolId).toBe('1dedc72a48f8');
    expect(post!.name).toBe('post_things');
    expect(post!.sideEffectClass).toBe('mutating');
    expect(post!.inputSchemaConfidence).toBe('introspected');
    expect(post!.inputSchema.required).toEqual(['name', 'price']);
    expect(post!.inputSchema.properties?.name).toEqual({ type: 'string', minLength: 1, maxLength: 200 });
    expect(post!.inputSchema.properties?.price).toEqual({ type: 'number', minimum: 0 });
  });

  it('reads schema from an options object even when the handler is a config property', () => {
    const dir = scratch(`
      const fastify = require('fastify')();
      function h(req, reply) { return {}; }
      fastify.get('/health', {
        schema: { querystring: { type: 'object', properties: { q: { type: 'string' } } } },
        handler: h,
      });
    `);

    const get = extractFastifyRoutes(dir).find((t) => t.method === 'GET' && t.path === '/health');
    expect(get!.inputSchemaConfidence).toBe('introspected');
    expect(get!.inputSchema.properties?.q).toEqual({ type: 'string' });
  });

  it('handles negative numeric constraints in a schema', () => {
    const dir = scratch(`
      const fastify = require('fastify')();
      function h(req, reply) { return {}; }
      fastify.post('/things', {
        schema: { body: { type: 'object', properties: { temp: { type: 'integer', minimum: -40, maximum: 60 } } } },
      }, h);
    `);

    const post = extractFastifyRoutes(dir).find((t) => t.method === 'POST' && t.path === '/things');
    expect(post!.inputSchemaConfidence).toBe('introspected');
    expect(post!.inputSchema.properties?.temp).toEqual({ type: 'integer', minimum: -40, maximum: 60 });
  });

  it('does not introspect a body schema for a GET (querystring only)', () => {
    const dir = scratch(`
      const fastify = require('fastify')();
      function h(req, reply) { return {}; }
      fastify.get('/things', {
        schema: { body: { type: 'object', properties: { name: { type: 'string' } } } },
      }, h);
    `);

    const get = extractFastifyRoutes(dir).find((t) => t.method === 'GET' && t.path === '/things');
    expect(get!.inputSchemaConfidence).toBe('unknown');
    expect(get!.inputSchema).toEqual({ type: 'object', additionalProperties: true });
  });

  it('falls back to unknown when a schema property is an unresolvable identifier', () => {
    const dir = scratch(`
      const fastify = require('fastify')();
      const sharedBody = { type: 'object', properties: { name: { type: 'string' } } };
      function h(req, reply) { return {}; }
      fastify.post('/things', { schema: { body: sharedBody } }, h);
    `);

    const post = extractFastifyRoutes(dir).find((t) => t.method === 'POST' && t.path === '/things');
    expect(post!.inputSchemaConfidence).toBe('unknown');
    expect(post!.inputSchema).toEqual({ type: 'object', additionalProperties: true });
  });

  it('extracts param routes with :id syntax preserved', () => {
    const dir = scratch(`
      const fastify = require('fastify')();
      function h(req, reply) { return {}; }
      fastify.get('/things/:id', h);
    `);

    const get = extractFastifyRoutes(dir).find((t) => t.path === '/things/:id');
    expect(get).toBeDefined();
    expect(get!.name).toBe('get_things_id');
    expect(get!.toolId).toBe('ef52ca692e0f');
  });
});

describe('fastify full-config routes (fastify.route({...}))', () => {
  it('extracts a route({}) with a string method and body schema', () => {
    const dir = scratch(`
      const fastify = require('fastify')();
      function h(req, reply) { return {}; }
      fastify.route({
        method: 'PUT',
        url: '/things/:id',
        schema: { body: { type: 'object', properties: { name: { type: 'string' } } } },
        handler: h,
      });
    `);

    const put = extractFastifyRoutes(dir).find((t) => t.method === 'PUT' && t.path === '/things/:id');
    expect(put).toBeDefined();
    expect(put!.name).toBe('put_things_id');
    expect(put!.toolId).toBe('e49f23267391');
    expect(put!.inputSchemaConfidence).toBe('introspected');
    expect(put!.inputSchema.properties?.name).toEqual({ type: 'string' });
  });

  it('emits one route per method when method is an array', () => {
    const dir = scratch(`
      const fastify = require('fastify')();
      function h(req, reply) { return {}; }
      fastify.route({
        method: ['GET', 'POST'],
        url: '/things',
        handler: h,
      });
    `);

    const tools = extractFastifyRoutes(dir);
    const keys = tools.map((t) => `${t.method} ${t.path}`).sort();
    expect(keys).toEqual(['GET /things', 'POST /things']);
  });

  it('applies method-aware schema selection in route({}) (array method)', () => {
    const dir = scratch(`
      const fastify = require('fastify')();
      function h(req, reply) { return {}; }
      fastify.route({
        method: ['GET', 'POST'],
        url: '/things',
        schema: {
          querystring: { type: 'object', properties: { q: { type: 'string' } } },
          body: { type: 'object', properties: { name: { type: 'string' } } },
        },
        handler: h,
      });
    `);

    const tools = extractFastifyRoutes(dir);
    const get = tools.find((t) => t.method === 'GET' && t.path === '/things');
    const post = tools.find((t) => t.method === 'POST' && t.path === '/things');

    // GET introspects querystring; POST introspects body — no cross-contamination.
    expect(get!.inputSchemaConfidence).toBe('introspected');
    expect(get!.inputSchema.properties?.q).toEqual({ type: 'string' });
    expect(get!.inputSchema.properties?.name).toBeUndefined();

    expect(post!.inputSchemaConfidence).toBe('introspected');
    expect(post!.inputSchema.properties?.name).toEqual({ type: 'string' });
    expect(post!.inputSchema.properties?.q).toBeUndefined();
  });
});

describe('fastify name de-duplication', () => {
  it('suffixes colliding bare names while keeping distinct toolIds', () => {
    // Two shorthand + one route() form all resolving to base name get_things.
    const dir = scratch(`
      const fastify = require('fastify')();
      function h(req, reply) { return {}; }
      fastify.get('/things', h);
      fastify.get('/things', h);
    `);

    const tools = extractFastifyRoutes(dir).filter((t) => t.path === '/things' && t.method === 'GET');
    expect(tools).toHaveLength(2);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_things', 'get_things_2']);
    // Same (method, path) → identical toolId (the stable cluster key).
    expect(tools[0].toolId).toBe(tools[1].toolId);
  });
});

describe('fastify-app fixture extraction', () => {
  const FIXTURE = resolve(import.meta.dirname, '../../../fixtures/fastify-app');

  it('discovers every MUST_DISCOVER route', () => {
    const must = JSON.parse(
      readFileSync(resolve(FIXTURE, 'MUST_DISCOVER.json'), 'utf-8')
    ) as { routes: string[] };
    const tools = extractFastifyRoutes(FIXTURE);
    const discovered = new Set(tools.map((t) => `${t.method} ${t.path}`));
    for (const route of must.routes) {
      expect(discovered.has(route), `Missing route: ${route}`).toBe(true);
    }
  });

  it('introspects schemas from the fixture (shorthand + route() forms)', () => {
    const tools = extractFastifyRoutes(FIXTURE);
    const getItems = tools.find((t) => t.method === 'GET' && t.path === '/api/items');
    const postItems = tools.find((t) => t.method === 'POST' && t.path === '/api/items');
    const getUser = tools.find((t) => t.method === 'GET' && t.path === '/users/:id');
    const putItem = tools.find((t) => t.method === 'PUT' && t.path === '/api/items/:id');
    const delItem = tools.find((t) => t.method === 'DELETE' && t.path === '/api/items/:id');

    expect(getItems!.toolId).toBe('b05eaf6e57c0');
    expect(getItems!.inputSchemaConfidence).toBe('introspected');
    expect(getItems!.inputSchema.properties?.limit).toEqual({ type: 'integer', minimum: 1, maximum: 100 });

    expect(postItems!.toolId).toBe('d9bcc28ada87');
    expect(postItems!.inputSchemaConfidence).toBe('introspected');
    expect(postItems!.inputSchema.required).toEqual(['name', 'price']);

    expect(getUser!.toolId).toBe('26632e4f2787');
    expect(getUser!.inputSchemaConfidence).toBe('unknown');

    expect(putItem!.toolId).toBe('b45023fe14ce');
    expect(putItem!.inputSchemaConfidence).toBe('introspected');
    expect(putItem!.inputSchema.properties?.name).toEqual({ type: 'string' });

    expect(delItem!.toolId).toBe('a8bdd5e7a7ea');
    expect(delItem!.inputSchemaConfidence).toBe('unknown');
  });
});
