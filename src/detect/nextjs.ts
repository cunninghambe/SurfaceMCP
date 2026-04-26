import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function isNextjs(root: string): boolean {
  const nextConfig =
    existsSync(resolve(root, 'next.config.js')) ||
    existsSync(resolve(root, 'next.config.ts')) ||
    existsSync(resolve(root, 'next.config.mjs'));

  if (!nextConfig) return false;

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
    return 'next' in deps;
  } catch {
    return false;
  }
}
