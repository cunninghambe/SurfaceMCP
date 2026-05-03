import { loadConfig, findConfigPath } from '../config.js';
import { loadEnvFiles } from '../env/indirection.js';
import { RoleMutex } from '../auth/role-mutex.js';
import { regenerateCatalogForSurface, getCatalog, getToolByName, getToolById } from '../server/tools-meta.js';
import { executeCall } from '../server/call.js';
import { recoverFromZodError } from '../probe/zod-error.js';
import { recoverFromPydanticError } from '../probe/pydantic-error.js';
import { recoverFromDrfError } from '../probe/drf-error.js';
import { recoverFromFastApiError } from '../probe/fastapi-error.js';
import { resolve } from 'node:path';

type ProbeOptions = {
  tool: string;
  role: string;
  projectRoot?: string;
};

export async function runProbe(opts: ProbeOptions): Promise<void> {
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

  const roleMutex = new RoleMutex(surface.baseUrl, surface.auth, surface.roles);
  await roleMutex.loginAll();

  const result = await executeCall({
    tool,
    role: opts.role,
    input: {},
    baseUrl: surface.baseUrl,
    projectName: surface.name,
    auth: surface.auth,
    roleMutex,
    revision: catalog.revision,
    noAutoRelogin: true,
    currentRevision: catalog.revision,
  });

  const body = result.body;
  const recovered =
    recoverFromZodError(body) ??
    recoverFromFastApiError(body) ??
    recoverFromPydanticError(body) ??
    recoverFromDrfError(body);

  if (recovered) {
    console.log('\nRecovered schema (confidence: inferred):');
    console.log(JSON.stringify(recovered, null, 2));
  } else {
    console.log('\nNo schema recoverable (confidence: unknown). Raw error:');
    console.log(JSON.stringify(body, null, 2));
  }
}
