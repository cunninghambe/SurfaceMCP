// surface_routes_for_page resolution (issues #23/#24)
//
// `surface_routes_for_page` cross-references a page against the API tool
// catalog: it scans the page's source for `fetch`/react-query call sites and
// matches the referenced URLs to known tool paths.
//
// Callers can identify the page two ways:
//   1. An SPA route path exactly as returned by `surface_list_pages`
//      (e.g. '/admin/users', '/users/:id'). These are React-Router-defined
//      routes and do NOT correspond to a source-file path, so they must be
//      resolved through the page catalog (route → component sourceFile) before
//      any filesystem access.
//   2. A source-file path relative to the project root (e.g.
//      'app/journal/page.tsx'). Used by file-based stacks (Next.js/Express/…)
//      that populate no page catalog, and still accepted for Vite.
//
// Before this indirection existed, an SPA route was fed straight to the path
// guard: absolute inputs like '/admin/users' were rejected as `bad_path`, and
// relative ones matched no file on disk and returned `not_found`. Every SPA
// route therefore failed. We now try the page catalog first, then fall back to
// treating the input as a source-file path.

import { existsSync, readFileSync } from 'node:fs';
import type { Page, ToolMeta } from '../types.js';
import { resolveContainedPath } from './path-guard.js';

const UNRESOLVED = '<unresolved>';

/**
 * Normalise a route/path for comparison: ensure a single leading slash, collapse
 * duplicate slashes, and drop a trailing slash (except for root). Routes emitted
 * by the extractor are already normalised; this makes caller input tolerant of
 * a missing leading slash or a trailing one.
 */
function normRouteKey(input: string): string {
  let r = input.trim();
  if (!r.startsWith('/')) r = '/' + r;
  r = r.replace(/\/{2,}/g, '/');
  if (r !== '/' && r.endsWith('/')) r = r.slice(0, -1);
  return r;
}

/** Find the catalog page whose route matches `pagePath` (slash-normalised). */
export function matchPageByRoute(pages: Page[], pagePath: string): Page | undefined {
  const key = normRouteKey(pagePath);
  return pages.find((p) => normRouteKey(p.route) === key);
}

export type RoutesForPageMatch = {
  toolId: string;
  name: string;
  sourceLocation: string;
};

export type RoutesForPageData = {
  /** 'route' when resolved via the page catalog, 'file' when treated as a source path. */
  resolvedVia: 'route' | 'file';
  /** The matched catalog page (present only when resolvedVia === 'route'). */
  page?: { route: string; sourceFile: string; componentName?: string };
  /** API tools referenced by the page's source (best-effort static scan). */
  tools: RoutesForPageMatch[];
  /** Set when the route matched but no static scan was possible. */
  note?: string;
};

export type RoutesForPageResult =
  | { ok: true; data: RoutesForPageData }
  | { ok: false; code: string; message: string };

function pageSummary(p: Page): NonNullable<RoutesForPageData['page']> {
  return { route: p.route, sourceFile: p.sourceFile, componentName: p.componentName };
}

/** Scan `content` for fetch/react-query URL literals and match them to tools. */
function matchToolsInSource(content: string, tools: ToolMeta[]): RoutesForPageMatch[] {
  const urlPattern = /(?:fetch|useSWR|useMutation|useQuery)\s*\(\s*['"`]([^'"` ]+)['"`]/g;
  const referencedPaths = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(content)) !== null) {
    referencedPaths.add(match[1]);
  }

  const matched = tools.filter((t) => {
    for (const p of referencedPaths) {
      const normalized = p.replace(/\/:[^/]+/g, '/:param');
      if (t.path === p || t.path === normalized) return true;
    }
    return false;
  });

  return matched.map((t) => ({
    toolId: t.toolId,
    name: t.name,
    sourceLocation: `${t.sourceFile}:${t.sourceLine}`,
  }));
}

/**
 * Resolve the API tools referenced by a page identified either by SPA route
 * (via the page catalog) or by source-file path (via the filesystem).
 */
export function resolveRoutesForPage(opts: {
  root: string;
  pagePath: string;
  pages: Page[];
  tools: ToolMeta[];
}): RoutesForPageResult {
  const { root, pagePath, pages, tools } = opts;

  // Prefer the page catalog: this is how `surface_list_pages` already resolves
  // React-Router routes, and it lets callers pass a route path directly.
  const matchedPage = matchPageByRoute(pages, pagePath);

  let scanRelPath: string;
  let resolvedVia: 'route' | 'file';
  if (matchedPage) {
    resolvedVia = 'route';
    if (matchedPage.sourceFile === UNRESOLVED) {
      // The route is known but its component source could not be resolved
      // (crawl-seed entry, or a lazy/dynamic import we could not follow).
      // Report the match rather than a misleading not_found; there is simply
      // no file to scan for API references.
      return {
        ok: true,
        data: {
          resolvedVia,
          page: pageSummary(matchedPage),
          tools: [],
          note: 'Route matched but its component source is unresolved (e.g. crawl-seed or dynamic import); no static API scan performed.',
        },
      };
    }
    scanRelPath = matchedPage.sourceFile;
  } else {
    resolvedVia = 'file';
    scanRelPath = pagePath;
  }

  // #path-traversal: confine the path we are about to read to the resolved
  // project root — reject absolute inputs and any `..` escape before touching
  // the filesystem. Applied uniformly; catalog sourceFiles are already root-
  // relative and pass, callers passing raw file paths are guarded.
  const guard = resolveContainedPath(root, scanRelPath);
  if (!guard.ok) return { ok: false, code: guard.code, message: guard.message };
  const absPath = guard.absPath;

  if (!existsSync(absPath)) {
    return { ok: false, code: 'not_found', message: `Page not found: ${pagePath}` };
  }

  let content = '';
  try {
    content = readFileSync(absPath, 'utf-8');
  } catch {
    return { ok: false, code: 'read_error', message: `Could not read page: ${pagePath}` };
  }

  return {
    ok: true,
    data: {
      resolvedVia,
      page: matchedPage ? pageSummary(matchedPage) : undefined,
      tools: matchToolsInSource(content, tools),
    },
  };
}
