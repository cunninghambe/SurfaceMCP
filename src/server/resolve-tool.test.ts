import { describe, it, expect } from 'vitest';
import { resolveTool } from './registry.js';
import type { SurfaceRegistry, SurfaceRuntime, ToolMeta, SurfaceConfig } from '../types.js';
import { RoleMutex } from '../auth/role-mutex.js';

function makeSurfaceConfig(name: string): SurfaceConfig {
  return {
    name,
    stack: 'openapi',
    root: '.',
    baseUrl: 'http://localhost:5000',
    port: 3140,
    auth: { kind: 'none' },
    roles: [],
  };
}

function makeTool(bareName: string, surfaceName: string, multiSurface = false): ToolMeta {
  return {
    name: multiSurface ? `${surfaceName}:${bareName}` : bareName,
    bareName,
    surface: surfaceName,
    toolId: `toolid_${surfaceName}_${bareName}`,
    method: 'GET',
    path: `/api/${bareName}`,
    inputSchema: { type: 'object' },
    inputSchemaConfidence: 'unknown',
    sideEffectClass: 'safe',
    sourceFile: 'spec.json',
    sourceLine: 0,
    isServerAction: false,
  };
}

function makeRuntime(surfaceName: string, tools: ToolMeta[]): SurfaceRuntime {
  const surface = makeSurfaceConfig(surfaceName);
  return {
    surface,
    resolvedRoot: '/tmp',
    state: { kind: 'ready' },
    catalog: { revision: 1, tools },
    pageCatalog: { revision: 0, pages: [], skips: [] },
    navigationCatalog: { revision: 0, navigations: [], skips: [] },
    roleMutex: new RoleMutex(surface.baseUrl, surface.auth, surface.roles),
  };
}

function makeRegistry(runtimes: SurfaceRuntime[]): SurfaceRegistry {
  const surfaces = new Map<string, SurfaceRuntime>();
  const order: string[] = [];
  for (const rt of runtimes) {
    surfaces.set(rt.surface.name, rt);
    order.push(rt.surface.name);
  }
  return { surfaces, order };
}

describe('resolveTool — single-surface (back-compat)', () => {
  const tool = makeTool('get_users', 'api');
  const registry = makeRegistry([makeRuntime('api', [tool])]);

  it('resolves bare name in single-surface registry', () => {
    const result = resolveTool(registry, { name: 'get_users' });
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.tool.bareName).toBe('get_users');
      expect(result.runtime.surface.name).toBe('api');
    }
  });

  it('resolves prefixed name in single-surface registry', () => {
    const toolPrefixed = makeTool('get_users', 'api', false);
    toolPrefixed.name = 'api:get_users'; // simulate prefixed name
    const reg2 = makeRegistry([makeRuntime('api', [toolPrefixed])]);
    const result = resolveTool(reg2, { name: 'api:get_users' });
    expect('error' in result).toBe(false);
  });

  it('returns not_found for unknown tool', () => {
    const result = resolveTool(registry, { name: 'get_orders' });
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.code).toBe('not_found');
  });
});

describe('resolveTool — multi-surface', () => {
  const apiTool = makeTool('get_users', 'self-api', true);
  const spaTool = makeTool('get_profile', 'self-spa', true);
  const sharedTool1 = makeTool('get_items', 'self-api', true);
  const sharedTool2 = makeTool('get_items', 'self-spa', true);

  const registry = makeRegistry([
    makeRuntime('self-api', [apiTool, sharedTool1]),
    makeRuntime('self-spa', [spaTool, sharedTool2]),
  ]);

  it('resolves prefixed name to correct surface', () => {
    const result = resolveTool(registry, { name: 'self-api:get_users' });
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.runtime.surface.name).toBe('self-api');
      expect(result.tool.bareName).toBe('get_users');
    }
  });

  it('resolves prefixed name for second surface', () => {
    const result = resolveTool(registry, { name: 'self-spa:get_profile' });
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.runtime.surface.name).toBe('self-spa');
    }
  });

  it('returns bare_name_ambiguous for bare name in multi-surface config', () => {
    const result = resolveTool(registry, { name: 'get_items' });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.code).toBe('bare_name_ambiguous');
      if (result.error.code === 'bare_name_ambiguous') {
        expect(result.error.candidates).toContain('self-api:get_items');
        expect(result.error.candidates).toContain('self-spa:get_items');
      }
    }
  });

  it('returns bare_name_ambiguous even if only one surface matches', () => {
    const result = resolveTool(registry, { name: 'get_users' });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.code).toBe('bare_name_ambiguous');
      if (result.error.code === 'bare_name_ambiguous') {
        expect(result.error.candidates).toHaveLength(1);
        expect(result.error.candidates[0]).toBe('self-api:get_users');
      }
    }
  });

  it('returns unknown_surface for unknown surface prefix', () => {
    const result = resolveTool(registry, { name: 'ghost:get_users' });
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.code).toBe('unknown_surface');
  });
});

describe('resolveTool — toolId scan', () => {
  const tool1 = makeTool('get_users', 'self-api', true);
  const tool2 = makeTool('get_orders', 'self-spa', true);
  const registry = makeRegistry([
    makeRuntime('self-api', [tool1]),
    makeRuntime('self-spa', [tool2]),
  ]);

  it('resolves toolId by scanning all surfaces', () => {
    const result = resolveTool(registry, { toolId: tool2.toolId });
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.runtime.surface.name).toBe('self-spa');
    }
  });

  it('returns not_found for unknown toolId', () => {
    const result = resolveTool(registry, { toolId: 'deadbeef1234' });
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.code).toBe('not_found');
  });
});

describe('resolveTool — surface_not_ready', () => {
  it('returns surface_not_ready when surface is extracting', () => {
    const tool = makeTool('get_users', 'api', true);
    const surface = makeSurfaceConfig('api');
    const runtime: SurfaceRuntime = {
      surface,
      resolvedRoot: '/tmp',
      state: { kind: 'extracting' },
      catalog: { revision: 0, tools: [tool] },
      pageCatalog: { revision: 0, pages: [], skips: [] },
      navigationCatalog: { revision: 0, navigations: [], skips: [] },
      roleMutex: undefined,
    };
    const registry = makeRegistry([runtime]);
    const result = resolveTool(registry, { name: 'api:get_users' });
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.code).toBe('surface_not_ready');
  });
});
