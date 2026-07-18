import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', '.surfacemcp', '.next', 'build']);
const SDL_RE = /\.(graphql|gql)$/i;

/**
 * Depth-bounded walk looking for a `.graphql` / `.gql` SDL file whose text declares
 * a `type Query` or `type Mutation` root. The walk is bounded so a large monorepo
 * can't turn detection into a full-tree crawl; a schema-first project keeps its SDL
 * at or near the root (root, `src/`, `schema/`, `graphql/`). Requiring a root type
 * keeps a stray fragment or `.graphql` codegen artifact in a Next.js/Vite app from
 * being mistaken for a standalone GraphQL surface.
 */
function sdlWithRootTypeExists(dir: string, depth: number): boolean {
  if (depth < 0 || !existsSync(dir)) return false;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && SDL_RE.test(entry.name)) {
      try {
        const text = readFileSync(resolve(dir, entry.name), 'utf-8');
        if (/\btype\s+Query\b/.test(text) || /\btype\s+Mutation\b/.test(text)) return true;
      } catch {
        // unreadable — skip
      }
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
      if (sdlWithRootTypeExists(resolve(dir, entry.name), depth - 1)) return true;
    }
  }
  return false;
}

/**
 * Schema-first GraphQL detection. Ordered AFTER the framework detectors in
 * detect/index.ts so an app that merely uses GraphQL client-side (codegen
 * `.graphql` documents in a Next.js/Vite app) is still classified by its framework.
 */
export function isGraphql(root: string): boolean {
  return sdlWithRootTypeExists(root, 3);
}
