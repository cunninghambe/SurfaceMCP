// Graceful shutdown for the MCP server process. Without this, SIGINT/SIGTERM
// left the HTTP server, chokidar watchers, and any spawned dev-server children
// dangling — orphaned processes and leaked file handles on every restart.

import type { Server } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import type { SurfaceRegistry } from '../types.js';
import { closeRegistry } from './registry.js';
import { log } from '../log.js';

export type ShutdownTargets = {
  registry?: SurfaceRegistry;
  /** Dev-server child processes launched by `serve`. */
  children?: ChildProcess[];
  /** Hard-exit deadline if graceful close stalls. */
  forceExitMs?: number;
};

/**
 * Install SIGINT/SIGTERM handlers that close the HTTP server, close all file
 * watchers, and terminate tracked child processes, then exit. Idempotent per
 * process; a second signal is ignored while a shutdown is already in flight.
 */
export function installShutdown(server: Server, targets: ShutdownTargets = {}): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');

    const force = setTimeout(() => {
      log.warn({ ms: targets.forceExitMs ?? 5_000 }, 'graceful shutdown timed out — forcing exit');
      process.exit(0);
    }, targets.forceExitMs ?? 5_000);
    force.unref();

    try {
      for (const child of targets.children ?? []) {
        if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
      }
      if (targets.registry) await closeRegistry(targets.registry);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } catch (err) {
      log.warn({ err }, 'error during shutdown');
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
