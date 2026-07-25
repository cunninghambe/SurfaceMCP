import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolMeta, SurfaceConfig, ToolCatalog } from '../types.js';
import type { RoleMutex } from '../auth/role-mutex.js';
import { executeCall } from './call.js';
import { jsonSchemaToZod } from './schema-to-zod.js';
import { extractPathParams, withPathParams } from './path-params.js';
import type { CallLimiter } from './rails.js';
import type { CoverageTracker as CallObserver } from './coverage.js';
import { log } from '../log.js';

export function registerGeneratedTools(
  server: McpServer,
  catalog: ToolCatalog,
  surface: SurfaceConfig,
  roleMutex: RoleMutex,
  root: string,
  limiter?: CallLimiter,
  observer?: CallObserver
): void {
  for (const tool of catalog.tools) {
    registerOneTool(server, tool, catalog.revision, surface, roleMutex, root, limiter, observer);
  }
}

function registerOneTool(
  server: McpServer,
  tool: ToolMeta,
  revision: number,
  surface: SurfaceConfig,
  roleMutex: RoleMutex,
  _root: string,
  limiter?: CallLimiter,
  observer?: CallObserver
): void {
  const pathParams = extractPathParams(tool.path);
  const effectiveSchema = withPathParams(tool.inputSchema, pathParams);
  const inputDescription = pathParams.length > 0
    ? `Request body / query params (include path params: ${pathParams.map((p) => p.name).join(', ')})`
    : 'Request body / query params';

  const description =
    `${tool.method} ${tool.path} | confidence:${tool.inputSchemaConfidence} | ` +
    `effect:${tool.sideEffectClass} | toolId:${tool.toolId}` +
    (tool.isServerAction ? ' | serverAction' : '');

  server.tool(
    tool.name,
    description,
    {
      role: z.string().min(1).describe('Role to execute as (must be declared in config)'),
      input: jsonSchemaToZod(effectiveSchema).describe(inputDescription),
      timeoutMs: z.number().int().min(1).max(300_000).optional().describe('Request timeout in ms'),
      allowExternal: z.boolean().optional().describe('Allow external side-effect calls'),
      noAutoRelogin: z.boolean().optional().describe('Disable auto-relogin on 401'),
      pinRevision: z.number().int().optional().describe('Abort if catalog revision has changed'),
      readOnly: z.boolean().optional().describe('Refuse this call unless the tool is `safe`'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Return the request that would be sent (secrets masked) without sending it'),
    },
    async (args) => {
      try {
        const result = await executeCall({
          tool,
          role: args.role,
          input: (args.input as Record<string, unknown>) ?? {},
          baseUrl: surface.baseUrl,
          projectName: surface.name,
          auth: surface.auth,
          roleMutex,
          revision,
          allowExternal: args.allowExternal,
          noAutoRelogin: args.noAutoRelogin,
          pinRevision: args.pinRevision,
          currentRevision: revision,
          timeoutMs: args.timeoutMs,
          // Rails: config-enforced read-only cannot be overridden by the caller.
          readOnly: surface.rails?.readOnly === true || args.readOnly === true,
          dryRun: args.dryRun === true,
          limiter,
          observer,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          isError: !result.ok,
        };
      } catch (err) {
        log.error({ err, tool: tool.name }, 'generated tool call failed');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }
    }
  );
}
