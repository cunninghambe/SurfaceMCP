import { describe, it, expect } from 'vitest';
import { resolveRuntime } from './http.js';
import type { SurfaceRegistry, SurfaceRuntime } from '../types.js';

function runtime(name: string): SurfaceRuntime {
  return {
    surface: { name } as SurfaceRuntime['surface'],
    resolvedRoot: '/x',
    state: { kind: 'ready' },
    catalog: { revision: 1, tools: [] },
    pageCatalog: { revision: 1, pages: [], skips: [] },
    navigationCatalog: { revision: 1, navigations: [], skips: [] },
    roleMutex: undefined,
  };
}

function registry(names: string[]): SurfaceRegistry {
  return { surfaces: new Map(names.map((n) => [n, runtime(n)])), order: names };
}

describe('resolveRuntime', () => {
  it('defaults to the sole surface when there is exactly one and no arg', () => {
    const r = resolveRuntime(registry(['web']));
    expect('error' in r).toBe(false);
    expect((r as SurfaceRuntime).surface.name).toBe('web');
  });

  it('rejects a no-arg call in a multi-surface config (no silent first-surface pick)', () => {
    const r = resolveRuntime(registry(['web', 'api']));
    expect('error' in r).toBe(true);
    expect((r as { error: string }).error).toContain('Specify surface');
    expect((r as { error: string }).error).toContain('web, api');
  });

  it('resolves an explicit surface arg in a multi-surface config', () => {
    const r = resolveRuntime(registry(['web', 'api']), 'api');
    expect('error' in r).toBe(false);
    expect((r as SurfaceRuntime).surface.name).toBe('api');
  });

  it('rejects an unknown surface arg', () => {
    const r = resolveRuntime(registry(['web']), 'nope');
    expect('error' in r).toBe(true);
    expect((r as { error: string }).error).toContain('Unknown surface');
  });
});
