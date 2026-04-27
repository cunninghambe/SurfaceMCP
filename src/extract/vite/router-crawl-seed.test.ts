// Unit tests for crawl_seed fallback emission (SPEC_CRAWL_SEED § 5.2)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { extractVitePages } from './router.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const FIXTURE_VITE_APP = resolve(import.meta.dirname, '../../../fixtures/vite-app');

function makeTmpFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'surfacemcp-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

let emptySrcDir: string;
let tabStateDir: string;
let unresolvableRouterDir: string;

beforeAll(() => {
  // Case 1: empty src/ — only vite.config.ts, no routes
  emptySrcDir = makeTmpFixture({
    'vite.config.ts': `import { defineConfig } from 'vite';\nexport default defineConfig({});`,
    'src/main.tsx': `import React from 'react';\nconst App = () => <div>Hello</div>;\nexport default App;`,
  });

  // Case 2: tab-state routing — pushState but no <Route> JSX
  tabStateDir = makeTmpFixture({
    'vite.config.ts': `import { defineConfig } from 'vite';\nexport default defineConfig({});`,
    'src/App.tsx': `
import React, { useEffect } from 'react';
export function App() {
  useEffect(() => {
    window.history.pushState({}, '', '/dashboard');
  }, []);
  return <div>App</div>;
}
`,
  });

  // Case 4: createBrowserRouter with unresolvable argument
  unresolvableRouterDir = makeTmpFixture({
    'vite.config.ts': `import { defineConfig } from 'vite';\nexport default defineConfig({});`,
    'src/App.tsx': `
import { createBrowserRouter } from 'react-router-dom';
const externalRoutes = getRoutes();
const router = createBrowserRouter(externalRoutes);
export default router;
`,
  });
});

afterAll(() => {
  for (const dir of [emptySrcDir, tabStateDir, unresolvableRouterDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Case 1
describe('empty src/ — seed emitted, no static pages', () => {
  it('emits one crawl_seed page at /', async () => {
    const { pages, skips } = await extractVitePages(emptySrcDir);
    expect(pages.length).toBe(1);
    expect(pages[0]!.route).toBe('/');
    expect(pages[0]!.source).toBe('crawl_seed');
    expect(pages[0]!.sourceFile).toBe('<unresolved>');
  });

  it('emits crawl_seed_emitted skip with "no static routes resolved" detail', async () => {
    const { skips } = await extractVitePages(emptySrcDir);
    const seedSkip = skips.find(s => s.reason === 'crawl_seed_emitted');
    expect(seedSkip).toBeDefined();
    expect(seedSkip!.detail).toContain('no static routes resolved');
  });
});

// Case 2
describe('tab-state routing — seed AND tab-state skip both present', () => {
  it('emits one crawl_seed page', async () => {
    const { pages } = await extractVitePages(tabStateDir);
    expect(pages.length).toBe(1);
    expect(pages[0]!.source).toBe('crawl_seed');
  });

  it('emits crawl_seed_emitted skip', async () => {
    const { skips } = await extractVitePages(tabStateDir);
    expect(skips.some(s => s.reason === 'crawl_seed_emitted')).toBe(true);
  });

  it('emits tab_state_routing_suspected skip', async () => {
    const { skips } = await extractVitePages(tabStateDir);
    expect(skips.some(s => s.reason === 'tab_state_routing_suspected')).toBe(true);
  });

  it('crawl_seed_emitted detail mentions tab-state routing', async () => {
    const { skips } = await extractVitePages(tabStateDir);
    const seedSkip = skips.find(s => s.reason === 'crawl_seed_emitted');
    expect(seedSkip!.detail).toContain('tab-state routing suspected');
  });
});

// Case 3
describe('react-router-dom fixture — NO seed, six static pages', () => {
  it('extracts exactly 6 pages', async () => {
    const { pages } = await extractVitePages(FIXTURE_VITE_APP);
    expect(pages.length).toBe(6);
  });

  it('all pages have source: static', async () => {
    const { pages } = await extractVitePages(FIXTURE_VITE_APP);
    expect(pages.every(p => p.source === 'static')).toBe(true);
  });

  it('no crawl_seed_emitted skip', async () => {
    const { skips } = await extractVitePages(FIXTURE_VITE_APP);
    expect(skips.every(s => s.reason !== 'crawl_seed_emitted')).toBe(true);
  });
});

// Case 4: unresolvable createBrowserRouter argument → 0 static pages → seed
describe('createBrowserRouter with unresolvable argument — seed + dynamic_route_array skip', () => {
  it('emits one crawl_seed page', async () => {
    const { pages } = await extractVitePages(unresolvableRouterDir);
    expect(pages.length).toBe(1);
    expect(pages[0]!.source).toBe('crawl_seed');
  });

  it('emits crawl_seed_emitted skip', async () => {
    const { skips } = await extractVitePages(unresolvableRouterDir);
    expect(skips.some(s => s.reason === 'crawl_seed_emitted')).toBe(true);
  });

  it('emits dynamic_route_array skip', async () => {
    const { skips } = await extractVitePages(unresolvableRouterDir);
    expect(skips.some(s => s.reason === 'dynamic_route_array')).toBe(true);
  });

  it('crawl_seed_emitted detail says "no static routes resolved"', async () => {
    const { skips } = await extractVitePages(unresolvableRouterDir);
    const seedSkip = skips.find(s => s.reason === 'crawl_seed_emitted');
    expect(seedSkip!.detail).toContain('no static routes resolved');
  });
});
