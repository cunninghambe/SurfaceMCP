import { loadConfig, findConfigPath, findLiteralCredentialPaths } from '../config.js';
import { loadEnvFiles } from '../env/indirection.js';
import { RoleMutex } from '../auth/role-mutex.js';
import { isInsecureTokenUrl, missingOAuth2CredentialKeys } from '../auth/oauth2.js';
import { regenerateCatalogForSurface, getCatalog } from '../server/tools-meta.js';
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

  // Warn on inline literal credentials — secrets belong in a gitignored env file.
  const literalCreds = findLiteralCredentialPaths(config);
  if (literalCreds.length > 0) {
    console.warn(
      `\nWARN: ${literalCreds.length} credential value(s) are inline literals, not $env: indirection:`
    );
    for (const p of literalCreds) console.warn(`  - ${p}`);
    console.warn('Move secrets to a gitignored .env.local and reference them as $env:VAR.');
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

  // OAuth2: validate the token endpoint + credential presence before loginAll()
  // actually mints tokens below. Reports key names and statuses only.
  if (surface.auth.kind === 'oauth2') {
    const { tokenUrl } = surface.auth;
    if (isInsecureTokenUrl(tokenUrl)) {
      console.warn(
        `\nWARN: OAuth2 tokenUrl (${tokenUrl}) is neither https nor loopback — the client secret would cross the network in cleartext.`
      );
    }
    try {
      // GET, not POST: a reachability probe must never send client credentials.
      // A 4xx (typically 405/400) still proves the endpoint is answering.
      const res = await fetch(tokenUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(3_000),
      });
      console.log(`OAuth2 token URL (${tokenUrl}): ${res.status < 500 ? 'reachable' : 'error ' + res.status} (status ${res.status})`);
    } catch {
      console.warn(`OAuth2 token URL (${tokenUrl}): unreachable`);
    }
    for (const role of surface.roles) {
      const missing = missingOAuth2CredentialKeys(role.credentials ?? {});
      if (role.credentials && Object.keys(role.credentials).length > 0 && missing.length > 0) {
        console.warn(
          `WARN: role "${role.name}" is missing OAuth2 credential(s): ${missing.join(', ')} (set them in .env.local and reference as $env:VAR)`
        );
      }
    }
  }

  // Regenerate and count tools
  await regenerateCatalogForSurface(surface, root);
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
