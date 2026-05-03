import { loadConfig, findConfigPath } from '../config.js';
import { loadEnvFiles } from '../env/indirection.js';
import { regenerateCatalogForSurface, getCatalog } from '../server/tools-meta.js';
import { resolve } from 'node:path';

type RegenerateOptions = {
  projectRoot?: string;
};

export async function runRegenerate(opts: RegenerateOptions): Promise<void> {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  loadEnvFiles(projectRoot);
  const config = loadConfig(findConfigPath(projectRoot));
  const surface = config.surfaces[0]!;
  const root = resolve(projectRoot, surface.root);

  await regenerateCatalogForSurface(surface, root);
  const catalog = getCatalog();

  console.log(`Regenerated. Revision: ${catalog.revision}, Tools: ${catalog.tools.length}`);
  for (const t of catalog.tools.slice(0, 20)) {
    console.log(`  ${t.method} ${t.path}  [${t.inputSchemaConfidence}]`);
  }
  if (catalog.tools.length > 20) {
    console.log(`  ... and ${catalog.tools.length - 20} more`);
  }
}
