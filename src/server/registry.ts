import { resolve } from 'node:path';
import { RoleMutex } from '../auth/role-mutex.js';
import { regenerateCatalog, regeneratePageCatalog } from './tools-meta.js';
import { regenerateNavigationCatalog } from './navigation-catalog.js';
import { startWatcher } from '../watch/chokidar-driver.js';
import { log } from '../log.js';
import type {
  Config,
  SurfaceConfig,
  SurfaceRuntime,
  SurfaceRegistry,
  SurfaceLifecycleState,
  ResolveError,
  ToolMeta,
  SurfaceSummary,
  SurfaceListResponse,
} from '../types.js';
import { readFileSync } from 'node:fs';


function getSurfaceMcpVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.3.0';
  }
}

function createRuntime(surface: SurfaceConfig, resolvedRoot: string): SurfaceRuntime {
  return {
    surface,
    resolvedRoot,
    state: { kind: 'extracting' },
    catalog: { revision: 0, tools: [] },
    pageCatalog: { revision: 0, pages: [], skips: [] },
    navigationCatalog: { revision: 0, navigations: [], skips: [] },
    roleMutex: new RoleMutex(surface.baseUrl, surface.auth, surface.roles),
  };
}

async function initRuntime(runtime: SurfaceRuntime, multiSurface: boolean): Promise<void> {
  const { surface, resolvedRoot } = runtime;
  try {
    await regenerateCatalog(runtime, resolvedRoot, multiSurface);
    await regeneratePageCatalog(runtime, resolvedRoot);
    await regenerateNavigationCatalog(runtime, resolvedRoot);
    await runtime.roleMutex!.loginAll();
    runtime.state = { kind: 'ready' };
    log.info({ surface: surface.name }, 'surface ready');
  } catch (err) {
    runtime.state = { kind: 'failed', phase: 'extract', error: String(err) };
    runtime.roleMutex = undefined;
    log.error({ surface: surface.name, err }, 'surface initialisation failed');
  }
}

export async function buildRegistry(config: Config, projectRoot: string): Promise<SurfaceRegistry> {
  const registry: SurfaceRegistry = {
    surfaces: new Map(),
    order: [],
  };

  for (const surface of config.surfaces) {
    const resolvedRoot = resolve(projectRoot, surface.root);
    const runtime = createRuntime(surface, resolvedRoot);
    registry.surfaces.set(surface.name, runtime);
    registry.order.push(surface.name);
  }

  const multiSurface = config.surfaces.length > 1;

  // Initialise all surfaces in parallel; failures are isolated
  await Promise.all(
    registry.order.map(async (name) => {
      const runtime = registry.surfaces.get(name)!;
      await initRuntime(runtime, multiSurface);

      // Start per-surface file watcher
      const watchPaths = (runtime.surface.watchPaths ?? ['app', 'pages', 'src']).map((p) =>
        resolve(runtime.resolvedRoot, p)
      );
      // Serialize regens per surface: a change mid-regen would otherwise race on
      // runtime.catalog. All three catalogs are refreshed (the tool catalog is a
      // no-op for the vite stack, but pages/navigations are not).
      let regenerating = false;
      let regenPending = false;
      const runRegen = async (): Promise<void> => {
        if (runtime.state.kind === 'failed') return;
        if (regenerating) {
          regenPending = true;
          return;
        }
        regenerating = true;
        try {
          await regenerateCatalog(runtime, runtime.resolvedRoot, multiSurface);
          await regeneratePageCatalog(runtime, runtime.resolvedRoot);
          await regenerateNavigationCatalog(runtime, runtime.resolvedRoot);
        } catch (err) {
          log.error({ surface: name, err }, 'watcher regen failed');
        } finally {
          regenerating = false;
          if (regenPending) {
            regenPending = false;
            void runRegen();
          }
        }
      };
      const watcher = startWatcher({
        watchPaths,
        extraIgnore: runtime.surface.watchIgnore,
        onRegen: () => void runRegen(),
      });
      runtime.watcher = { close: () => watcher.close() };
    })
  );

  return registry;
}

export type ResolveResult =
  | { tool: ToolMeta; runtime: SurfaceRuntime }
  | { error: ResolveError };

export function resolveTool(
  registry: SurfaceRegistry,
  args: { name?: string; toolId?: string; surface?: string }
): ResolveResult {
  if (args.toolId) {
    for (const name of registry.order) {
      const runtime = registry.surfaces.get(name)!;
      const tool = runtime.catalog.tools.find((t) => t.toolId === args.toolId);
      if (tool) return { tool, runtime };
    }
    return { error: { code: 'not_found', message: `toolId ${args.toolId} not found` } };
  }

  if (!args.name) {
    return { error: { code: 'not_found', message: 'name or toolId required' } };
  }

  if (args.name.includes(':')) {
    const colonIdx = args.name.indexOf(':');
    const surfaceName = args.name.slice(0, colonIdx);
    const bareName = args.name.slice(colonIdx + 1);
    const runtime = registry.surfaces.get(surfaceName);
    if (!runtime) {
      return {
        error: {
          code: 'unknown_surface',
          message: `Unknown surface "${surfaceName}". Known: ${registry.order.join(', ')}`,
        },
      };
    }
    if (runtime.state.kind !== 'ready') {
      return {
        error: {
          code: 'surface_not_ready',
          message: `Surface "${surfaceName}" is not ready (state: ${runtime.state.kind})`,
          surface: surfaceName,
          state: runtime.state,
        },
      };
    }
    const tool = runtime.catalog.tools.find((t) => t.bareName === bareName || t.name === args.name);
    if (!tool) {
      return { error: { code: 'not_found', message: `${args.name} not found in surface ${surfaceName}` } };
    }
    return { tool, runtime };
  }

  // Bare name
  if (args.surface) {
    const runtime = registry.surfaces.get(args.surface);
    if (!runtime) {
      return {
        error: {
          code: 'unknown_surface',
          message: `Unknown surface "${args.surface}". Known: ${registry.order.join(', ')}`,
        },
      };
    }
    const tool = runtime.catalog.tools.find((t) => t.bareName === args.name);
    if (!tool) {
      return { error: { code: 'not_found', message: `${args.name} not found in surface ${args.surface}` } };
    }
    return { tool, runtime };
  }

  if (registry.order.length === 1) {
    const runtime = registry.surfaces.get(registry.order[0]!)!;
    const tool = runtime.catalog.tools.find((t) => t.bareName === args.name);
    if (!tool) {
      return { error: { code: 'not_found', message: `Tool not found: ${args.name}` } };
    }
    return { tool, runtime };
  }

  // Multi-surface bare name — strict reject
  const candidates: string[] = [];
  for (const sName of registry.order) {
    const runtime = registry.surfaces.get(sName)!;
    if (runtime.catalog.tools.some((t) => t.bareName === args.name)) {
      candidates.push(`${sName}:${args.name}`);
    }
  }
  return {
    error: {
      code: 'bare_name_ambiguous',
      message: `Bare tool name '${args.name}' requires a surface prefix in multi-surface configs.`,
      candidates,
    },
  };
}

export function buildAggregateCatalog(
  registry: SurfaceRegistry,
  filter?: { surface?: string; method?: string; sideEffect?: string; pathPrefix?: string; confidence?: string }
): { revision: number; tools: ToolMeta[]; surfaceRevisions: Record<string, number> } {
  const tools: ToolMeta[] = [];
  const surfaceRevisions: Record<string, number> = {};
  let aggRevision = 0;

  for (const sName of registry.order) {
    const runtime = registry.surfaces.get(sName)!;
    surfaceRevisions[sName] = runtime.catalog.revision;
    aggRevision += runtime.catalog.revision;
    if (runtime.state.kind !== 'ready') continue;
    if (filter?.surface && sName !== filter.surface) continue;

    for (const tool of runtime.catalog.tools) {
      if (filter?.method && tool.method !== filter.method.toUpperCase()) continue;
      if (filter?.sideEffect && tool.sideEffectClass !== filter.sideEffect) continue;
      if (filter?.pathPrefix && !tool.path.startsWith(filter.pathPrefix)) continue;
      if (filter?.confidence && tool.inputSchemaConfidence !== filter.confidence) continue;
      tools.push(tool);
    }
  }

  return { revision: aggRevision, tools, surfaceRevisions };
}

export function buildSurfaceSummary(runtime: SurfaceRuntime): SurfaceSummary {
  const { surface, state, catalog, pageCatalog, navigationCatalog } = runtime;
  const isReady = state.kind === 'ready';
  return {
    name: surface.name,
    stack: surface.stack,
    baseUrl: surface.baseUrl,
    state,
    toolCount: isReady ? catalog.tools.length : 0,
    pageCount: isReady ? pageCatalog.pages.length : 0,
    navigationCount: isReady ? navigationCatalog.navigations.length : 0,
    toolRevision: isReady ? catalog.revision : 0,
    capabilities: {
      listPages: surface.stack === 'vite',
      listNavigations: surface.stack === 'vite',
      enumerateRoutesRuntime: true,
      crawlSeed: surface.stack === 'vite',
    },
  };
}

export function buildSurfaceListResponse(registry: SurfaceRegistry): SurfaceListResponse {
  return {
    surfaceMcpVersion: getSurfaceMcpVersion(),
    surfaces: registry.order.map((name) => buildSurfaceSummary(registry.surfaces.get(name)!)),
  };
}

export function getMcpPort(config: Config): number {
  return config.mcpPort ?? config.surfaces[0]!.port;
}

/** Close every per-surface file watcher. Safe to call more than once. */
export async function closeRegistry(registry: SurfaceRegistry): Promise<void> {
  for (const name of registry.order) {
    const runtime = registry.surfaces.get(name);
    if (!runtime?.watcher) continue;
    try {
      await runtime.watcher.close();
    } catch (err) {
      log.warn({ surface: name, err }, 'watcher close failed');
    }
    runtime.watcher = undefined;
  }
}

