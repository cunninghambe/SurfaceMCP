import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { loadConfig, findConfigPath } from '../config.js';
import { loadEnvFiles } from '../env/indirection.js';
import { getRuntimeEnumScript, RUNTIME_ENUM_VERSION } from '../runtime-enum/script.js';
import { postprocessRuntimeRoutes } from '../runtime-enum/postprocess.js';
import { executeCall } from './call.js';
import { recoverFromZodError } from '../probe/zod-error.js';
import { recoverFromPydanticError } from '../probe/pydantic-error.js';
import { recoverFromDrfError } from '../probe/drf-error.js';
import { recoverFromFastApiError } from '../probe/fastapi-error.js';
import { loadSampleInputs } from '../samples/fixture-loader.js';
import { log } from '../log.js';
import { pathToFileURL } from 'node:url';
import type { ToolMeta, ProbeResult, Config, SurfaceRegistry, SurfaceRuntime } from '../types.js';
import { buildDescribeAuth } from '../auth/describe-auth.js';
import { isLoopbackRemote } from './loopback.js';
import { resolveContainedPath } from './path-guard.js';
import { validateExtraCookie } from './cookie-guard.js';
import {
  resolveTokenState,
  buildAllowedHosts,
  createMcpSecurityMiddleware,
  logTokenStartup,
} from './security.js';
import {
  buildRegistry,
  buildAggregateCatalog,
  buildSurfaceListResponse,
  buildSurfaceSummary,
  getMcpPort,
  resolveTool,
} from './registry.js';
import { registerGeneratedTools } from './tools-generated.js';
import { installShutdown } from './shutdown.js';

const RUNTIME_ENUM_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    routers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { enum: ['tanstack-router', 'react-router-v6', 'react-router-v5', 'wouter', 'vue-router', 'next-router', 'none'] },
          version: { type: 'string' },
          routes: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, params: { type: 'array', items: { type: 'string' } } } } },
        },
        required: ['name', 'routes'],
      },
    },
    errors: { type: 'array', items: { type: 'object', properties: { detector: { type: 'string' }, message: { type: 'string' } } } },
    elapsedMs: { type: 'number' },
  },
  required: ['routers', 'errors', 'elapsedMs'],
};

function toolOk(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function toolError(code: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: code, message }) }],
    isError: true as const,
  };
}

async function probeSchema(
  tool: ToolMeta,
  runtime: SurfaceRuntime,
  role: string,
  revision: number
): Promise<ProbeResult> {
  const { surface, roleMutex } = runtime;
  if (!roleMutex) return { confidence: 'unknown' };
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

/** Resolve a surface name from args with multi-surface aware back-compat. */
export function resolveRuntime(
  registry: SurfaceRegistry,
  surfaceArg?: string
): SurfaceRuntime | { error: string } {
  if (surfaceArg) {
    const rt = registry.surfaces.get(surfaceArg);
    if (!rt) return { error: `Unknown surface: "${surfaceArg}". Known: ${registry.order.join(', ')}` };
    return rt;
  }
  // Only default to the sole surface when there is exactly one. In a
  // multi-surface config, silently picking the first would route a caller to
  // the wrong app's API; require an explicit surface (mirrors resolveTool).
  if (registry.order.length === 1) {
    return registry.surfaces.get(registry.order[0]!)!;
  }
  if (registry.order.length === 0) {
    return { error: 'No surfaces are configured.' };
  }
  return { error: `Multiple surfaces are configured. Specify surface: <name>. Known: ${registry.order.join(', ')}` };
}

function registerMetaTools(
  server: McpServer,
  registry: SurfaceRegistry,
  projectRoot: string,
  httpReq?: Request
): void {
  // surface_list_surfaces (NEW in v0.3.0)
  server.tool(
    'surface_list_surfaces',
    'List all surfaces served by this SurfaceMCP instance, with stack, lifecycle state, and tool counts.',
    {},
    async () => toolOk(buildSurfaceListResponse(registry))
  );

  // surface_list_tools
  server.tool(
    'surface_list_tools',
    'List all discovered tools across all surfaces. Supports filtering by method, sideEffect, pathPrefix, confidence, and surface.',
    {
      filter: z
        .object({
          method: z.string().optional(),
          sideEffect: z.string().optional(),
          pathPrefix: z.string().optional(),
          confidence: z.string().optional(),
          surface: z.string().optional(),
        })
        .optional(),
    },
    async (args) => {
      const result = buildAggregateCatalog(registry, args.filter ?? undefined);
      return toolOk(result);
    }
  );

  // surface_describe_tool
  server.tool(
    'surface_describe_tool',
    'Get full metadata for a tool, including raw handler snippet.',
    {
      name: z.string().optional().describe('Tool name (prefixed in multi-surface: <surface>:<tool>)'),
      toolId: z.string().optional().describe('Stable tool hash ID'),
      surface: z.string().optional().describe('Surface name (optional filter)'),
    },
    async (args) => {
      const resolved = resolveTool(registry, { name: args.name, toolId: args.toolId, surface: args.surface });
      if ('error' in resolved) return toolError(resolved.error.code, resolved.error.message);
      return toolOk({ ...resolved.tool });
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
      /** #181: BugHunter cookie_endpoint session cookie to forward to the backend API. */
      extraCookie: z.string().optional(),
    },
    async (args) => {
      const resolved = resolveTool(registry, { name: args.name, toolId: args.toolId });
      if ('error' in resolved) {
        const err = resolved.error;
        const base = {
          ok: false,
          error: { code: err.code, message: err.message },
          durationMs: 0,
          revisionAtCall: -1,
        };
        if (err.code === 'bare_name_ambiguous') {
          return toolOk({ ...base, candidates: err.candidates });
        }
        return toolOk(base);
      }

      const { tool, runtime } = resolved;
      if (!runtime.roleMutex) {
        return toolOk({
          ok: false,
          error: { code: 'surface_not_ready', message: `Surface "${runtime.surface.name}" is not ready` },
          durationMs: 0,
          revisionAtCall: -1,
        });
      }

      // #cookie-injection: validate a caller-supplied extraCookie is a single,
      // well-formed name=value pair before it reaches the outbound Cookie header.
      if (args.extraCookie !== undefined) {
        const cv = validateExtraCookie(args.extraCookie);
        if (!cv.ok) {
          return toolOk({
            ok: false,
            error: { code: cv.code, message: cv.message },
            durationMs: 0,
            revisionAtCall: runtime.catalog.revision,
          });
        }
      }

      const result = await executeCall({
        tool,
        role: args.role,
        input: (args.input as Record<string, unknown>) ?? {},
        baseUrl: runtime.surface.baseUrl,
        projectName: runtime.surface.name,
        auth: runtime.surface.auth,
        roleMutex: runtime.roleMutex,
        revision: runtime.catalog.revision,
        allowExternal: args.allowExternal,
        noAutoRelogin: args.noAutoRelogin,
        pinRevision: args.pinRevision,
        currentRevision: runtime.catalog.revision,
        timeoutMs: args.timeoutMs,
        extraCookie: args.extraCookie,
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
      const resolved = resolveTool(registry, { name: args.name, toolId: args.toolId });
      if ('error' in resolved) return toolError(resolved.error.code, resolved.error.message);
      const { tool, runtime } = resolved;
      const result = await probeSchema(tool, runtime, args.role, runtime.catalog.revision);
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
      const resolved = resolveTool(registry, { name: args.name, toolId: args.toolId });
      if ('error' in resolved) return toolError(resolved.error.code, resolved.error.message);
      const { tool, runtime } = resolved;
      const samples = loadSampleInputs(tool.sourceFile, runtime.resolvedRoot);
      return toolOk({ samples });
    }
  );

  const optSurface = z.string().optional().describe('Surface name (required in multi-surface configs)');

  // surface_login_status
  server.tool(
    'surface_login_status',
    'Check the cached login status for a role.',
    { role: z.string().min(1), surface: optSurface },
    async (args) => {
      const rt = resolveRuntime(registry, args.surface);
      if ('error' in rt) return toolError('surface_required', rt.error);
      const session = rt.roleMutex?.getSession(args.role);
      if (!session) return toolOk({ authenticated: false, refreshCount: 0 });
      return toolOk({
        authenticated: true,
        cachedAt: session.cachedAt,
        lastRefreshAt: session.lastRefreshAt,
        refreshCount: session.refreshCount,
        cookieDomain: rt.surface.baseUrl,
      });
    }
  );

  // surface_relogin
  server.tool(
    'surface_relogin',
    'Force a session refresh for a role.',
    { role: z.string().min(1), surface: optSurface },
    async (args) => {
      const rt = resolveRuntime(registry, args.surface);
      if ('error' in rt) return toolError('surface_required', rt.error);
      if (!rt.roleMutex) return toolOk({ ok: false, error: 'Surface not ready' });
      try {
        await rt.roleMutex.refresh(args.role);
        return toolOk({ ok: true });
      } catch (err) {
        return toolOk({ ok: false, error: String(err) });
      }
    }
  );

  // surface_describe_auth
  server.tool(
    'surface_describe_auth',
    'Describe the auth configuration for a role. Credential VALUES are redacted by default — only field names and per-field shape metadata (valueMeta) are returned. Pass revealSecrets: true to include plaintext values; that path is LOOPBACK-only and behind the /mcp token gate, and credentials cross the wire.',
    {
      role: z.string().min(1).describe('Role name from surfacemcp.config.json roles[]'),
      surface: optSurface,
      revealSecrets: z
        .boolean()
        .optional()
        .describe('When true, include plaintext credential values (loopback + token gated). Default false: names and shapes only.'),
    },
    async (args) => {
      if (httpReq && !isLoopbackRemote(httpReq)) {
        return toolError('not_loopback', 'surface_describe_auth requires a loopback connection');
      }
      const rt = resolveRuntime(registry, args.surface);
      if ('error' in rt) return toolError('surface_required', rt.error);
      const role = rt.surface.roles.find((r) => r.name === args.role);
      if (!role) return toolError('not_found', `Unknown role: ${args.role}`);
      const reveal = args.revealSecrets === true;
      log.info(
        { surface: rt.surface.name, role: args.role, kind: rt.surface.auth.kind, revealSecrets: reveal },
        'describe_auth requested'
      );
      return toolOk(buildDescribeAuth(rt.surface.auth, role, reveal));
    }
  );

  // surface_list_pages
  server.tool(
    'surface_list_pages',
    'List discovered SPA pages for this surface. Returns empty for stacks without UI route discovery.',
    {
      filter: z.object({ pathPrefix: z.string().optional(), lazy: z.boolean().optional() }).optional(),
      surface: optSurface,
    },
    async (args) => {
      const rt = resolveRuntime(registry, args.surface);
      if ('error' in rt) return toolError('surface_required', rt.error);
      const pc = rt.pageCatalog;
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

  // surface_enumerate_routes_runtime
  server.tool(
    'surface_enumerate_routes_runtime',
    "Returns a self-contained JS script that, when injected into the SPA via browser.evaluate(...), enumerates the live router's route table.",
    {},
    async () => toolOk({
      version: RUNTIME_ENUM_VERSION,
      script: getRuntimeEnumScript(),
      timeoutMs: 5000,
      expectedSchema: RUNTIME_ENUM_SCHEMA,
    })
  );

  // surface_postprocess_runtime_routes
  server.tool(
    'surface_postprocess_runtime_routes',
    'Validate, normalise, and dedup the raw output of the runtime-enum script.',
    {
      raw: z.unknown().describe('Output of evaluating the script returned by surface_enumerate_routes_runtime.'),
      surface: optSurface,
    },
    async (args) => {
      const rt = resolveRuntime(registry, args.surface);
      if ('error' in rt) return toolError('surface_required', rt.error);
      const result = postprocessRuntimeRoutes(args.raw, {
        excludedRoutes: rt.surface.excludedRoutes ?? [],
      });
      return toolOk(result);
    }
  );

  // surface_list_navigations
  server.tool(
    'surface_list_navigations',
    'List statically-discovered SPA navigations. Empty for stacks without UI route discovery.',
    {
      filter: z.object({
        method: z.enum(['link', 'router-link', 'router-push', 'state-setter']).optional(),
        kind: z.enum(['url', 'state', 'hash']).optional(),
      }).optional(),
      surface: optSurface,
    },
    async (args) => {
      const rt = resolveRuntime(registry, args.surface);
      if ('error' in rt) return toolError('surface_required', rt.error);
      const nc = rt.navigationCatalog;
      let navs = nc.navigations;
      if (args.filter?.method) navs = navs.filter((n) => n.method === args.filter!.method);
      if (args.filter?.kind) navs = navs.filter((n) => n.kind === args.filter!.kind);
      return toolOk({ revision: nc.revision, navigations: navs, skips: nc.skips });
    }
  );

  // surface_describe_self
  server.tool(
    'surface_describe_self',
    'Return metadata about this SurfaceMCP instance (stack, name, revision, capabilities).',
    { surface: optSurface },
    async (args) => {
      const rt = resolveRuntime(registry, args.surface);
      if ('error' in rt) return toolError('surface_required', rt.error);
      const listResponse = buildSurfaceListResponse(registry);
      // Legacy fields from resolved surface for back-compat (deprecated in v0.3.0; removed in v0.4.0)
      // TODO: remove legacy fields in v0.4.0
      const isReady = rt.state.kind === 'ready';
      return toolOk({
        name: rt.surface.name,
        stack: rt.surface.stack,
        baseUrl: rt.surface.baseUrl,
        toolRevision: isReady ? rt.catalog.revision : 0,
        pageRevision: isReady ? rt.pageCatalog.revision : 0,
        capabilities: {
          listPages: rt.surface.stack === 'vite',
          listNavigations: rt.surface.stack === 'vite',
          enumerateRoutesRuntime: true,
          crawlSeed: rt.surface.stack === 'vite',
        },
        surfaceMcpVersion: listResponse.surfaceMcpVersion,
        surfaces: listResponse.surfaces,
      });
    }
  );

  // surface_routes_for_page
  server.tool(
    'surface_routes_for_page',
    'Find routes used by a specific page component (best-effort static scan).',
    {
      pagePath: z.string().min(1).describe('Page file path relative to project root'),
      surface: optSurface,
    },
    async (args) => {
      const rt = resolveRuntime(registry, args.surface);
      if ('error' in rt) return toolError('surface_required', rt.error);

      // #path-traversal: confine pagePath to the resolved project root — reject
      // absolute inputs and any `..` escape before touching the filesystem.
      const guard = resolveContainedPath(rt.resolvedRoot, args.pagePath);
      if (!guard.ok) return toolError(guard.code, guard.message);
      const absPath = guard.absPath;

      const { readFileSync, existsSync } = await import('node:fs');
      if (!existsSync(absPath)) return toolError('not_found', `Page not found: ${args.pagePath}`);

      let content = '';
      try {
        content = readFileSync(absPath, 'utf-8');
      } catch {
        return toolError('read_error', `Could not read page: ${args.pagePath}`);
      }

      const urlPattern = /(?:fetch|useSWR|useMutation|useQuery)\s*\(\s*['"`]([^'"` ]+)['"`]/g;
      const matchedPaths = new Set<string>();
      let match: RegExpExecArray | null;
      while ((match = urlPattern.exec(content)) !== null) {
        matchedPaths.add(match[1]);
      }

      const matchedTools = rt.catalog.tools.filter((t) => {
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
  config: Config,
  projectRoot: string
): Promise<express.Express> {
  const registry = await buildRegistry(config, projectRoot);

  const app = express();
  // Exposed so entry points can close watchers on graceful shutdown.
  app.locals.registry = registry;
  app.use(express.json({ limit: '4mb' }));

  // ── Security gate for /mcp (see SPEC_SECURITY_HARDENING.md) ──────────────────
  // DNS-rebinding protection (Host/Origin allowlist) + shared-secret bearer token.
  // The SDK's transport-level `enableDnsRebindingProtection` options exist in
  // 1.29.0 but are @deprecated in favour of external middleware, so we enforce
  // it here instead. Bound to the loopback authorities we actually listen on.
  const mcpPort = getMcpPort(config);
  const tokenState = resolveTokenState();
  const securityMiddleware = createMcpSecurityMiddleware({
    tokenState,
    allowedHosts: buildAllowedHosts(mcpPort),
    allowedOrigins: [],
  });
  logTokenStartup(tokenState, `http://127.0.0.1:${mcpPort}/mcp`);

  app.post('/mcp', securityMiddleware, async (req: Request, res: Response) => {
    const server = new McpServer({
      name: 'surfacemcp',
      version: '0.3.0',
    });

    registerMetaTools(server, registry, projectRoot, req);

    // Register prefixed generated tools from all ready surfaces
    for (const sName of registry.order) {
      const runtime = registry.surfaces.get(sName)!;
      if (runtime.state.kind !== 'ready') continue;
      registerGeneratedTools(server, runtime.catalog, runtime.surface, runtime.roleMutex!, runtime.resolvedRoot);
    }

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
    const agg = buildAggregateCatalog(registry);
    res.json({ ok: true, revision: agg.revision, tools: agg.tools.length });
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

  const port = getMcpPort(config);

  createApp(config, projectRoot).then((app) => {
    const server = app.listen(port, '127.0.0.1', () => {
      log.info(
        { port, endpoint: `http://127.0.0.1:${port}/mcp`, surfaces: config.surfaces.map((s) => s.name) },
        'SurfaceMCP listening'
      );
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log.error({ port }, `Port ${port} is already in use — another SurfaceMCP instance may be running`);
      } else {
        log.error({ err }, 'HTTP server error');
      }
      process.exit(1);
    });
    installShutdown(server, { registry: app.locals.registry as SurfaceRegistry | undefined });
  }).catch((err: unknown) => {
    log.error({ err }, 'Failed to start SurfaceMCP');
    process.exit(1);
  });
}
