import { createHash } from 'node:crypto';
import type { RawToolMeta, ToolMeta, ToolCatalog, PageCatalog, SurfaceRuntime, SurfaceConfig } from '../types.js';
import { extractNextjsRoutes } from '../extract/nextjs/routes.js';
import { extractServerActions } from '../extract/nextjs/server-actions.js';
import { extractExpressRoutes } from '../extract/express/static.js';
import { extractFastifyRoutes } from '../extract/fastify/routes.js';
import { fetchFastApiSchema } from '../extract/fastapi/openapi-fetch.js';
import { extractDjangoRoutes } from '../extract/django/ast-walk.js';
import { extractOpenApiRoutes } from '../extract/openapi/parse.js';
import { extractPagesForStack } from '../extract/pages/index.js';
import { classifyByCallGraph } from '../classify/call-graph.js';
import { log } from '../log.js';

function prefixedToolId(surfaceName: string, method: string, path: string): string {
  return createHash('sha1')
    .update(`${surfaceName}:${method}:${path}`)
    .digest('hex')
    .slice(0, 12);
}

function applyPrefix(raw: RawToolMeta[], surfaceName: string, multiSurface: boolean): ToolMeta[] {
  return raw.map((tool) => ({
    ...tool,
    bareName: tool.name,
    surface: surfaceName,
    name: multiSurface ? `${surfaceName}:${tool.name}` : tool.name,
    toolId: prefixedToolId(surfaceName, tool.method, tool.path),
  }));
}

async function extractRaw(surface: SurfaceConfig, root: string): Promise<RawToolMeta[]> {
  switch (surface.stack) {
    case 'nextjs': {
      const [routes, actions] = await Promise.all([
        extractNextjsRoutes(root, surface.schemaIntrospection?.zodAlias),
        extractServerActions(root),
      ]);
      return [...routes, ...actions];
    }
    case 'express':
      return extractExpressRoutes(
        root,
        surface.schemaIntrospection?.zodAlias,
        surface.schemaIntrospection?.bodyValidatorNames
      );
    case 'fastify':
      return extractFastifyRoutes(root);
    case 'fastapi':
      return fetchFastApiSchema(surface.baseUrl, root);
    case 'django':
      return extractDjangoRoutes(root);
    case 'openapi':
      return extractOpenApiRoutes(root);
    case 'vite':
      return [];
  }
}

export async function regenerateCatalog(
  runtime: SurfaceRuntime,
  root: string,
  multiSurface = false
): Promise<void> {
  const { surface } = runtime;
  log.info({ surface: surface.name, stack: surface.stack, root }, 'regenerating tool catalog');

  let raw: RawToolMeta[];
  try {
    raw = await extractRaw(surface, root);
  } catch (err) {
    log.error({ surface: surface.name, err }, 'extraction error — catalog unchanged');
    throw err;
  }

  // Apply side-effect classification
  const externalPaths = surface.externalIntegrations ?? [];
  raw = raw.map((tool) => ({
    ...tool,
    sideEffectClass: classifyByCallGraph(tool.sourceFile, root, tool.method, externalPaths),
  }));

  // Filter excluded routes
  const excluded = surface.excludedRoutes ?? [];
  const filteredRaw = raw.filter(
    (t) => !excluded.some((ex) => t.path.startsWith(ex) || t.name === ex)
  );

  const tools = applyPrefix(filteredRaw, surface.name, multiSurface);

  runtime.catalog = {
    revision: runtime.catalog.revision + 1,
    tools,
  };

  log.info({ surface: surface.name, revision: runtime.catalog.revision, count: tools.length }, 'catalog updated');
}

export async function regeneratePageCatalog(runtime: SurfaceRuntime, root: string): Promise<void> {
  const { surface } = runtime;
  try {
    const { pages, skips } = await extractPagesForStack(surface.stack, root);
    runtime.pageCatalog = {
      revision: runtime.pageCatalog.revision + 1,
      pages,
      skips,
    };
    if (skips.length > 0) {
      log.info({ surface: surface.name, skips }, 'page extraction skips');
    }
    log.info({ surface: surface.name, revision: runtime.pageCatalog.revision, count: pages.length }, 'page catalog updated');
  } catch (err) {
    log.error({ surface: surface.name, err }, 'page extraction error — page catalog unchanged');
  }
}

// ─── Legacy single-catalog accessors (CLI commands only) ──────────────────────
// CLI commands that work on surfaces[0] use these via the shim below.

let _legacyCatalog: ToolCatalog = { revision: 0, tools: [] };
let _legacyPageCatalog: PageCatalog = { revision: 0, pages: [], skips: [] };

export function setCatalog(c: ToolCatalog): void { _legacyCatalog = c; }
export function setPageCatalog(c: PageCatalog): void { _legacyPageCatalog = c; }
export function getCatalog(): ToolCatalog { return _legacyCatalog; }
export function getPageCatalog(): PageCatalog { return _legacyPageCatalog; }
export function getToolByName(name: string): ToolMeta | undefined {
  return _legacyCatalog.tools.find((t) => t.name === name);
}
export function getToolById(toolId: string): ToolMeta | undefined {
  return _legacyCatalog.tools.find((t) => t.toolId === toolId);
}

/**
 * Compatibility shim for CLI commands that operate on surfaces[0].
 * Constructs a transient SurfaceRuntime, regenerates, and syncs legacy globals.
 */
export async function regenerateCatalogForSurface(surface: SurfaceConfig, root: string): Promise<void> {
  const { RoleMutex } = await import('../auth/role-mutex.js');
  const runtime: SurfaceRuntime = {
    surface,
    resolvedRoot: root,
    state: { kind: 'extracting' },
    catalog: { revision: _legacyCatalog.revision, tools: [] },
    pageCatalog: { revision: _legacyPageCatalog.revision, pages: [], skips: [] },
    navigationCatalog: { revision: 0, navigations: [], skips: [] },
    roleMutex: new RoleMutex(surface.baseUrl, surface.auth, surface.roles),
  };
  await regenerateCatalog(runtime, root, false);
  _legacyCatalog = runtime.catalog;
}
