import { describe, it, expect } from 'vitest';
import { extractVitePages } from './router.js';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const FIXTURE_ROOT = resolve(import.meta.dirname, '../../../fixtures/vite-app');

type MustDiscoverEntry = {
  route: string;
  sourceFile: string;
  componentName: string;
  lazy: boolean;
  dynamicParams: string[];
};

function loadMustDiscover(): { pages: MustDiscoverEntry[] } {
  return JSON.parse(
    readFileSync(resolve(FIXTURE_ROOT, 'MUST_DISCOVER.json'), 'utf-8')
  ) as { pages: MustDiscoverEntry[] };
}

describe('extractVitePages — fixture exact-match', () => {
  it('extracts all six fixture pages — exact-match', async () => {
    const { pages, skips } = await extractVitePages(FIXTURE_ROOT);
    const must = loadMustDiscover();

    // No unexpected skips for happy-path fixture
    const blockingSkips = skips.filter(s =>
      s.reason !== 'unresolved_component' &&
      s.reason !== 'duplicate_route'
    );
    // The /about route appears in both App.tsx (lazy) and router.ts — expect one dup skip
    expect(blockingSkips.length).toBe(0);

    expect(pages.length, `expected 6 pages, got ${pages.length}: ${JSON.stringify(pages.map(p => p.route))}`).toBe(6);

    const byRoute = new Map(pages.map(p => [p.route, p]));
    const expectedRoutes = new Set(must.pages.map(p => p.route));
    const discoveredRoutes = new Set(pages.map(p => p.route));

    // Presence: every expected route is found
    for (const entry of must.pages) {
      expect(byRoute.has(entry.route), `Missing route: ${entry.route}`).toBe(true);
    }

    // Absence: no unexpected routes
    const extras = [...discoveredRoutes].filter(r => !expectedRoutes.has(r));
    expect(extras, `Unexpected routes discovered: ${JSON.stringify(extras)}`).toEqual([]);
  });

  it('marks About lazy: true and Home lazy: false', async () => {
    const { pages } = await extractVitePages(FIXTURE_ROOT);
    const byRoute = new Map(pages.map(p => [p.route, p]));
    expect(byRoute.get('/about')?.lazy).toBe(true);
    expect(byRoute.get('/')?.lazy).toBe(false);
  });

  it('dynamicParams equals ["id"] for /users/:id and [] for static routes', async () => {
    const { pages } = await extractVitePages(FIXTURE_ROOT);
    const byRoute = new Map(pages.map(p => [p.route, p]));
    expect(byRoute.get('/users/:id')?.dynamicParams).toEqual(['id']);
    expect(byRoute.get('/')?.dynamicParams).toEqual([]);
    expect(byRoute.get('/admin')?.dynamicParams).toEqual([]);
  });

  it('nested routes are joined correctly', async () => {
    const { pages } = await extractVitePages(FIXTURE_ROOT);
    const routes = pages.map(p => p.route);
    expect(routes).toContain('/admin/users');
    expect(routes).toContain('/admin/settings');
    // No double slashes
    for (const r of routes) {
      expect(r.includes('//'), `Double slash in route ${r}`).toBe(false);
    }
  });

  it('componentName is preserved as authored', async () => {
    const { pages } = await extractVitePages(FIXTURE_ROOT);
    const byRoute = new Map(pages.map(p => [p.route, p]));
    expect(byRoute.get('/')?.componentName).toBe('Home');
    expect(byRoute.get('/admin')?.componentName).toBe('AdminLayout');
    expect(byRoute.get('/admin/users')?.componentName).toBe('AdminUsers');
    expect(byRoute.get('/admin/settings')?.componentName).toBe('AdminSettings');
    expect(byRoute.get('/users/:id')?.componentName).toBe('UserDetail');
  });

  it('output is deterministic across multiple calls', async () => {
    const first = await extractVitePages(FIXTURE_ROOT);
    const second = await extractVitePages(FIXTURE_ROOT);
    expect(first.pages.map(p => p.route)).toEqual(second.pages.map(p => p.route));
  });
});
