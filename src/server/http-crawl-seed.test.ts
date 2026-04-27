// HTTP-level assertions for crawl_seed capability (SPEC_CRAWL_SEED § 5.3)
// Tests cases 6 and 7 from the spec.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startSurfaceMcpServer, stopAll, type SpawnedServer } from '../e2e/helpers/spawn.js';
import * as path from 'node:path';
import type { Page } from '../types.js';

const VITE_APP_ROOT = path.resolve(import.meta.dirname, '../../fixtures/vite-app');
const ROUTERLESS_ROOT = path.resolve(import.meta.dirname, '../../fixtures/vite-routerless-app');

describe('surface_describe_self — vite stack', () => {
  let server: SpawnedServer;

  beforeAll(async () => {
    server = await startSurfaceMcpServer(VITE_APP_ROOT);
  }, 30_000);

  afterAll(async () => {
    await stopAll();
  }, 15_000);

  // Case 6: surface_describe_self for vite stack returns capabilities.crawlSeed: true
  it('returns capabilities.crawlSeed: true', async () => {
    const result = await server.describeSelf();
    expect(result.capabilities.crawlSeed).toBe(true);
  });
});

describe('surface_list_pages — routerless vite project', () => {
  let server: SpawnedServer;

  beforeAll(async () => {
    server = await startSurfaceMcpServer(ROUTERLESS_ROOT);
  }, 30_000);

  afterAll(async () => {
    await stopAll();
  }, 15_000);

  // Case 7: surface_list_pages for an empty Vite project returns one crawl_seed page
  it('returns one page with source: crawl_seed', async () => {
    const result = await server.listPages() as { revision: number; pages: Page[] };
    expect(result.pages.length).toBe(1);
    expect(result.pages[0]!.route).toBe('/');
    expect(result.pages[0]!.source).toBe('crawl_seed');
    expect(result.pages[0]!.sourceFile).toBe('<unresolved>');
  });
});
