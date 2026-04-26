import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';

const PORT_MIN = 3102;
const PORT_MAX = 3199;
const REGISTRY_GLOB_ROOT = '/root';

function getTakenPorts(registryRoot: string): Set<number> {
  const taken = new Set<number>();
  const registryGlob = process.env.SURFACEMCP_REGISTRY_GLOB ?? registryRoot;

  let dirs: string[] = [];
  try {
    dirs = readdirSync(registryGlob, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => `${registryGlob}/${d.name}`);
  } catch {
    return taken;
  }

  for (const dir of dirs) {
    const configPath = `${dir}/surfacemcp.config.json`;
    if (!existsSync(configPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown;
      if (
        raw !== null &&
        typeof raw === 'object' &&
        'surfaces' in raw &&
        Array.isArray((raw as { surfaces: unknown }).surfaces)
      ) {
        for (const surface of (raw as { surfaces: unknown[] }).surfaces) {
          if (
            surface !== null &&
            typeof surface === 'object' &&
            'port' in surface &&
            typeof (surface as { port: unknown }).port === 'number'
          ) {
            taken.add((surface as { port: number }).port);
          }
        }
      }
    } catch {
      // malformed config — skip
    }
  }
  return taken;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
    server.on('error', () => resolve(false));
  });
}

export async function allocatePort(): Promise<number> {
  const taken = getTakenPorts(REGISTRY_GLOB_ROOT);

  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    if (taken.has(port)) continue;
    const free = await isPortFree(port);
    if (free) return port;
  }

  throw new Error(`No free port available in ${PORT_MIN}–${PORT_MAX}. Check running SurfaceMCP instances.`);
}
