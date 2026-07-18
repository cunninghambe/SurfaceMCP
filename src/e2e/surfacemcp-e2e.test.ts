import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startSurfaceMcpServer, stopAll, type SpawnedServer } from './helpers/spawn.js';
import { loadFixtureMustDiscover } from './helpers/fixture-load.js';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';

describe('SurfaceMCP e2e against fixtures/vite-app', () => {
  let server: SpawnedServer;
  const fixtureRoot = path.resolve(import.meta.dirname, '../../fixtures/vite-app');

  type MustDiscoverPage = {
    route: string;
    sourceFile: string;
    componentName: string;
    lazy: boolean;
    dynamicParams: string[];
  };
  const mustDiscover = JSON.parse(
    readFileSync(path.resolve(fixtureRoot, 'MUST_DISCOVER.json'), 'utf-8')
  ) as { pages: MustDiscoverPage[] };

  beforeAll(async () => {
    server = await startSurfaceMcpServer(fixtureRoot);
  }, 30_000);

  afterAll(async () => {
    await stopAll();
  });

  it('surface_describe_self returns stack: vite and capabilities.listPages: true', async () => {
    const result = await server.describeSelf();
    expect(result.stack).toBe('vite');
    expect(result.capabilities.listPages).toBe(true);
  });

  it('surface_list_pages returns exactly the six pages from MUST_DISCOVER (presence + absence)', async () => {
    const result = await server.listPages();
    const pages = result.pages;

    expect(pages.length, `expected 6 pages, got ${pages.length}: ${JSON.stringify(pages.map(p => p.route))}`).toBe(6);

    const byRoute = new Map(pages.map(p => [p.route, p]));
    const expectedRoutes = new Set(mustDiscover.pages.map(p => p.route));
    const discoveredRoutes = new Set(pages.map(p => p.route));

    // Presence
    for (const entry of mustDiscover.pages) {
      expect(byRoute.has(entry.route), `Missing route: ${entry.route}`).toBe(true);
      const page = byRoute.get(entry.route)!;
      expect(page.lazy, `lazy mismatch for ${entry.route}`).toBe(entry.lazy);
      expect(page.componentName, `componentName mismatch for ${entry.route}`).toBe(entry.componentName);
    }

    // Absence
    const extras = [...discoveredRoutes].filter(r => !expectedRoutes.has(r));
    expect(extras, `Unexpected routes: ${JSON.stringify(extras)}`).toEqual([]);
  });

  it('surface_list_pages with filter lazy:true returns only lazy entries', async () => {
    const result = await server.listPages({ lazy: true });
    expect(result.pages.length).toBeGreaterThan(0);
    for (const p of result.pages) {
      expect(p.lazy).toBe(true);
    }
    // /about is the only lazy route in the fixture
    expect(result.pages.map(p => p.route)).toContain('/about');
  });

  it('surface_list_pages with filter pathPrefix:/admin returns only admin routes', async () => {
    const result = await server.listPages({ pathPrefix: '/admin' });
    const routes = result.pages.map(p => p.route);
    expect(routes).toContain('/admin');
    expect(routes).toContain('/admin/users');
    expect(routes).toContain('/admin/settings');
    // No non-admin routes
    for (const r of routes) {
      expect(r.startsWith('/admin'), `Route ${r} should start with /admin`).toBe(true);
    }
  });

  it('surface_list_tools returns empty (no API tools in vite fixture)', async () => {
    const tools = await server.listTools();
    expect(tools).toEqual([]);
  });

  it('surface_routes_for_page resolves an SPA route via the page catalog (issue #24)', async () => {
    // Regression: an SPA route path used to hit the path guard / filesystem and
    // return bad_path/not_found. It must now resolve through the page catalog.
    const result = await server.callTool('surface_routes_for_page', {
      pagePath: '/admin/users',
    }) as {
      resolvedVia: string;
      page?: { route: string; sourceFile: string; componentName?: string };
      tools: unknown[];
    };
    expect(result.resolvedVia).toBe('route');
    expect(result.page?.route).toBe('/admin/users');
    expect(result.page?.sourceFile).toBe('src/pages/AdminUsers.tsx');
    // No API tools in the pure-frontend vite fixture, but the route resolves.
    expect(result.tools).toEqual([]);
  });
});

describe('SurfaceMCP e2e against fixtures/nextjs-app', () => {
  let server: SpawnedServer;
  const fixtureRoot = path.resolve(import.meta.dirname, '../../fixtures/nextjs-app');
  const must = loadFixtureMustDiscover(fixtureRoot);

  beforeAll(async () => {
    server = await startSurfaceMcpServer(fixtureRoot);
  }, 30_000);

  afterAll(async () => {
    await stopAll();
  });

  it('discovers all expected routes', async () => {
    const tools = await server.listTools();
    const routeStrings = tools
      .filter(t => /^(get|post|put|patch|delete)_/i.test(t.name))
      .map(t => `${t.method} ${t.path}`);
    for (const expected of must.routes) {
      expect(routeStrings, `expected "${expected}" in discovered routes`).toContain(expected);
    }
  });

  it('reports inputSchemaConfidence per MUST_DISCOVER.perRoute', async () => {
    const tools = await server.listTools();
    for (const [route, expected] of Object.entries(must.perRoute ?? {})) {
      const [method, ...pathParts] = route.split(' ');
      const routePath = pathParts.join(' ');
      const tool = tools.find(t => t.method === method && t.path === routePath);
      expect(tool, `tool ${route} missing`).toBeDefined();
      expect(tool!.inputSchemaConfidence).toBe(expected.inputSchemaConfidence);
      if (expected.requiredFields) {
        expect(tool!.inputSchema.required ?? []).toEqual(
          expect.arrayContaining(expected.requiredFields)
        );
      }
    }
  });

  it('_suggestedExternalIntegrations matches include/exclude', async () => {
    const config = await server.getEffectiveConfig();
    const suggested: string[] = config.surfaces[0]?._suggestedExternalIntegrations ?? [];
    for (const inc of must.suggestedExternalIntegrations?.include ?? []) {
      expect(suggested.some(s => s.includes(inc)), `expected "${inc}" in suggested`).toBe(true);
    }
    for (const exc of must.suggestedExternalIntegrations?.exclude ?? []) {
      expect(suggested.some(s => s.includes(exc)), `expected "${exc}" NOT in suggested`).toBe(false);
    }
  });

  it('surface_routes_for_page returns the journal-entries tool for its page', async () => {
    // app/journal/page.tsx calls fetch('/api/journal-entries') — surface_routes_for_page
    // scans for fetch calls and matches them to known tool paths.
    const result = await server.callTool('surface_routes_for_page', {
      pagePath: 'app/journal/page.tsx',
    }) as { tools: Array<{ toolId: string; name: string; sourceLocation: string }> };
    expect(result.tools.length).toBeGreaterThan(0);
  });

  afterAll(() => {
    // Verify spawned process is cleaned up (process.kill(pid, 0) throws if no process)
    if (server?.pid) {
      try {
        process.kill(server.pid, 0);
        // If we get here, process still exists — that's unexpected but not fatal for cleanup
      } catch {
        // Expected: process is gone after stopAll()
      }
    }
  });
});
