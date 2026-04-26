import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, findConfigPath } from '../config.js';
import { loadEnvFiles } from '../env/indirection.js';
import { createApp } from '../server/http.js';
import { log } from '../log.js';

type ServeOptions = {
  projectRoot?: string;
  configPath?: string;
};

async function waitForBaseUrl(baseUrl: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.status < 500) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

export async function runServe(opts: ServeOptions): Promise<void> {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  const configPath = opts.configPath ?? findConfigPath(projectRoot);

  loadEnvFiles(projectRoot);
  const config = loadConfig(configPath);

  // For now, serve first surface
  const surface = config.surfaces[0]!;
  const resolvedRoot = resolve(projectRoot, surface.root);

  // Auto-launch dev server if configured and baseUrl unreachable
  if (surface.launchDevCommand) {
    try {
      const res = await fetch(surface.baseUrl, { signal: AbortSignal.timeout(2_000) });
      if (res.status >= 500) throw new Error('server error');
    } catch {
      log.info({ cmd: surface.launchDevCommand }, 'baseUrl unreachable — launching dev server');
      const devProc = spawn(surface.launchDevCommand, {
        shell: true,
        cwd: resolvedRoot,
        stdio: 'inherit',
        detached: false,
      });
      devProc.on('error', (err) => log.error({ err }, 'dev server launch error'));

      const ready = await waitForBaseUrl(surface.baseUrl);
      if (!ready) {
        log.warn({ baseUrl: surface.baseUrl }, 'dev server did not become ready in 60s — proceeding anyway');
      }
    }
  }

  const app = await createApp(surface, resolvedRoot);
  app.listen(surface.port, '127.0.0.1', () => {
    log.info(
      { port: surface.port, endpoint: `http://127.0.0.1:${surface.port}/mcp` },
      `SurfaceMCP ${surface.name} listening`
    );
  });
}
