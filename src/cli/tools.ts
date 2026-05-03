import { loadConfig, findConfigPath } from '../config.js';
import { loadEnvFiles } from '../env/indirection.js';
import { regenerateCatalogForSurface } from '../server/tools-meta.js';
import { resolve } from 'node:path';
import type { ToolMeta } from '../types.js';

type ToolsOptions = {
  filter?: string;
  confidence?: string;
  projectRoot?: string;
};

export async function runTools(opts: ToolsOptions): Promise<void> {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  loadEnvFiles(projectRoot);
  const config = loadConfig(findConfigPath(projectRoot));
  const surface = config.surfaces[0]!;
  const root = resolve(projectRoot, surface.root);

  await regenerateCatalogForSurface(surface, root);

  const { getCatalog } = await import('../server/tools-meta.js');
  const catalog = getCatalog();

  let tools: ToolMeta[] = catalog.tools;

  if (opts.filter) {
    const f = opts.filter.toLowerCase();
    tools = tools.filter(
      (t) =>
        t.name.toLowerCase().includes(f) ||
        t.path.toLowerCase().includes(f) ||
        t.method.toLowerCase().includes(f)
    );
  }

  if (opts.confidence) {
    tools = tools.filter((t) => t.inputSchemaConfidence === opts.confidence);
  }

  console.log(`\nRevision: ${catalog.revision} | Found ${tools.length} tools\n`);
  for (const t of tools) {
    console.log(
      `  ${t.method.padEnd(7)} ${t.path.padEnd(40)} [${t.inputSchemaConfidence}] [${t.sideEffectClass}]`
    );
    console.log(`    name=${t.name}  toolId=${t.toolId}`);
  }
}
