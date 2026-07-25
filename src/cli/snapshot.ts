import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { loadConfig, findConfigPath } from '../config.js';
import { loadEnvFiles } from '../env/indirection.js';
import { regenerateCatalogForSurface, getCatalog } from '../server/tools-meta.js';
import { buildSnapshot, serializeSnapshot, type SurfaceSnapshot } from '../diff/snapshot.js';

export type SnapshotOptions = {
  projectRoot?: string;
  surface?: string;
  out?: string;
};

/**
 * Run extraction for one surface (no server, no login — same acquisition path as
 * `export`) and return it as a snapshot envelope. Shared with `diff`, which uses
 * it for the live side when `--after` is omitted.
 */
export async function extractLiveSnapshot(opts: {
  projectRoot?: string;
  surface?: string;
}): Promise<SurfaceSnapshot> {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  loadEnvFiles(projectRoot);
  const config = loadConfig(findConfigPath(projectRoot));

  const surface = opts.surface
    ? config.surfaces.find((s) => s.name === opts.surface)
    : config.surfaces[0];
  if (!surface) {
    console.error(
      `Surface not found: "${opts.surface}". Known: ${config.surfaces.map((s) => s.name).join(', ')}`
    );
    process.exit(1);
  }

  const root = resolve(projectRoot, surface.root);
  await regenerateCatalogForSurface(surface, root);
  return buildSnapshot(surface.name, getCatalog());
}

/**
 * Serialize the current tool catalog to a stable, committable JSON snapshot.
 * Prints to stdout, or writes to --out. Progress notes go to stderr.
 */
export async function runSnapshot(opts: SnapshotOptions): Promise<void> {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  const snapshot = await extractLiveSnapshot(opts);
  const json = serializeSnapshot(snapshot);

  if (opts.out) {
    const outPath = resolve(projectRoot, opts.out);
    writeFileSync(outPath, json);
    console.error(`Wrote ${snapshot.tools.length} tool(s) for surface "${snapshot.surface}" to ${outPath}`);
  } else {
    process.stdout.write(json);
  }
}
