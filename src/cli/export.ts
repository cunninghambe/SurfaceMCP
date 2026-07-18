import { resolve } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { loadConfig, findConfigPath } from '../config.js';
import { loadEnvFiles } from '../env/indirection.js';
import { regenerateCatalogForSurface, getCatalog } from '../server/tools-meta.js';
import { buildOpenApiDocument } from '../export/openapi.js';

type ExportOptions = {
  projectRoot?: string;
  surface?: string;
  out?: string;
};

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

/**
 * Emit an OpenAPI 3.1 document for the discovered surface (extraction only — no
 * server, no login). Prints to stdout, or writes to --out.
 */
export async function runExport(opts: ExportOptions): Promise<void> {
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
    return;
  }

  const root = resolve(projectRoot, surface.root);
  await regenerateCatalogForSurface(surface, root);
  const catalog = getCatalog();

  const doc = buildOpenApiDocument(catalog.tools, {
    title: `${surface.name} (SurfaceMCP)`,
    version: readVersion(),
    baseUrl: surface.baseUrl,
  });
  const json = JSON.stringify(doc, null, 2);

  if (opts.out) {
    const outPath = resolve(projectRoot, opts.out);
    writeFileSync(outPath, `${json}\n`);
    console.error(`Wrote ${catalog.tools.length} operations to ${outPath}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}
