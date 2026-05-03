import { loadConfig, findConfigPath } from '../config.js';
import { loadEnvFiles } from '../env/indirection.js';
import { RoleMutex } from '../auth/role-mutex.js';
import { regenerateCatalogForSurface, getCatalog, getToolByName, getToolById } from '../server/tools-meta.js';
import { executeCall } from '../server/call.js';
import { resolve } from 'node:path';

type CallOptions = {
  tool: string;
  role: string;
  input: string;
  allowExternal?: boolean;
  projectRoot?: string;
};

export async function runCall(opts: CallOptions): Promise<void> {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  loadEnvFiles(projectRoot);
  const config = loadConfig(findConfigPath(projectRoot));
  const surface = config.surfaces[0]!;
  const root = resolve(projectRoot, surface.root);

  await regenerateCatalogForSurface(surface, root);
  const catalog = getCatalog();

  const tool = getToolByName(opts.tool) ?? getToolById(opts.tool);
  if (!tool) {
    console.error(`Tool not found: ${opts.tool}`);
    process.exit(1);
  }

  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(opts.input) as Record<string, unknown>;
  } catch {
    console.error('Invalid JSON input');
    process.exit(1);
  }

  const roleMutex = new RoleMutex(surface.baseUrl, surface.auth, surface.roles);
  await roleMutex.loginAll();

  const result = await executeCall({
    tool,
    role: opts.role,
    input,
    baseUrl: surface.baseUrl,
    projectName: surface.name,
    auth: surface.auth,
    roleMutex,
    revision: catalog.revision,
    allowExternal: opts.allowExternal,
    currentRevision: catalog.revision,
  });

  console.log(JSON.stringify(result, null, 2));
}
