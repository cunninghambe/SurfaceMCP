import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function isVite(root: string): boolean {
  const hasViteConfig =
    existsSync(resolve(root, 'vite.config.js')) ||
    existsSync(resolve(root, 'vite.config.ts')) ||
    existsSync(resolve(root, 'vite.config.mjs'));
  if (!hasViteConfig) return false;

  const pkgPath = resolve(root, 'package.json');
  if (!existsSync(pkgPath)) return false;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
    const deps = {
      ...(pkg.dependencies as Record<string, unknown> | undefined ?? {}),
      ...(pkg.devDependencies as Record<string, unknown> | undefined ?? {}),
    };
    // Accept any supported router. v0.2 only ships react-router-dom support;
    // detection is forward-compatible to avoid having to touch detect again.
    return 'react-router-dom' in deps;
  } catch {
    return false;
  }
}
