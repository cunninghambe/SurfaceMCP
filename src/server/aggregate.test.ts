import { describe, it, expect } from 'vitest';
import { buildAggregateCatalog, buildSurfaceListResponse } from './registry.js';
import type { SurfaceRegistry, SurfaceRuntime, ToolMeta, SurfaceConfig } from '../types.js';
import { RoleMutex } from '../auth/role-mutex.js';

function makeSurface(name: string): SurfaceConfig {
  return { name, stack: 'openapi', root: '.', baseUrl: 'http://localhost:5000', port: 3140, auth: { kind: 'none' }, roles: [] };
}

function makeTool(bareName: string, surfaceName: string): ToolMeta {
  return {
    name: `${surfaceName}:${bareName}`,
    bareName,
    surface: surfaceName,
    toolId: `${surfaceName}_${bareName}`,
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

function readyRuntime(name: string, toolCount: number): SurfaceRuntime {
  const surface = makeSurface(name);
  const tools = Array.from({ length: toolCount }, (_, i) => makeTool(`tool_${i}`, name));
  return {
    surface,
    resolvedRoot: '/tmp',
    state: { kind: 'ready' },
    catalog: { revision: 3, tools },
    pageCatalog: { revision: 0, pages: [], skips: [] },
    navigationCatalog: { revision: 0, navigations: [], skips: [] },
    roleMutex: new RoleMutex(surface.baseUrl, surface.auth, surface.roles),
  };
}

function failedRuntime(name: string): SurfaceRuntime {
  const surface = makeSurface(name);
  return {
    surface,
    resolvedRoot: '/tmp',
    state: { kind: 'failed', phase: 'extract', error: 'openapi.json not found' },
    catalog: { revision: 0, tools: [] },
    pageCatalog: { revision: 0, pages: [], skips: [] },
    navigationCatalog: { revision: 0, navigations: [], skips: [] },
    roleMutex: undefined,
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

describe('buildAggregateCatalog', () => {
  it('sums tools from all ready surfaces', () => {
    const registry = makeRegistry([readyRuntime('api', 3), readyRuntime('spa', 2)]);
    const result = buildAggregateCatalog(registry);
    expect(result.tools).toHaveLength(5);
    expect(result.revision).toBe(6); // 3 + 3
  });

  it('excludes tools from failed surfaces', () => {
    const registry = makeRegistry([readyRuntime('api', 3), failedRuntime('broken')]);
    const result = buildAggregateCatalog(registry);
    expect(result.tools).toHaveLength(3);
  });

  it('excludes tools from extracting surfaces', () => {
    const surface = makeSurface('pending');
    const runtime: SurfaceRuntime = {
      surface,
      resolvedRoot: '/tmp',
      state: { kind: 'extracting' },
      catalog: { revision: 0, tools: [makeTool('foo', 'pending')] },
      pageCatalog: { revision: 0, pages: [], skips: [] },
      navigationCatalog: { revision: 0, navigations: [], skips: [] },
      roleMutex: undefined,
    };
    const registry = makeRegistry([readyRuntime('api', 2), runtime]);
    const result = buildAggregateCatalog(registry);
    expect(result.tools).toHaveLength(2);
    expect(result.tools.every((t) => t.surface === 'api')).toBe(true);
  });

  it('returns surfaceRevisions map', () => {
    const registry = makeRegistry([readyRuntime('api', 2), readyRuntime('spa', 1)]);
    const result = buildAggregateCatalog(registry);
    expect(result.surfaceRevisions['api']).toBe(3);
    expect(result.surfaceRevisions['spa']).toBe(3);
  });

  it('filters by surface name', () => {
    const registry = makeRegistry([readyRuntime('api', 3), readyRuntime('spa', 2)]);
    const result = buildAggregateCatalog(registry, { surface: 'api' });
    expect(result.tools).toHaveLength(3);
    expect(result.tools.every((t) => t.surface === 'api')).toBe(true);
  });
});

describe('buildSurfaceListResponse', () => {
  it('includes all surfaces regardless of state', () => {
    const registry = makeRegistry([readyRuntime('api', 3), failedRuntime('broken')]);
    const response = buildSurfaceListResponse(registry);
    expect(response.surfaces).toHaveLength(2);
    expect(response.surfaces[0]!.name).toBe('api');
    expect(response.surfaces[1]!.name).toBe('broken');
  });

  it('reports correct toolCount for ready surfaces', () => {
    const registry = makeRegistry([readyRuntime('api', 5)]);
    const response = buildSurfaceListResponse(registry);
    expect(response.surfaces[0]!.toolCount).toBe(5);
    expect(response.surfaces[0]!.state.kind).toBe('ready');
  });

  it('reports zero toolCount and failed state for failed surfaces', () => {
    const registry = makeRegistry([failedRuntime('broken')]);
    const response = buildSurfaceListResponse(registry);
    expect(response.surfaces[0]!.toolCount).toBe(0);
    expect(response.surfaces[0]!.state.kind).toBe('failed');
    if (response.surfaces[0]!.state.kind === 'failed') {
      expect(response.surfaces[0]!.state.error).toContain('openapi.json not found');
    }
  });

  it('includes surfaceMcpVersion', () => {
    const registry = makeRegistry([readyRuntime('api', 1)]);
    const response = buildSurfaceListResponse(registry);
    expect(typeof response.surfaceMcpVersion).toBe('string');
    expect(response.surfaceMcpVersion.length).toBeGreaterThan(0);
  });
});
