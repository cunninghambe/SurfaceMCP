import { resolve } from 'node:path';
import { writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { loadConfig, findConfigPath } from '../config.js';
import { loadEnvFiles } from '../env/indirection.js';
import { regenerateCatalogForSurface, getCatalog } from '../server/tools-meta.js';
import { buildOpenApiResult } from '../export/openapi.js';

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

  const { document, skippedNonRest } = buildOpenApiResult(catalog.tools, {
    title: `${surface.name} (SurfaceMCP)`,
    version: readVersion(),
    baseUrl: surface.baseUrl,
  });
  const json = JSON.stringify(document, null, 2);

  if (skippedNonRest > 0) {
    console.error(
      `Note: skipped ${skippedNonRest} GraphQL/tRPC operation(s) — those operations share a single endpoint and don't map to REST paths. Use the GraphQL SDL/introspection or the tRPC router types for that surface instead.`
    );
  }

  const restCount = catalog.tools.length - skippedNonRest;
  if (opts.out) {
    // `--out` is a user-supplied destination on a user-run CLI, so writing outside
    // the project root (`--out ../api.json`, or an absolute path) is intended and
    // stays allowed — the caller already has the operator's own privileges. Guard
    // only the two surprising outcomes: a NUL byte, and silently "succeeding" onto
    // a directory (writeFileSync would throw EISDIR with a raw stack trace).
    if (opts.out.includes('\0')) {
      console.error('Invalid --out path: contains a NUL byte');
      process.exit(1);
      return;
    }
    const outPath = resolve(projectRoot, opts.out);
    if (existsSync(outPath) && statSync(outPath).isDirectory()) {
      console.error(`Invalid --out path: ${outPath} is a directory`);
      process.exit(1);
      return;
    }
    // Overwrite stays silent — it matches shell-redirection expectations and the
    // CLI is re-run against the same file routinely.
    writeFileSync(outPath, `${json}\n`);
    console.error(`Wrote ${restCount} operation(s) to ${outPath}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}
