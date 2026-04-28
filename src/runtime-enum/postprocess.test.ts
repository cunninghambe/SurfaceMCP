import { describe, it, expect } from 'vitest';
import { postprocessRuntimeRoutes } from './postprocess.js';
import type { RuntimeEnumerationRaw } from '../types.js';

describe('postprocessRuntimeRoutes — validation', () => {
  it('returns empty result for null input', () => {
    const r = postprocessRuntimeRoutes(null, {});
    expect(r.summary.fellBackToNone).toBe(true);
    expect(r.routes).toHaveLength(0);
    expect(r.summary.errorCount).toBe(1);
  });

  it('returns empty result for string input', () => {
    const r = postprocessRuntimeRoutes('string', {});
    expect(r.summary.fellBackToNone).toBe(true);
  });

  it('returns empty result when routers is not an array', () => {
    const r = postprocessRuntimeRoutes({ routers: 'bad', errors: [], elapsedMs: 0 }, {});
    expect(r.summary.fellBackToNone).toBe(true);
  });

  it('returns empty result for undefined input', () => {
    const r = postprocessRuntimeRoutes(undefined, {});
    expect(r.summary.fellBackToNone).toBe(true);
  });
});

describe('postprocessRuntimeRoutes — deduplication', () => {
  it('dedups routes across routers (TanStack wins over react-router-v6)', () => {
    const raw: RuntimeEnumerationRaw = {
      routers: [
        { name: 'tanstack-router', routes: [{ path: '/x', params: [] }] },
        { name: 'react-router-v6', routes: [{ path: '/x', params: [] }] },
      ],
      errors: [],
      elapsedMs: 0,
    };
    const r = postprocessRuntimeRoutes(raw, {});
    expect(r.routes).toHaveLength(1);
    expect(r.routes[0].source).toBe('tanstack-router');
    expect(r.summary.dedupedRoutes).toBe(1);
    expect(r.summary.totalRoutes).toBe(2);
  });

  it('routes from different normalised paths are kept distinct', () => {
    const raw: RuntimeEnumerationRaw = {
      routers: [
        { name: 'tanstack-router', routes: [
          { path: '/x', params: [] },
          { path: '/y', params: [] },
        ]},
      ],
      errors: [],
      elapsedMs: 0,
    };
    const r = postprocessRuntimeRoutes(raw, {});
    expect(r.routes).toHaveLength(2);
  });
});

describe('postprocessRuntimeRoutes — excludedRoutes', () => {
  it('respects excludedRoutes glob /admin/**', () => {
    const raw: RuntimeEnumerationRaw = {
      routers: [{
        name: 'tanstack-router',
        routes: [
          { path: '/admin/users', params: [] },
          { path: '/dashboard', params: [] },
        ],
      }],
      errors: [],
      elapsedMs: 0,
    };
    const r = postprocessRuntimeRoutes(raw, { excludedRoutes: ['/admin/**'] });
    expect(r.routes.map(x => x.path)).toEqual(['/dashboard']);
  });

  it('respects exact excludedRoute match', () => {
    const raw: RuntimeEnumerationRaw = {
      routers: [{
        name: 'tanstack-router',
        routes: [
          { path: '/secret', params: [] },
          { path: '/public', params: [] },
        ],
      }],
      errors: [],
      elapsedMs: 0,
    };
    const r = postprocessRuntimeRoutes(raw, { excludedRoutes: ['/secret'] });
    expect(r.routes.map(x => x.path)).toEqual(['/public']);
  });
});

describe('postprocessRuntimeRoutes — summary', () => {
  it('emits fellBackToNone when no routers detected', () => {
    const r = postprocessRuntimeRoutes({ routers: [], errors: [], elapsedMs: 5 }, {});
    expect(r.summary.fellBackToNone).toBe(true);
  });

  it('emits correct detectedRouters list', () => {
    const raw: RuntimeEnumerationRaw = {
      routers: [
        { name: 'tanstack-router', routes: [] },
        { name: 'vue-router', routes: [] },
      ],
      errors: [],
      elapsedMs: 0,
    };
    const r = postprocessRuntimeRoutes(raw, {});
    expect(r.summary.detectedRouters).toContain('tanstack-router');
    expect(r.summary.detectedRouters).toContain('vue-router');
    expect(r.summary.fellBackToNone).toBe(false);
  });

  it('normalises TanStack $param to :param in output', () => {
    const raw: RuntimeEnumerationRaw = {
      routers: [{
        name: 'tanstack-router',
        routes: [{ path: '/users/$userId', params: ['userId'] }],
      }],
      errors: [],
      elapsedMs: 0,
    };
    const r = postprocessRuntimeRoutes(raw, {});
    expect(r.routes[0].path).toBe('/users/:userId');
  });
});
