import { describe, it, expect } from 'vitest';
import { extractNestjsRoutes } from './routes.js';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const FIXTURES = resolve(import.meta.dirname, '../../../fixtures');

function loadMustDiscover(fixture: string): { routes?: string[] } {
  const path = resolve(FIXTURES, fixture, 'MUST_DISCOVER.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as { routes?: string[] };
}

function routeKey(tool: { method: string; path: string }): string {
  return `${tool.method} ${tool.path}`;
}

describe('nestjs route extraction', () => {
  const root = resolve(FIXTURES, 'nestjs-app');

  it('discovers all must-discover routes', () => {
    const tools = extractNestjsRoutes(root);
    const must = loadMustDiscover('nestjs-app');
    const discovered = new Set(tools.map(routeKey));
    for (const route of must.routes ?? []) {
      expect(discovered.has(route), `Missing route: ${route}`).toBe(true);
    }
  });

  it('composes controller prefix + method path (prefixed and prefix-less)', () => {
    const tools = extractNestjsRoutes(root);
    // Prefixed controller: @Controller('items') + @Get() -> /items
    const getItems = tools.find((t) => t.method === 'GET' && t.path === '/items');
    expect(getItems).toBeDefined();
    expect(getItems!.name).toBe('get_items');
    expect(getItems!.toolId).toBe('df0a23d36435');
    // Prefix-less controller: @Controller() + @Get('health') -> /health
    const getHealth = tools.find((t) => t.method === 'GET' && t.path === '/health');
    expect(getHealth).toBeDefined();
    expect(getHealth!.name).toBe('get_health');
    expect(getHealth!.toolId).toBe('389ff1e1c9e3');
  });

  it('preserves Express-style :id params in the composed route', () => {
    const tools = extractNestjsRoutes(root);
    const getOne = tools.find((t) => t.method === 'GET' && t.path === '/items/:id');
    expect(getOne).toBeDefined();
    expect(getOne!.name).toBe('get_items_id');
    expect(getOne!.toolId).toBe('a23d986fb7da');
  });

  it('recognizes each HTTP-method decorator', () => {
    const tools = extractNestjsRoutes(root);
    const byKey = new Map(tools.map((t) => [routeKey(t), t]));
    expect(byKey.get('GET /items')?.sideEffectClass).toBe('safe');
    expect(byKey.get('POST /items')?.sideEffectClass).toBe('mutating');
    expect(byKey.get('PUT /items/:id')?.sideEffectClass).toBe('mutating');
    expect(byKey.get('DELETE /items/:id')?.sideEffectClass).toBe('mutating');
  });

  it('expands @All() into GET + POST for the same path', () => {
    const tools = extractNestjsRoutes(root);
    const getPing = tools.find((t) => t.method === 'GET' && t.path === '/ping');
    const postPing = tools.find((t) => t.method === 'POST' && t.path === '/ping');
    expect(getPing?.toolId).toBe('09462839b608');
    expect(postPing?.toolId).toBe('43d79257bead');
    expect(getPing?.sideEffectClass).toBe('safe');
    expect(postPing?.sideEffectClass).toBe('mutating');
  });

  it('introspects @Body() DTO into a JSON Schema (POST /items)', () => {
    const tools = extractNestjsRoutes(root);
    const post = tools.find((t) => t.method === 'POST' && t.path === '/items');
    expect(post).toBeDefined();
    expect(post!.toolId).toBe('e2bba8fccfa3');
    expect(post!.inputSchemaConfidence).toBe('introspected');
    expect(post!.inputSchema).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        price: { type: 'integer' },
        category: { type: 'string' },
        inStock: { type: 'boolean' },
      },
      required: ['name', 'price'],
    });
  });

  it('marks all-optional @Body() DTOs with no required array (PUT /items/:id)', () => {
    const tools = extractNestjsRoutes(root);
    const put = tools.find((t) => t.method === 'PUT' && t.path === '/items/:id');
    expect(put!.inputSchemaConfidence).toBe('introspected');
    expect(put!.inputSchema.properties?.name).toEqual({ type: 'string' });
    expect(put!.inputSchema.properties?.price).toEqual({ type: 'integer' });
    expect(put!.inputSchema.required).toBeUndefined();
  });

  it('introspects @Query() DTO for safe methods (GET /items/search)', () => {
    const tools = extractNestjsRoutes(root);
    const search = tools.find((t) => t.method === 'GET' && t.path === '/items/search');
    expect(search!.inputSchemaConfidence).toBe('introspected');
    expect(search!.inputSchema.properties?.q).toEqual({ type: 'string' });
    expect(search!.inputSchema.properties?.limit).toEqual({ type: 'integer' });
    expect(search!.inputSchema.required).toBeUndefined();
  });

  it('falls back to an open object with unknown confidence when no body/query DTO (DELETE)', () => {
    const tools = extractNestjsRoutes(root);
    const del = tools.find((t) => t.method === 'DELETE' && t.path === '/items/:id');
    expect(del!.inputSchemaConfidence).toBe('unknown');
    expect(del!.inputSchema).toEqual({ type: 'object', additionalProperties: true });
  });

  it('emits posix sourceFile, valid tool names, and unique toolIds', () => {
    const tools = extractNestjsRoutes(root);
    for (const t of tools) {
      expect(t.sourceFile, `backslash in sourceFile: ${t.sourceFile}`).not.toContain('\\');
      expect(t.name, `bad tool name: ${t.name}`).toMatch(/^[a-z0-9_]+$/);
      expect(t.isServerAction).toBe(false);
    }
    const ids = tools.map((t) => t.toolId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
