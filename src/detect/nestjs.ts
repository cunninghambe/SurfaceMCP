import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

function hasNestInDeps(root: string): boolean {
  const pkgPath = resolve(root, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as unknown;
    if (pkg === null || typeof pkg !== 'object') return false;
    const p = pkg as Record<string, unknown>;
    const deps = {
      ...(p.dependencies as Record<string, unknown> | undefined ?? {}),
      ...(p.devDependencies as Record<string, unknown> | undefined ?? {}),
    };
    // Key on @nestjs/core — the framework runtime every Nest app depends on.
    // A Nest app usually pulls express/fastify only transitively (via
    // @nestjs/platform-express|fastify), so the deps gate alone already
    // distinguishes it; the source signal below confirms it.
    return '@nestjs/core' in deps;
  } catch {
    return false;
  }
}

/**
 * Nest-specific source signal. A route is only declared via a `@Controller`
 * class that imports from `@nestjs/common`, so we scan source for either the
 * `@Controller(` decorator or an `@nestjs/common` import. Controllers live in
 * their own `*.controller.ts` files (not the `main.ts` entry), so — unlike the
 * Express/Fastify detectors — we walk the source tree rather than a fixed set
 * of entry files, returning as soon as the first marker is found.
 */
function hasNestSource(root: string): boolean {
  const MARKER = /@Controller\s*\(|from\s+['"]@nestjs\/common['"]|require\(\s*['"]@nestjs\/common['"]\s*\)/;

  function scan(dir: string): boolean {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
          continue;
        }
        if (scan(full)) return true;
      } else if (/\.(ts|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        try {
          if (MARKER.test(readFileSync(full, 'utf-8'))) return true;
        } catch {
          // skip unreadable file
        }
      }
    }
    return false;
  }

  return scan(root);
}

export function isNestjs(root: string): boolean {
  return hasNestInDeps(root) && hasNestSource(root);
}
