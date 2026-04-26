import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectStack } from './index.js';
import type { Stack } from '../types.js';

export type DetectedSurface = {
  name: string;
  root: string;
  stack: Stack;
};

/**
 * Walk one level of subdirectories and detect a stack in each.
 * Used by `init --multi-surface`.
 */
export function detectMultiSurface(repoRoot: string): DetectedSurface[] {
  const results: DetectedSurface[] = [];

  // Also check the root itself
  const rootStack = detectStack(repoRoot);
  if (rootStack) {
    results.push({ name: 'root', root: repoRoot, stack: rootStack });
  }

  let subdirs: string[] = [];
  try {
    subdirs = readdirSync(repoRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => resolve(repoRoot, d.name));
  } catch {
    return results;
  }

  for (const subdir of subdirs) {
    if (!existsSync(subdir)) continue;
    const stack = detectStack(subdir);
    if (stack) {
      const name = subdir.split('/').pop() ?? subdir;
      results.push({ name, root: subdir, stack });
    }
  }

  return results;
}
