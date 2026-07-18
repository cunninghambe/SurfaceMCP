import { describe, it, expect } from 'vitest';
import { closeRegistry } from './registry.js';
import type { SurfaceRegistry, SurfaceRuntime } from '../types.js';

function runtimeWith(watcher?: SurfaceRuntime['watcher']): SurfaceRuntime {
  return {
    surface: {} as SurfaceRuntime['surface'],
    resolvedRoot: '/x',
    state: { kind: 'ready' },
    catalog: { revision: 1, tools: [] },
    pageCatalog: { revision: 1, pages: [], skips: [] },
    navigationCatalog: { revision: 1, navigations: [], skips: [] },
    roleMutex: undefined,
    watcher,
  };
}

describe('closeRegistry', () => {
  it('closes every surface watcher and clears the handle', async () => {
    let closedA = 0;
    let closedB = 0;
    const a = runtimeWith({ close: async () => { closedA++; } });
    const b = runtimeWith({ close: async () => { closedB++; } });
    const registry: SurfaceRegistry = {
      surfaces: new Map([['a', a], ['b', b]]),
      order: ['a', 'b'],
    };

    await closeRegistry(registry);

    expect(closedA).toBe(1);
    expect(closedB).toBe(1);
    expect(a.watcher).toBeUndefined();
    expect(b.watcher).toBeUndefined();
  });

  it('tolerates a watcher whose close() rejects', async () => {
    const bad = runtimeWith({ close: async () => { throw new Error('EPERM'); } });
    const registry: SurfaceRegistry = { surfaces: new Map([['x', bad]]), order: ['x'] };
    await expect(closeRegistry(registry)).resolves.toBeUndefined();
  });

  it('is a no-op for surfaces without a watcher', async () => {
    const registry: SurfaceRegistry = { surfaces: new Map([['x', runtimeWith()]]), order: ['x'] };
    await expect(closeRegistry(registry)).resolves.toBeUndefined();
  });
});
