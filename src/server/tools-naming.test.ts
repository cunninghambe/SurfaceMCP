import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { SurfaceRuntime } from '../types.js';

// Replicate toolId logic (pre-prefix, as used in extractors)
function rawToolId(method: string, path: string): string {
  return createHash('sha1').update(`${method}:${path}`).digest('hex').slice(0, 12);
}

// Replicate prefixed toolId logic from tools-meta.ts
function prefixedToolId(surfaceName: string, method: string, path: string): string {
  return createHash('sha1').update(`${surfaceName}:${method}:${path}`).digest('hex').slice(0, 12);
}

describe('tool naming and collision', () => {
  it('toolId is stable sha1 hash', () => {
    const id1 = rawToolId('GET', '/api/users');
    const id2 = rawToolId('GET', '/api/users');
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{12}$/);
  });

  it('different method+path produces different toolId', () => {
    expect(rawToolId('GET', '/api/users')).not.toBe(rawToolId('POST', '/api/users'));
    expect(rawToolId('GET', '/api/users')).not.toBe(rawToolId('GET', '/api/products'));
  });

  it('name collision deduplication: two routes resolving to same name get distinct names', async () => {
    // Simulate two routes that would produce the same name
    // We test the extract module's dedup logic
    const { extractNextjsRoutes } = await import('../extract/nextjs/routes.js');
    const { resolve } = await import('node:path');

    const root = resolve(import.meta.dirname, '../../fixtures/nextjs-app');
    const tools = await extractNextjsRoutes(root);

    // All names must be unique
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});

describe('surface prefix + toolId', () => {
  it('prefixed toolId is stable for given (surface, method, path)', () => {
    const id1 = prefixedToolId('self-api', 'GET', '/api/users');
    const id2 = prefixedToolId('self-api', 'GET', '/api/users');
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{12}$/);
  });

  it('prefixed toolId differs across surfaces for the same route', () => {
    const id1 = prefixedToolId('self-api', 'GET', '/api/users');
    const id2 = prefixedToolId('idor-bad', 'GET', '/api/users');
    expect(id1).not.toBe(id2);
  });

  it('prefixed toolId differs from unprefixed toolId', () => {
    const unprefixed = rawToolId('GET', '/api/users');
    const prefixed = prefixedToolId('self-api', 'GET', '/api/users');
    expect(unprefixed).not.toBe(prefixed);
  });

  it('tool name has surface prefix in multi-surface config', async () => {
    const { regenerateCatalog } = await import('./tools-meta.js');
    const { resolve } = await import('node:path');
    const { RoleMutex } = await import('../auth/role-mutex.js');

    const root = resolve(import.meta.dirname, '../../fixtures/express-app');
    const surface = {
      name: 'test-api',
      stack: 'express' as const,
      root: '.',
      baseUrl: 'http://localhost:3200',
      port: 3140 as const,
      auth: { kind: 'none' as const },
      roles: [],
    };
    const runtime: SurfaceRuntime = {
      surface,
      resolvedRoot: root,
      state: { kind: 'extracting' },
      catalog: { revision: 0, tools: [] },
      pageCatalog: { revision: 0, pages: [], skips: [] },
      navigationCatalog: { revision: 0, navigations: [], skips: [] },
      roleMutex: new RoleMutex(surface.baseUrl, surface.auth, surface.roles),
    };

    await regenerateCatalog(runtime, root, true);
    expect(runtime.catalog.tools.length).toBeGreaterThan(0);
    for (const tool of runtime.catalog.tools) {
      expect(tool.name).toMatch(/^test-api:/);
      expect(tool.bareName).not.toContain(':');
      expect(tool.surface).toBe('test-api');
    }
  });

  it('tool name is bare (no prefix) in single-surface config', async () => {
    const { regenerateCatalog } = await import('./tools-meta.js');
    const { resolve } = await import('node:path');
    const { RoleMutex } = await import('../auth/role-mutex.js');

    const root = resolve(import.meta.dirname, '../../fixtures/express-app');
    const surface = {
      name: 'test-api',
      stack: 'express' as const,
      root: '.',
      baseUrl: 'http://localhost:3200',
      port: 3140 as const,
      auth: { kind: 'none' as const },
      roles: [],
    };
    const runtime: SurfaceRuntime = {
      surface,
      resolvedRoot: root,
      state: { kind: 'extracting' },
      catalog: { revision: 0, tools: [] },
      pageCatalog: { revision: 0, pages: [], skips: [] },
      navigationCatalog: { revision: 0, navigations: [], skips: [] },
      roleMutex: new RoleMutex(surface.baseUrl, surface.auth, surface.roles),
    };

    await regenerateCatalog(runtime, root, false);
    expect(runtime.catalog.tools.length).toBeGreaterThan(0);
    for (const tool of runtime.catalog.tools) {
      expect(tool.name).not.toContain(':');
      expect(tool.bareName).toBe(tool.name);
    }
  });
});

describe('surface-scoped toolId for tRPC procedures', () => {
  async function buildTrpcCatalog(trpcPath?: string) {
    const { regenerateCatalog } = await import('./tools-meta.js');
    const { resolve } = await import('node:path');
    const { RoleMutex } = await import('../auth/role-mutex.js');

    const root = resolve(import.meta.dirname, '../../fixtures/trpc-app');
    const surface = {
      name: 'test-api',
      stack: 'trpc' as const,
      root: '.',
      baseUrl: 'http://localhost:3200',
      port: 3140 as const,
      ...(trpcPath ? { trpcPath } : {}),
      auth: { kind: 'none' as const },
      roles: [],
    };
    const runtime: SurfaceRuntime = {
      surface,
      resolvedRoot: root,
      state: { kind: 'extracting' },
      catalog: { revision: 0, tools: [] },
      pageCatalog: { revision: 0, pages: [], skips: [] },
      navigationCatalog: { revision: 0, navigations: [], skips: [] },
      roleMutex: new RoleMutex(surface.baseUrl, surface.auth, surface.roles),
    };
    await regenerateCatalog(runtime, root, false);
    return runtime;
  }

  it('does not collide procedures that share the single mount path', async () => {
    const runtime = await buildTrpcCatalog();
    const tools = runtime.catalog.tools;
    expect(tools.length).toBeGreaterThan(1);
    // Every query shares `GET /api/trpc`, so a method:path-keyed surface id would
    // collapse them; the procedure-keyed branch keeps them distinct.
    expect(new Set(tools.map((t) => t.toolId)).size).toBe(tools.length);
    for (const tool of tools) {
      expect(tool.path).toBe('/api/trpc');
      expect(tool.toolId).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it('keeps the extractor side-effect classes through the call-graph pass', async () => {
    const runtime = await buildTrpcCatalog();
    for (const tool of runtime.catalog.tools) {
      expect(tool.sideEffectClass).toBe(tool.trpc?.procedureType === 'query' ? 'safe' : 'mutating');
    }
  });

  it('threads surface.trpcPath into every tool path, leaving toolIds untouched', async () => {
    const withDefault = await buildTrpcCatalog();
    const withCustom = await buildTrpcCatalog('/trpc');
    expect(withCustom.catalog.tools.every((t) => t.path === '/trpc')).toBe(true);
    expect(withCustom.catalog.tools.map((t) => t.toolId)).toEqual(
      withDefault.catalog.tools.map((t) => t.toolId)
    );
  });
});
