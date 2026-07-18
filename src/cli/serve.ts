import { resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { loadConfig, findConfigPath } from '../config.js';
import { loadEnvFiles } from '../env/indirection.js';
import { createApp } from '../server/http.js';
import { getMcpPort } from '../server/registry.js';
import { installShutdown } from '../server/shutdown.js';
import type { SurfaceRegistry, SurfaceConfig } from '../types.js';
import { log } from '../log.js';

type ServeOptions = {
  projectRoot?: string;
  configPath?: string;
};

async function waitForBaseUrl(baseUrl: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl, { signal: AbortSignal.timeout(2_000) });
      if (res.status < 500) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

/**
 * Launch a surface's dev server if its baseUrl isn't already reachable. Runs in
 * the background (never awaited by startup) so the MCP endpoint isn't held up.
 */
async function launchDevServer(
  surface: SurfaceConfig,
  projectRoot: string,
  devChildren: ChildProcess[],
): Promise<void> {
  if (!surface.launchDevCommand) return;
  const resolvedRoot = resolve(projectRoot, surface.root);
  try {
    const res = await fetch(surface.baseUrl, { signal: AbortSignal.timeout(2_000) });
    if (res.status < 500) return; // already running
  } catch {
    // not reachable — launch it below
  }
  log.info({ surface: surface.name, cmd: surface.launchDevCommand }, 'baseUrl unreachable — launching dev server');
  const devProc = spawn(surface.launchDevCommand, {
    shell: true,
    cwd: resolvedRoot,
    stdio: 'inherit',
    detached: false,
  });
  devChildren.push(devProc);
  devProc.on('error', (err) => log.error({ surface: surface.name, err }, 'dev server launch error'));
  const ready = await waitForBaseUrl(surface.baseUrl);
  if (!ready) {
    log.warn({ surface: surface.name, baseUrl: surface.baseUrl }, 'dev server did not become ready in 60s');
  }
}

export async function runServe(opts: ServeOptions): Promise<void> {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  const configPath = opts.configPath ?? process.env.SURFACEMCP_CONFIG ?? findConfigPath(projectRoot);

  loadEnvFiles(projectRoot);
  const config = loadConfig(configPath);

  // Dev-server children we launch, so shutdown can terminate them.
  const devChildren: ChildProcess[] = [];

  // Launch dev servers in the background. The MCP endpoint must come up
  // immediately and stay responsive — it must NOT block for up to 60s waiting on
  // an unreachable target (that made the e2e suite untrustworthy). Extraction is
  // static and login is lazy (on first surface_call), so the target only needs to
  // be reachable by the time an authenticated call is made, not at startup.
  for (const surface of config.surfaces) {
    if (!surface.launchDevCommand) continue;
    void launchDevServer(surface, projectRoot, devChildren);
  }

  const port = getMcpPort(config);
  const app = await createApp(config, projectRoot);
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
  installShutdown(server, {
    registry: app.locals.registry as SurfaceRegistry | undefined,
    children: devChildren,
  });
}
