import { loadConfig, findConfigPath } from '../config.js';
import { loadEnvFiles } from '../env/indirection.js';
import { RoleMutex } from '../auth/role-mutex.js';
import { regenerateCatalog, getCatalog } from '../server/tools-meta.js';
import { resolve } from 'node:path';

type DoctorOptions = {
  projectRoot?: string;
};

export async function runDoctor(opts: DoctorOptions): Promise<void> {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  loadEnvFiles(projectRoot);

  const configPath = findConfigPath(projectRoot);
  let config;
  try {
    config = loadConfig(configPath);
    console.log('Config: OK');
  } catch (err) {
    console.error(`Config: FAIL — ${String(err)}`);
    process.exit(1);
  }

  const surface = config.surfaces[0]!;
  const root = resolve(projectRoot, surface.root);

  // Check baseUrl reachability
  try {
    const res = await fetch(surface.baseUrl, { signal: AbortSignal.timeout(3_000) });
    console.log(`Base URL (${surface.baseUrl}): ${res.status < 500 ? 'reachable' : 'error ' + res.status}`);
  } catch {
    console.warn(`Base URL (${surface.baseUrl}): unreachable`);
  }

  // Regenerate and count tools
  await regenerateCatalog(surface, root);
  const catalog = getCatalog();
  console.log(`Tools discovered: ${catalog.tools.length} (revision ${catalog.revision})`);

  // Login all roles
  const roleMutex = new RoleMutex(surface.baseUrl, surface.auth, surface.roles);
  const loginResults = await roleMutex.loginAll();

  for (const [role, result] of loginResults) {
    const session = roleMutex.getSession(role);
    console.log(
      `Role "${role}": ${result.ok ? 'OK' : 'FAIL — ' + result.error} (refreshCount=${session?.refreshCount ?? 0})`
    );
  }

  // Check suggested vs confirmed external integrations
  const suggested = surface._suggestedExternalIntegrations ?? [];
  const confirmed = surface.externalIntegrations ?? [];

  if (suggested.length > 0 && confirmed.length === 0) {
    console.warn(
      `\nWARN: ${suggested.length} _suggestedExternalIntegrations found but externalIntegrations is empty.`
    );
    console.warn('Review the suggestions in surfacemcp.config.json and move confirmed ones to externalIntegrations.');
    for (const s of suggested.slice(0, 5)) {
      console.warn(`  - ${s}`);
    }
  } else {
    console.log(`External integrations: ${confirmed.length} confirmed, ${suggested.length} suggested`);
  }

  console.log(`\nPort: ${surface.port}`);
  console.log('Run `pm2 save` after starting to persist across reboots.');
}
