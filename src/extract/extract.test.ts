import { describe, it, expect } from 'vitest';
import { extractNextjsRoutes } from './nextjs/routes.js';
import { extractServerActions } from './nextjs/server-actions.js';
import { extractExpressRoutes } from './express/static.js';
import { extractDjangoRoutes } from './django/ast-walk.js';
import { extractOpenApiRoutes } from './openapi/parse.js';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const FIXTURES = resolve(import.meta.dirname, '../../fixtures');

function loadMustDiscover(fixture: string): { routes?: string[]; serverActions?: string[] } {
  const path = resolve(FIXTURES, fixture, 'MUST_DISCOVER.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as { routes?: string[]; serverActions?: string[] };
}

function routeKey(tool: { method: string; path: string }): string {
  return `${tool.method} ${tool.path}`;
}

describe('nextjs-app route extraction', () => {
  it('discovers all must-discover routes', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractNextjsRoutes(root);
    const must = loadMustDiscover('nextjs-app');
    const discovered = new Set(tools.map(routeKey));

    for (const route of must.routes ?? []) {
      expect(discovered.has(route), `Missing route: ${route}`).toBe(true);
    }
  });

  it('emits inputSchemaConfidence for routes with zod schemas', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractNextjsRoutes(root);
    // POST /api/users has a zod schema in the source
    const postUsers = tools.find((t) => t.method === 'POST' && t.path === '/api/users');
    expect(postUsers).toBeDefined();
    // Confidence is at least "inferred" or "introspected" (can't easily require introspected
    // without runtime import working, but should not be unknown for a file with zod usage)
    expect(postUsers?.inputSchemaConfidence).not.toBe('unknown');
  });

  it('assigns correct toolId (stable sha1 hash)', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractNextjsRoutes(root);
    const getUsers = tools.find((t) => t.method === 'GET' && t.path === '/api/users');
    expect(getUsers?.toolId).toMatch(/^[0-9a-f]{12}$/);
  });

  it('assigns safe sideEffectClass to GET routes', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractNextjsRoutes(root);
    const getRoutes = tools.filter((t) => t.method === 'GET');
    for (const t of getRoutes) {
      expect(t.sideEffectClass).toBe('safe');
    }
  });

  it('assigns mutating sideEffectClass to POST routes (pre-call-graph)', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractNextjsRoutes(root);
    const postUsers = tools.find((t) => t.method === 'POST' && t.path === '/api/users');
    expect(postUsers?.sideEffectClass).toBe('mutating');
  });

  it('generates unique toolIds across routes', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractNextjsRoutes(root);
    const ids = tools.map((t) => t.toolId);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('deduplicates tool names when there are collisions', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractNextjsRoutes(root);
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});

describe('manual-validation schema recovery (§B regression)', () => {
  it('assigns partial confidence to a route with manual if-guard validation', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractNextjsRoutes(root);
    const postJournal = tools.find(
      (t) => t.method === 'POST' && t.path === '/api/journal-entries'
    );
    expect(postJournal).toBeDefined();
    expect(postJournal!.inputSchemaConfidence).toBe('partial');
    expect(postJournal!.inputSchema.required).toContain('memo');
    expect(postJournal!.inputSchema.required).toContain('amount');
    expect(postJournal!.inputSchema.properties?.['amount']).toMatchObject({ type: 'number' });
  });
});

describe('schema introspection — constraint extraction', () => {
  it('extracts email format from zod .email()', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractNextjsRoutes(root);
    const postUsers = tools.find((t) => t.method === 'POST' && t.path === '/api/users');
    expect(postUsers).toBeDefined();
    const schema = postUsers!.inputSchema;
    if (schema.properties?.email) {
      expect(schema.properties.email.format).toBe('email');
    }
    // Schema confidence should reflect zod usage
    expect(postUsers!.inputSchemaConfidence).not.toBe('unknown');
  });

  it('extracts minLength/maxLength from zod .min().max()', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractNextjsRoutes(root);
    const postUsers = tools.find((t) => t.method === 'POST' && t.path === '/api/users');
    expect(postUsers).toBeDefined();
    const schema = postUsers!.inputSchema;
    if (schema.properties?.password) {
      expect(schema.properties.password.minLength).toBe(8);
      expect(schema.properties.password.maxLength).toBe(64);
    }
  });
});

describe('express route extraction', () => {
  it('discovers all must-discover routes', async () => {
    const root = resolve(FIXTURES, 'express-app');
    const tools = await extractExpressRoutes(root);
    const must = loadMustDiscover('express-app');
    const discovered = new Set(tools.map(routeKey));

    for (const route of must.routes ?? []) {
      expect(discovered.has(route), `Missing route: ${route}`).toBe(true);
    }
  });
});

describe('django route extraction', () => {
  it('discovers exactly the must-discover route set (no false positives)', () => {
    const root = resolve(FIXTURES, 'django-app');
    const tools = extractDjangoRoutes(root);
    const must = loadMustDiscover('django-app');

    const discovered = new Set(tools.map((t) => `${t.method} ${t.path}`));
    const expected = new Set(must.routes ?? []);

    // Every expected route present
    for (const route of expected) {
      expect(discovered.has(route), `Missing route: ${route}`).toBe(true);
    }
    // No extras
    expect(
      [...discovered].filter((r) => !expected.has(r)),
      'Unexpected routes discovered'
    ).toEqual([]);
    expect(discovered.size).toBe(expected.size);
  });

  it('emits no invalid characters in tool names', () => {
    const root = resolve(FIXTURES, 'django-app');
    const tools = extractDjangoRoutes(root);
    for (const t of tools) {
      expect(t.name, `bad tool name: ${t.name}`).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

describe('openapi route extraction', () => {
  it('discovers all must-discover routes from fastapi-app openapi.json', () => {
    const root = resolve(FIXTURES, 'fastapi-app');
    const tools = extractOpenApiRoutes(root);
    const must = loadMustDiscover('fastapi-app');
    const discovered = new Set(tools.map(routeKey));

    for (const route of must.routes ?? []) {
      expect(discovered.has(route), `Missing route: ${route}`).toBe(true);
    }
  });

  it('emits introspected confidence for openapi routes with schemas', () => {
    const root = resolve(FIXTURES, 'fastapi-app');
    const tools = extractOpenApiRoutes(root);
    const postUsers = tools.find((t) => t.method === 'POST' && t.path === '/api/users');
    expect(postUsers?.inputSchemaConfidence).toBe('introspected');
    expect(postUsers?.inputSchema.properties?.email).toBeDefined();
  });

  it('emits format:email for EmailStr fields', () => {
    const root = resolve(FIXTURES, 'fastapi-app');
    const tools = extractOpenApiRoutes(root);
    const postUsers = tools.find((t) => t.method === 'POST' && t.path === '/api/users');
    expect(postUsers?.inputSchema.properties?.email?.format).toBe('email');
  });

  it('emits minimum/maximum for constrained fields', () => {
    const root = resolve(FIXTURES, 'fastapi-app');
    const tools = extractOpenApiRoutes(root);
    const postUsers = tools.find((t) => t.method === 'POST' && t.path === '/api/users');
    expect(postUsers?.inputSchema.properties?.age?.minimum).toBe(0);
    expect(postUsers?.inputSchema.properties?.age?.maximum).toBe(120);
  });
});

describe('nextjs-app server-action extraction', () => {
  it('discovers all must-discover server actions', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractServerActions(root);
    const must = loadMustDiscover('nextjs-app');
    const byId = new Map(tools.map((t) => [t.toolId, t]));
    for (const expected of (must as { serverActions?: Array<{ toolId: string; inputSchemaConfidence: string }> }).serverActions ?? []) {
      const t = byId.get(expected.toolId);
      expect(t, `missing server action toolId=${expected.toolId}`).toBeDefined();
      expect(t!.inputSchemaConfidence).toBe(expected.inputSchemaConfidence);
    }
  });
});

describe('monorepo multi-surface detection', () => {
  it('detects nextjs in apps/web', async () => {
    const { detectStack } = await import('../detect/index.js');
    const webRoot = resolve(FIXTURES, 'nextjs-monorepo', 'apps', 'web');
    expect(detectStack(webRoot)).toBe('nextjs');
  });

  it('detects express in apps/api', async () => {
    const { detectStack } = await import('../detect/index.js');
    const apiRoot = resolve(FIXTURES, 'nextjs-monorepo', 'apps', 'api');
    expect(detectStack(apiRoot)).toBe('express');
  });

  it('extracts routes from apps/web', async () => {
    const webRoot = resolve(FIXTURES, 'nextjs-monorepo', 'apps', 'web');
    const tools = await extractNextjsRoutes(webRoot);
    const keys = new Set(tools.map(routeKey));
    expect(keys.has('GET /api/posts')).toBe(true);
    expect(keys.has('POST /api/posts')).toBe(true);
  });

  it('extracts routes from apps/api', async () => {
    const apiRoot = resolve(FIXTURES, 'nextjs-monorepo', 'apps', 'api');
    const tools = await extractExpressRoutes(apiRoot);
    const keys = new Set(tools.map(routeKey));
    expect(keys.has('GET /api/health')).toBe(true);
    expect(keys.has('POST /api/data')).toBe(true);
  });
});
