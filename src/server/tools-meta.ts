import type { ToolMeta, ToolCatalog, SurfaceConfig } from '../types.js';
import { extractNextjsRoutes } from '../extract/nextjs/routes.js';
import { extractServerActions } from '../extract/nextjs/server-actions.js';
import { extractExpressRoutes } from '../extract/express/static.js';
import { fetchFastApiSchema } from '../extract/fastapi/openapi-fetch.js';
import { extractDjangoRoutes } from '../extract/django/ast-walk.js';
import { extractOpenApiRoutes } from '../extract/openapi/parse.js';
import { classifyByCallGraph } from '../classify/call-graph.js';
import { log } from '../log.js';

let catalog: ToolCatalog = { revision: 0, tools: [] };

export function getCatalog(): ToolCatalog {
  return catalog;
}

export function getToolByName(name: string): ToolMeta | undefined {
  return catalog.tools.find((t) => t.name === name);
}

export function getToolById(toolId: string): ToolMeta | undefined {
  return catalog.tools.find((t) => t.toolId === toolId);
}

export async function regenerateCatalog(surface: SurfaceConfig, root: string): Promise<void> {
  log.info({ stack: surface.stack, root }, 'regenerating tool catalog');

  let tools: ToolMeta[] = [];

  try {
    switch (surface.stack) {
      case 'nextjs': {
        const [routes, actions] = await Promise.all([
          extractNextjsRoutes(root, surface.schemaIntrospection?.zodAlias),
          extractServerActions(root),
        ]);
        tools = [...routes, ...actions];
        break;
      }
      case 'express':
        tools = await extractExpressRoutes(root, surface.schemaIntrospection?.zodAlias);
        break;
      case 'fastapi':
        tools = await fetchFastApiSchema(surface.baseUrl);
        break;
      case 'django':
        tools = extractDjangoRoutes(root);
        break;
      case 'openapi':
        tools = extractOpenApiRoutes(root);
        break;
    }
  } catch (err) {
    log.error({ err }, 'extraction error — catalog unchanged');
    return;
  }

  // Apply side-effect classification via call graph
  const externalPaths = surface.externalIntegrations ?? [];
  tools = tools.map((tool) => ({
    ...tool,
    sideEffectClass: classifyByCallGraph(tool.sourceFile, root, tool.method, externalPaths),
  }));

  // Filter excluded routes
  const excluded = surface.excludedRoutes ?? [];
  tools = tools.filter(
    (t) => !excluded.some((ex) => t.path.startsWith(ex) || t.name === ex)
  );

  catalog = {
    revision: catalog.revision + 1,
    tools,
  };

  log.info({ revision: catalog.revision, count: tools.length }, 'catalog updated');
}
