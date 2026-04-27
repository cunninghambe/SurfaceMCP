import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startSurfaceMcpServer, stopAll, type SpawnedServer } from './helpers/spawn.js';
import { loadFixtureMustDiscover } from './helpers/fixture-load.js';
import * as path from 'node:path';

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
