import { writeFileSync, existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { detectStack } from '../detect/index.js';
import { detectMultiSurface } from '../detect/monorepo.js';
import { allocatePort } from '../port/allocator.js';
import { detectExternalIntegrations } from '../classify/grep-init.js';
import type { Config, SurfaceConfig } from '../types.js';
import { log } from '../log.js';

type InitOptions = {
  stack?: string;
  baseUrl?: string;
  projectRoot?: string;
  multiSurface?: boolean;
  noInteractive?: boolean;
};

/**
 * Read the project's package.json dev script and extract the Next.js dev port if specified.
 * Handles: -p <port>, --port <port>, --port=<port>, PORT=<port> next dev.
 * Returns undefined on any parse failure so the caller falls back to the default.
 */
export function detectNextjsDevPort(projectRoot: string): number | undefined {
  try {
    const pkgPath = resolve(projectRoot, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
    const scripts = pkg['scripts'];
    if (!scripts || typeof scripts !== 'object') return undefined;
    const devScript = (scripts as Record<string, unknown>)['dev'];
    if (typeof devScript !== 'string') return undefined;

    const patterns = [
      /next\s+dev\s+(?:\S+\s+)*-p\s+(\d+)/,
      /next\s+dev\s+(?:\S+\s+)*--port\s+(\d+)/,
      /next\s+dev\s+(?:\S+\s+)*--port=(\d+)/,
      /PORT=(\d+)\s+next\s+dev/,
    ];
    for (const re of patterns) {
      const m = re.exec(devScript);
      if (m) return parseInt(m[1], 10);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse the project's package.json dev script for a Vite port flag.
 * Handles: --port <n>, --port=<n>, vite --port <n>.
 * Falls back to the server.port in vite.config.{ts,js,mjs} if statically declarable.
 * Returns undefined on any parse failure so the caller falls back to the default 5173.
 */
export function detectViteDevPort(projectRoot: string): number | undefined {
  try {
    const pkgPath = resolve(projectRoot, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
    const scripts = pkg['scripts'];
    if (scripts && typeof scripts === 'object') {
      const devScript = (scripts as Record<string, unknown>)['dev'];
      if (typeof devScript === 'string') {
        const patterns = [
          /vite\s+(?:\S+\s+)*--port\s+(\d+)/,
          /vite\s+(?:\S+\s+)*--port=(\d+)/,
        ];
        for (const re of patterns) {
          const m = re.exec(devScript);
          if (m) return parseInt(m[1], 10);
        }
      }
    }
  } catch {
    // fall through to config parse
  }
  // Check vite.config.ts/js for server.port
  const configCandidates = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'];
  for (const configFile of configCandidates) {
    try {
      const text = readFileSync(resolve(projectRoot, configFile), 'utf-8');
      const m = /server\s*:\s*\{[^}]*port\s*:\s*(\d+)/s.exec(text);
      if (m) return parseInt(m[1], 10);
    } catch {
      // skip
    }
  }
  return undefined;
}

function defaultLaunchCommand(stack: string): string | undefined {
  const cmds: Record<string, string> = {
    nextjs: 'npm run dev',
    vite: 'npm run dev',
    express: 'npm run dev',
    fastify: 'npm run dev',
    fastapi: 'uvicorn main:app --reload',
    django: 'python manage.py runserver',
  };
  return cmds[stack];
}

function defaultBaseUrl(stack: string): string {
  const urls: Record<string, string> = {
    nextjs: 'http://localhost:3000',
    vite: 'http://localhost:5173',
    express: 'http://localhost:3001',
    fastify: 'http://localhost:3000',
    fastapi: 'http://localhost:8000',
    django: 'http://localhost:8000',
    openapi: 'http://localhost:3000',
  };
  return urls[stack] ?? 'http://localhost:3000';
}

function defaultWatchPaths(stack: string): string[] {
  const paths: Record<string, string[]> = {
    nextjs: ['app', 'pages', 'src'],
    vite: ['src'],
    express: ['src', '.'],
    fastify: ['src', '.'],
    fastapi: ['.'],
    django: ['.'],
    openapi: ['.'],
  };
  return paths[stack] ?? ['src'];
}

async function buildSurfaceConfig(
  name: string,
  root: string,
  stack: string,
  baseUrl: string
): Promise<SurfaceConfig> {
  const port = await allocatePort();

  const integrations = detectExternalIntegrations(root);
  const suggestedExternal = integrations.flatMap((i) => i.files.slice(0, 3));

  return {
    name,
    stack: stack as SurfaceConfig['stack'],
    root: '.',
    baseUrl,
    port,
    launchDevCommand: defaultLaunchCommand(stack),
    watchPaths: defaultWatchPaths(stack),
    watchIgnore: [],
    auth: { kind: 'none' },
    roles: [],
    excludedRoutes: [],
    externalIntegrations: [],
    _suggestedExternalIntegrations: suggestedExternal,
  };
}

export async function runInit(opts: InitOptions): Promise<void> {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  const configPath = resolve(projectRoot, 'surfacemcp.config.json');

  if (existsSync(configPath)) {
    log.warn({ configPath }, 'surfacemcp.config.json already exists; skipping init');
    return;
  }

  let surfaces: SurfaceConfig[] = [];

  if (opts.multiSurface) {
    const detected = detectMultiSurface(projectRoot);
    if (detected.length === 0) {
      throw new Error('No recognizable stacks found in subdirectories. Use --stack to override.');
    }
    for (const d of detected) {
      const surface = await buildSurfaceConfig(d.name, d.root, d.stack, defaultBaseUrl(d.stack));
      surface.root = d.root.replace(projectRoot + '/', '');
      surfaces.push(surface);
    }
  } else {
    const stackOverride = opts.stack;
    const detected = stackOverride ?? detectStack(projectRoot);
    if (!detected) {
      throw new Error(
        'Could not detect stack. Use --stack=<nextjs|vite|express|fastify|fastapi|django|openapi> to override.'
      );
    }
    // Hint: Vite present but no recognized router — manual config needed
    if (detected !== 'vite') {
      const hasViteConfig =
        existsSync(join(projectRoot, 'vite.config.js')) ||
        existsSync(join(projectRoot, 'vite.config.ts')) ||
        existsSync(join(projectRoot, 'vite.config.mjs'));
      if (hasViteConfig) {
        console.log(
          'Vite detected but no recognized router. If this app routes via custom code ' +
          '(tab-state, hand-rolled history), set stack: "vite" manually in ' +
          'surfacemcp.config.json and SurfaceMCP will return a crawl seed.'
        );
      }
    }
    const detectedPort =
      detected === 'nextjs' ? detectNextjsDevPort(projectRoot) :
      detected === 'vite' ? detectViteDevPort(projectRoot) :
      undefined;
    const baseUrl =
      opts.baseUrl ??
      (detectedPort !== undefined ? `http://localhost:${detectedPort}` : defaultBaseUrl(detected));
    const surface = await buildSurfaceConfig('web', projectRoot, detected, baseUrl);
    surfaces = [surface];
  }

  const config: Config = { surfaces };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  log.info({ configPath }, 'Wrote surfacemcp.config.json');

  // Write .gitignore entries
  const gitignorePath = resolve(projectRoot, '.gitignore');
  const gitignoreEntries = '\n# SurfaceMCP\n.surfacemcp/\n.env.local\n';
  if (existsSync(gitignorePath)) {
    const current = readFileSync(gitignorePath, 'utf-8');
    if (!current.includes('.surfacemcp/')) {
      appendFileSync(gitignorePath, gitignoreEntries);
    }
  } else {
    writeFileSync(gitignorePath, gitignoreEntries);
  }

  // Write .env.example
  const envExamplePath = resolve(projectRoot, '.env.example');
  if (!existsSync(envExamplePath)) {
    writeFileSync(envExamplePath, '# SurfaceMCP role credentials\n# OWNER_PASSWORD=\n');
  }

  // Write pm2 ecosystem config
  const templatePath = resolve(
    new URL('../../ecosystem.config.cjs.template', import.meta.url).pathname
  );
  if (existsSync(templatePath)) {
    const template = readFileSync(templatePath, 'utf-8');
    const logDir = resolve(projectRoot, '.surfacemcp', 'logs');
    mkdirSync(logDir, { recursive: true });

    const surfacemcpBin = process.argv[1] ?? 'surfacemcp';
    const rendered = template
      .replace(/\{\{PROJECT_NAME\}\}/g, surfaces[0]?.name ?? 'web')
      .replace(/\{\{SURFACEMCP_BIN\}\}/g, surfacemcpBin)
      .replace(/\{\{PROJECT_ROOT\}\}/g, projectRoot)
      .replace(/\{\{CONFIG_PATH\}\}/g, configPath)
      .replace(/\{\{LOG_DIR\}\}/g, logDir);

    const ecosystemPath = resolve(projectRoot, 'ecosystem.config.cjs');
    writeFileSync(ecosystemPath, rendered);
    log.info({ ecosystemPath }, 'Wrote ecosystem.config.cjs');
  }

  if (surfaces[0]?._suggestedExternalIntegrations?.length) {
    log.info(
      { files: surfaces[0]._suggestedExternalIntegrations },
      'Suggested external integrations found — review _suggestedExternalIntegrations in config and move to externalIntegrations when confirmed'
    );
  }
}
