import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import type { RuntimeEnumerationRaw } from '../types.js';

const SCRIPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'script.runtime.js');
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf-8');

/** Run the script in a synthetic context with the given window-like globals.
 * Assigns windowGlobals directly as the window object to preserve property getters. */
function runScript(windowGlobals: Record<string, unknown>): RuntimeEnumerationRaw {
  // Build a window object that has all the globals but also document/Date
  const windowObj = Object.create(null) as Record<string, unknown>;
  // Copy all descriptors from windowGlobals (preserves getters)
  for (const key of Object.getOwnPropertyNames(windowGlobals)) {
    const desc = Object.getOwnPropertyDescriptor(windowGlobals, key);
    if (desc) Object.defineProperty(windowObj, key, desc);
  }

  const ctx: Record<string, unknown> = {
    window: windowObj,
    document: {
      querySelector: (_sel: string) => null,
    },
    Date: { now: () => 1000 },
    Object,
    Set,
    String,
    Array,
  };

  vm.createContext(ctx);
  return vm.runInContext(SCRIPT, ctx) as RuntimeEnumerationRaw;
}

describe('runtime-enum script — TanStack Router', () => {
  it('detects TanStack Router with routes', () => {
    const result = runScript({
      __TSR_ROUTER__: {
        version: '1.50.0',
        routesByPath: {
          '/': true,
          '/dashboard': true,
          '/users/$userId': true,
        },
      },
    });

    const tsr = result.routers.find(r => r.name === 'tanstack-router');
    expect(tsr).toBeDefined();
    expect(tsr!.version).toBe('1.50.0');
    const paths = tsr!.routes.map(r => r.path).sort();
    expect(paths).toEqual(['/', '/dashboard', '/users/:userId']);
    expect(result.errors).toEqual([]);
  });

  it('TanStack present but empty routesByPath — returns empty routes', () => {
    const result = runScript({
      __TSR_ROUTER__: { version: '1.0.0', routesByPath: {} },
    });
    const tsr = result.routers.find(r => r.name === 'tanstack-router');
    expect(tsr).toBeDefined();
    expect(tsr!.routes).toHaveLength(0);
  });

  it('TanStack missing — not in routers', () => {
    const result = runScript({});
    expect(result.routers.find(r => r.name === 'tanstack-router')).toBeUndefined();
  });

  it('isolates detector exceptions — error in errors[], other detectors continue', () => {
    // Define __TSR_ROUTER__ as a getter that throws
    const windowGlobals: Record<string, unknown> = {};
    Object.defineProperty(windowGlobals, '__TSR_ROUTER__', {
      get() { throw new Error('boom'); },
      enumerable: true,
      configurable: true,
    });
    const result = runScript(windowGlobals);
    expect(result.errors.find(e => e.detector === 'tanstack-router')).toBeDefined();
    // Other detectors ran without issue (no extra errors for them)
  });

  it('$splat route converted to *', () => {
    const result = runScript({
      __TSR_ROUTER__: {
        routesByPath: { '/docs/$splat': true },
      },
    });
    const tsr = result.routers.find(r => r.name === 'tanstack-router');
    expect(tsr!.routes[0].path).toBe('/docs/*');
  });
});

describe('runtime-enum script — Vue Router', () => {
  it('detects Vue Router from __VUE_APP__', () => {
    const result = runScript({
      __VUE_APP__: {
        config: {
          globalProperties: {
            $router: {
              version: '4.2.0',
              options: {
                routes: [
                  { path: '/' },
                  { path: '/about' },
                  { path: '/users/:id', children: [{ path: 'edit' }] },
                ],
              },
            },
          },
        },
      },
    });

    const vue = result.routers.find(r => r.name === 'vue-router');
    expect(vue).toBeDefined();
    const paths = vue!.routes.map(r => r.path).sort();
    expect(paths).toContain('/');
    expect(paths).toContain('/about');
    expect(paths).toContain('/users/:id');
    expect(paths).toContain('/users/:id/edit');
  });

  it('Vue Router not present — not in routers', () => {
    const result = runScript({});
    expect(result.routers.find(r => r.name === 'vue-router')).toBeUndefined();
  });
});

describe('runtime-enum script — Next.js Router', () => {
  it('detects Next.js current page from __NEXT_DATA__', () => {
    const result = runScript({
      __NEXT_DATA__: { page: '/dashboard' },
    });
    const next = result.routers.find(r => r.name === 'next-router');
    expect(next).toBeDefined();
    expect(next!.routes[0].path).toBe('/dashboard');
  });

  it('Next.js not present — not in routers', () => {
    const result = runScript({});
    expect(result.routers.find(r => r.name === 'next-router')).toBeUndefined();
  });
});

describe('runtime-enum script — general', () => {
  it('returns empty routers when no router is present', () => {
    const result = runScript({});
    expect(result.routers).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('reports elapsedMs as a number >= 0', () => {
    const result = runScript({});
    expect(typeof result.elapsedMs).toBe('number');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('multiple routers detected in same run', () => {
    const result = runScript({
      __TSR_ROUTER__: {
        routesByPath: { '/dashboard': true },
      },
      __NEXT_DATA__: { page: '/current' },
    });
    expect(result.routers.length).toBeGreaterThanOrEqual(2);
  });

  it('detector errors do not kill other detectors', () => {
    const windowGlobals: Record<string, unknown> = {};
    Object.defineProperty(windowGlobals, '__TSR_ROUTER__', {
      get() { throw new Error('crash'); },
      enumerable: true,
      configurable: true,
    });
    windowGlobals.__NEXT_DATA__ = { page: '/current' };

    const result = runScript(windowGlobals);
    expect(result.errors.find(e => e.detector === 'tanstack-router')).toBeDefined();
    // Next.js detector still ran
    expect(result.routers.find(r => r.name === 'next-router')).toBeDefined();
  });
});
