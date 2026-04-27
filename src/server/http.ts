import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { loadConfig, findConfigPath } from '../config.js';
import { loadEnvFiles } from '../env/indirection.js';
import { RoleMutex } from '../auth/role-mutex.js';
import { getCatalog, getPageCatalog, getToolByName, getToolById, regenerateCatalog } from './tools-meta.js';
import { executeCall } from './call.js';
import { startWatcher } from '../watch/chokidar-driver.js';
import { recoverFromZodError } from '../probe/zod-error.js';
import { recoverFromPydanticError } from '../probe/pydantic-error.js';
import { recoverFromDrfError } from '../probe/drf-error.js';
import { recoverFromFastApiError } from '../probe/fastapi-error.js';
import { loadSampleInputs } from '../samples/fixture-loader.js';
import { log } from '../log.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolMeta, ProbeResult, SurfaceConfig } from '../types.js';

function toolOk(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function toolError(code: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: code, message }) }],
    isError: true as const,
  };
}

function filterTools(
  tools: ToolMeta[],
  filter?: {
    method?: string;
    sideEffect?: string;
    pathPrefix?: string;
    confidence?: string;
  }
): ToolMeta[] {
  if (!filter) return tools;
  return tools.filter((t) => {
    if (filter.method && t.method !== filter.method.toUpperCase()) return false;
    if (filter.sideEffect && t.sideEffectClass !== filter.sideEffect) return false;
    if (filter.pathPrefix && !t.path.startsWith(filter.pathPrefix)) return false;
    if (filter.confidence && t.inputSchemaConfidence !== filter.confidence) return false;
    return true;
  });
}

async function probeSchema(
  tool: ToolMeta,
  surface: SurfaceConfig,
  roleMutex: RoleMutex,
  role: string,
  revision: number
): Promise<ProbeResult> {
  let body: unknown;
  try {
    const result = await executeCall({
      tool,
      role,
      input: {},
      baseUrl: surface.baseUrl,
      projectName: surface.name,
      auth: surface.auth,
      roleMutex,
      revision,
      noAutoRelogin: true,
      currentRevision: revision,
    });
    body = result.body;
  } catch {
    return { confidence: 'unknown' };
  }

  const recovered =
    recoverFromZodError(body) ??
    recoverFromFastApiError(body) ??
    recoverFromPydanticError(body) ??
    recoverFromDrfError(body);

  if (recovered) {
    return { recoveredSchema: recovered, confidence: 'inferred', rawError: body };
  }

  return { confidence: 'unknown', rawError: body };
}

function registerMetaTools(
  server: McpServer,
  surface: SurfaceConfig,
  roleMutex: RoleMutex,
  root: string
): void {
  // surface_list_tools
  server.tool(
    'surface_list_tools',
    'List all discovered tools for this surface. Supports filtering by method, sideEffect, pathPrefix, confidence.',
    {
      filter: z
        .object({
          method: z.string().optional(),
          sideEffect: z.string().optional(),
          pathPrefix: z.string().optional(),
          confidence: z.string().optional(),
        })
        .optional(),
    },
    async (args) => {
      const catalog = getCatalog();
      const tools = filterTools(catalog.tools, args.filter ?? undefined);
      return toolOk({ revision: catalog.revision, tools });
    }
  );

  // surface_describe_tool
  server.tool(
    'surface_describe_tool',
    'Get full metadata for a tool, including raw handler snippet.',
    {
      name: z.string().optional().describe('Tool name'),
      toolId: z.string().optional().describe('Stable tool hash ID'),
    },
    async (args) => {
      const tool = args.toolId ? getToolById(args.toolId) : args.name ? getToolByName(args.name) : undefined;
      if (!tool) return toolError('not_found', `Tool not found: ${args.name ?? args.toolId}`);
      return toolOk({ ...tool });
    }
  );

  // surface_call
  server.tool(
    'surface_call',
    'Call a discovered route/action as a specified role.',
    {
      name: z.string().optional(),
      toolId: z.string().optional(),
      role: z.string().min(1),
      input: z.record(z.unknown()).optional(),
      timeoutMs: z.number().int().min(1).max(300_000).optional(),
      allowExternal: z.boolean().optional(),
      noAutoRelogin: z.boolean().optional(),
      pinRevision: z.number().int().optional(),
    },
    async (args) => {
      const catalog = getCatalog();
      const tool = args.toolId
        ? getToolById(args.toolId)
        : args.name
        ? getToolByName(args.name)
        : undefined;
      if (!tool) return toolError('not_found', `Tool not found: ${args.name ?? args.toolId}`);

      const result = await executeCall({
        tool,
        role: args.role,
        input: (args.input as Record<string, unknown>) ?? {},
        baseUrl: surface.baseUrl,
        projectName: surface.name,
        auth: surface.auth,
        roleMutex,
        revision: catalog.revision,
        allowExternal: args.allowExternal,
        noAutoRelogin: args.noAutoRelogin,
        pinRevision: args.pinRevision,
        currentRevision: catalog.revision,
        timeoutMs: args.timeoutMs,
      });
      return toolOk(result);
    }
  );

  // surface_probe
  server.tool(
    'surface_probe',
    'Issue an empty POST to an unknown-schema endpoint and recover schema from validation error.',
    {
      name: z.string().optional(),
      toolId: z.string().optional(),
      role: z.string().min(1),
    },
    async (args) => {
      const catalog = getCatalog();
      const tool = args.toolId
        ? getToolById(args.toolId)
        : args.name
        ? getToolByName(args.name)
        : undefined;
      if (!tool) return toolError('not_found', `Tool not found: ${args.name ?? args.toolId}`);
      const result = await probeSchema(tool, surface, roleMutex, args.role, catalog.revision);
      return toolOk(result);
    }
  );

  // surface_sample_inputs
  server.tool(
    'surface_sample_inputs',
    'Return fixture inputs from co-located test files for a route.',
    {
      name: z.string().optional(),
      toolId: z.string().optional(),
    },
    async (args) => {
      const tool = args.toolId
        ? getToolById(args.toolId)
        : args.name
        ? getToolByName(args.name)
        : undefined;
      if (!tool) return toolError('not_found', `Tool not found: ${args.name ?? args.toolId}`);
      const samples = loadSampleInputs(tool.sourceFile, root);
      return toolOk({ samples });
    }
  );

  // surface_login_status
  server.tool(
    'surface_login_status',
    'Check the cached login status for a role.',
    { role: z.string().min(1) },
    async (args) => {
      const session = roleMutex.getSession(args.role);
      if (!session) {
        return toolOk({ authenticated: false, refreshCount: 0 });
      }
      return toolOk({
        authenticated: true,
        cachedAt: session.cachedAt,
        lastRefreshAt: session.lastRefreshAt,
        refreshCount: session.refreshCount,
        cookieDomain: surface.baseUrl,
      });
    }
  );

  // surface_relogin
  server.tool(
    'surface_relogin',
    'Force a session refresh for a role.',
    { role: z.string().min(1) },
    async (args) => {
      try {
        await roleMutex.refresh(args.role);
        return toolOk({ ok: true });
      } catch (err) {
        return toolOk({ ok: false, error: String(err) });
      }
    }
  );

  // surface_list_pages
  server.tool(
    'surface_list_pages',
    'List discovered SPA pages for this surface. Returns empty for stacks without UI route discovery (express, fastapi, django, openapi when used standalone).',
    {
      filter: z
        .object({
          pathPrefix: z.string().optional(),
          lazy: z.boolean().optional(),
        })
        .optional(),
    },
    async (args) => {
      const pc = getPageCatalog();
      let pages = pc.pages;
      if (args.filter?.pathPrefix) {
        const prefix = args.filter.pathPrefix;
        pages = pages.filter((p) => p.route.startsWith(prefix));
      }
      if (typeof args.filter?.lazy === 'boolean') {
        pages = pages.filter((p) => p.lazy === args.filter!.lazy);
      }
      return toolOk({ revision: pc.revision, pages, skips: pc.skips });
    }
  );

  // surface_describe_self
  server.tool(
    'surface_describe_self',
    'Return non-secret metadata about this SurfaceMCP instance (stack, name, revision, capabilities).',
    {},
    async () => {
      const c = getCatalog();
      const pc = getPageCatalog();
      return toolOk({
        name: surface.name,
        stack: surface.stack,
        baseUrl: surface.baseUrl,
        toolRevision: c.revision,
        pageRevision: pc.revision,
        capabilities: {
          listPages: surface.stack === 'vite',
          crawlSeed: surface.stack === 'vite',
        },
      });
    }
  );

  // surface_routes_for_page
  server.tool(
    'surface_routes_for_page',
    'Find routes used by a specific page component (best-effort static scan).',
    { pagePath: z.string().min(1).describe('Page file path relative to project root') },
    async (args) => {
      const { readFileSync, existsSync } = await import('node:fs');
      const absPath = resolve(root, args.pagePath);
      if (!existsSync(absPath)) return toolError('not_found', `Page not found: ${args.pagePath}`);

      let content = '';
      try {
        content = readFileSync(absPath, 'utf-8');
      } catch {
        return toolError('read_error', `Could not read page: ${args.pagePath}`);
      }

      // Extract string-literal URL arguments to fetch/useSWR/useMutation/useQuery
      const catalog = getCatalog();
      const urlPattern = /(?:fetch|useSWR|useMutation|useQuery)\s*\(\s*['"`]([^'"` ]+)['"`]/g;
      const matchedPaths = new Set<string>();
      let match: RegExpExecArray | null;

      while ((match = urlPattern.exec(content)) !== null) {
        matchedPaths.add(match[1]);
      }

      const matchedTools = catalog.tools.filter((t) => {
        for (const p of matchedPaths) {
          const normalized = p.replace(/\/:[^/]+/g, '/:param');
          if (t.path === p || t.path === normalized) return true;
        }
        return false;
      });

      return toolOk({
        tools: matchedTools.map((t) => ({
          toolId: t.toolId,
          name: t.name,
          sourceLocation: `${t.sourceFile}:${t.sourceLine}`,
        })),
      });
    }
  );
}

export async function createApp(
  surface: SurfaceConfig,
  root: string
): Promise<express.Express> {
  const roleMutex = new RoleMutex(surface.baseUrl, surface.auth, surface.roles);

  // Initial catalog generation
  await regenerateCatalog(surface, root);

  // Login all roles
  await roleMutex.loginAll();

  // Start file watcher
  const watchPaths = (surface.watchPaths ?? ['app', 'pages', 'src']).map((p) =>
    resolve(root, p)
  );

  startWatcher({
    watchPaths,
    extraIgnore: surface.watchIgnore,
    onRegen: () => {
      regenerateCatalog(surface, root).catch((err) =>
        log.error({ err }, 'watcher regen failed')
      );
    },
  });

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.post('/mcp', async (req: Request, res: Response) => {
    const server = new McpServer({
      name: `surfacemcp-${surface.name}`,
      version: '0.1.0',
    });

    const catalog = getCatalog();

    registerMetaTools(server, surface, roleMutex, root);

    // Register generated tools for each discovered route
    const { registerGeneratedTools } = await import('./tools-generated.js');
    registerGeneratedTools(server, catalog, surface, roleMutex, root);

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body as unknown);
    } catch (err) {
      log.error({ err }, 'MCP request error');
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    } finally {
      await server.close().catch(() => {});
    }
  });

  app.get('/mcp', (_req: Request, res: Response) => res.status(405).end('Method not allowed'));
  app.delete('/mcp', (_req: Request, res: Response) => res.status(405).end('Method not allowed'));

  app.get('/health', (_req: Request, res: Response) => {
    const catalog = getCatalog();
    res.json({ ok: true, revision: catalog.revision, tools: catalog.tools.length });
  });

  return app;
}

// Entry point when run directly (e.g. `node dist/server/http.js`)
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  const configPath = process.env.SURFACEMCP_CONFIG ?? findConfigPath(process.cwd());
  const config = loadConfig(configPath);
  const projectRoot = process.cwd();

  loadEnvFiles(projectRoot);

  const surface = config.surfaces[0]!;
  const resolvedRoot = resolve(projectRoot, surface.root);

  createApp(surface, resolvedRoot).then((app) => {
    app.listen(surface.port, '127.0.0.1', () => {
      log.info(
        { port: surface.port, endpoint: `http://127.0.0.1:${surface.port}/mcp` },
        `SurfaceMCP ${surface.name} listening`
      );
    });
  }).catch((err: unknown) => {
    log.error({ err }, 'Failed to start SurfaceMCP');
    process.exit(1);
  });
}
