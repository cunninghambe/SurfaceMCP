// Tests for surface_routes_for_page resolution (issues #23/#24).
//
// The regression: SPA routes (React-Router-defined) returned not_found/bad_path
// because the handler only ever treated pagePath as a filesystem path. These
// tests prove routes now resolve through the page catalog, while source-file
// paths (Next.js/Express and direct Vite file queries) still work.

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extractVitePages } from '../extract/vite/router.js';
import { resolveRoutesForPage, matchPageByRoute } from './routes-for-page.js';
import type { ToolMeta } from '../types.js';

const FIXTURES = resolve(import.meta.dirname, '../../fixtures');
const VITE_APP = resolve(FIXTURES, 'vite-app');
const ROUTERLESS = resolve(FIXTURES, 'vite-routerless-app');
const TAB_STATE = resolve(FIXTURES, 'vite-tab-state-app');

async function pagesFor(root: string) {
  const { pages } = await extractVitePages(root);
  return pages;
}

describe('matchPageByRoute — normalisation', () => {
  it('matches exact, missing-leading-slash, and trailing-slash inputs', async () => {
    const pages = await pagesFor(VITE_APP);
    expect(matchPageByRoute(pages, '/admin/users')?.route).toBe('/admin/users');
    expect(matchPageByRoute(pages, 'admin/users')?.route).toBe('/admin/users');
    expect(matchPageByRoute(pages, '/admin/users/')?.route).toBe('/admin/users');
  });

  it('returns undefined for an unknown route', async () => {
    const pages = await pagesFor(VITE_APP);
    expect(matchPageByRoute(pages, '/does/not/exist')).toBeUndefined();
  });
});

describe('resolveRoutesForPage — SPA route resolution (fixtures/vite-app)', () => {
  it('resolves every static SPA route via the page catalog (no not_found)', async () => {
    const pages = await pagesFor(VITE_APP);
    const routes = [
      ['/', 'src/pages/Home.tsx'],
      ['/about', 'src/pages/About.tsx'],
      ['/admin', 'src/pages/AdminLayout.tsx'],
      ['/admin/users', 'src/pages/AdminUsers.tsx'],
      ['/admin/settings', 'src/pages/AdminSettings.tsx'],
      ['/users/:id', 'src/pages/UserDetail.tsx'],
    ] as const;

    for (const [route, sourceFile] of routes) {
      const result = resolveRoutesForPage({ root: VITE_APP, pagePath: route, pages, tools: [] });
      expect(result.ok, `route ${route} should resolve`).toBe(true);
      if (!result.ok) continue;
      expect(result.data.resolvedVia).toBe('route');
      expect(result.data.page?.route).toBe(route);
      expect(result.data.page?.sourceFile).toBe(sourceFile);
    }
  });

  it('resolves a dynamic route by its template (/users/:id)', async () => {
    const pages = await pagesFor(VITE_APP);
    const result = resolveRoutesForPage({ root: VITE_APP, pagePath: '/users/:id', pages, tools: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.page?.componentName).toBe('UserDetail');
  });
});

describe('resolveRoutesForPage — crawl-seed / routerless fixtures', () => {
  it('resolves the crawl-seed "/" route for a routerless app instead of erroring', async () => {
    const pages = await pagesFor(ROUTERLESS);
    const result = resolveRoutesForPage({ root: ROUTERLESS, pagePath: '/', pages, tools: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.resolvedVia).toBe('route');
    expect(result.data.tools).toEqual([]);
    expect(result.data.note).toBeDefined();
  });

  it('resolves the crawl-seed "/" route for a tab-state app instead of erroring', async () => {
    const pages = await pagesFor(TAB_STATE);
    const result = resolveRoutesForPage({ root: TAB_STATE, pagePath: '/', pages, tools: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.resolvedVia).toBe('route');
  });
});

describe('resolveRoutesForPage — source-file path fallback (non-SPA behaviour preserved)', () => {
  it('scans a source-file path and cross-references API tools', () => {
    // A source file that is NOT a route in any catalog — resolves via the
    // filesystem, exactly as Next.js/Express callers rely on.
    const dir = mkdtempSync(resolve(tmpdir(), 'rfp-'));
    mkdirSync(resolve(dir, 'app', 'journal'), { recursive: true });
    const rel = 'app/journal/page.tsx';
    writeFileSync(
      resolve(dir, rel),
      `export default function Page() {\n  fetch('/api/journal-entries');\n  return null;\n}\n`,
      'utf-8'
    );

    const tools: ToolMeta[] = [
      {
        name: 'get_journal_entries',
        bareName: 'get_journal_entries',
        surface: 'api',
        toolId: 'abc123',
        method: 'GET',
        path: '/api/journal-entries',
        inputSchema: { type: 'object' },
        inputSchemaConfidence: 'inferred',
        sideEffectClass: 'safe',
        sourceFile: 'src/routes/journal.ts',
        sourceLine: 12,
        isServerAction: false,
      },
    ];

    const result = resolveRoutesForPage({ root: dir, pagePath: rel, pages: [], tools });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.resolvedVia).toBe('file');
    expect(result.data.tools.map((t) => t.toolId)).toContain('abc123');
    expect(result.data.tools[0]?.sourceLocation).toBe('src/routes/journal.ts:12');
  });

  it('returns not_found for a source-file path that does not exist', () => {
    const result = resolveRoutesForPage({
      root: VITE_APP,
      pagePath: 'src/pages/DoesNotExist.tsx',
      pages: [],
      tools: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
  });
});

describe('resolveRoutesForPage — path-traversal guard preserved', () => {
  it('rejects an absolute file-path input as bad_path', () => {
    const result = resolveRoutesForPage({
      root: VITE_APP,
      // Leading-slash path: absolute on both POSIX and Windows (a `C:\` path is
      // only absolute on Windows, so it would slip through as relative on Linux).
      pagePath: '/etc/passwd',
      pages: [],
      tools: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('bad_path');
  });

  it('rejects a ".." escape as bad_path', () => {
    const result = resolveRoutesForPage({
      root: VITE_APP,
      pagePath: '../../etc/passwd',
      pages: [],
      tools: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('bad_path');
  });
});
