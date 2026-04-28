import { z } from 'zod';
import type { PostprocessedResult, RuntimeEnumerationRaw, DetectedRouterName, PostprocessedRoute } from '../types.js';
import { normaliseRoutePath } from './normalise.js';

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const RuntimeRouteSchema = z.object({
  path: z.string(),
  params: z.array(z.string()),
});

const DetectedRouterNameSchema = z.enum([
  'tanstack-router',
  'react-router-v6',
  'react-router-v5',
  'wouter',
  'vue-router',
  'next-router',
  'none',
]);

const DetectedRouterSchema = z.object({
  name: DetectedRouterNameSchema,
  version: z.string().optional(),
  routes: z.array(RuntimeRouteSchema),
});

const RuntimeEnumerationErrorSchema = z.object({
  detector: DetectedRouterNameSchema,
  message: z.string(),
});

export const RuntimeEnumerationRawSchema = z.object({
  routers: z.array(DetectedRouterSchema),
  errors: z.array(RuntimeEnumerationErrorSchema),
  elapsedMs: z.number(),
}).passthrough();

// Priority order for dedup: first in list wins
const ROUTER_PRIORITY: DetectedRouterName[] = [
  'tanstack-router',
  'react-router-v6',
  'react-router-v5',
  'wouter',
  'vue-router',
  'next-router',
  'none',
];

function emptyResult(): PostprocessedResult {
  return {
    routes: [],
    summary: {
      detectedRouters: [],
      errorCount: 1,
      totalRoutes: 0,
      dedupedRoutes: 0,
      fellBackToNone: true,
    },
  };
}

export type PostprocessOptions = {
  excludedRoutes?: string[];
};

/**
 * Validate, normalise, and dedup the raw output of the runtime-enum script.
 * Returns a normalized route list with summary statistics.
 */
export function postprocessRuntimeRoutes(
  raw: unknown,
  opts: PostprocessOptions
): PostprocessedResult {
  const parsed = RuntimeEnumerationRawSchema.safeParse(raw);
  if (!parsed.success) return emptyResult();

  const { routers, errors } = parsed.data as RuntimeEnumerationRaw;

  // Sort routers by priority so first-seen wins on conflict
  const sortedRouters = [...routers].sort((a, b) => {
    const ai = ROUTER_PRIORITY.indexOf(a.name);
    const bi = ROUTER_PRIORITY.indexOf(b.name);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  const seen = new Map<string, PostprocessedRoute>();
  let totalRoutes = 0;

  for (const router of sortedRouters) {
    for (const route of router.routes) {
      totalRoutes++;
      const normalised = normaliseRoutePath(route.path);
      if (!normalised || normalised === '') continue;

      // Apply excluded routes (simple prefix/exact matching)
      if (opts.excludedRoutes?.some(ex => isExcluded(normalised, ex))) continue;

      if (!seen.has(normalised)) {
        seen.set(normalised, {
          path: normalised,
          params: extractParams(normalised),
          source: router.name,
        });
      }
    }
  }

  const routes = [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
  const detectedRouters = routers.map(r => r.name);
  const fellBackToNone = routers.length === 0 || routers.every(r => r.name === 'none');

  return {
    routes,
    summary: {
      detectedRouters,
      errorCount: errors.length,
      totalRoutes,
      dedupedRoutes: seen.size,
      fellBackToNone,
    },
  };
}

function isExcluded(path: string, pattern: string): boolean {
  // Simple glob: /admin/** matches /admin/users, /admin/users/1, etc.
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(prefix + '/');
  }
  return path === pattern;
}

function extractParams(path: string): string[] {
  const params: string[] = [];
  const colonRe = /:([A-Za-z_][\w]*)/g;
  let m: RegExpExecArray | null;
  while ((m = colonRe.exec(path)) !== null) params.push(m[1]);
  if (path.includes('*')) params.push('*');
  return params;
}
