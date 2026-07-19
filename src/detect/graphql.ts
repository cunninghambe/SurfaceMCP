import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', '.surfacemcp', '.next', 'build']);
const SDL_RE = /\.(graphql|gql)$/i;
const TS_RE = /\.(ts|tsx|js|mjs)$/i;
/** Deps that signal a code-first (decorator-driven) GraphQL schema. */
const CODE_FIRST_DEPS = ['type-graphql', '@nestjs/graphql'];
/** A resolver method carries @Query()/@Mutation(); a @Resolver() class groups them. */
const RESOLVER_DECORATOR_RE = /@(Resolver|Query|Mutation)\s*\(/;

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

/** True when package.json lists a code-first GraphQL dependency. */
function hasCodeFirstDep(root: string): boolean {
  const pkgPath = resolve(root, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as unknown;
    if (pkg === null || typeof pkg !== 'object') return false;
    const p = pkg as Record<string, unknown>;
    const deps = {
      ...((p.dependencies as Record<string, unknown> | undefined) ?? {}),
      ...((p.devDependencies as Record<string, unknown> | undefined) ?? {}),
    };
    return CODE_FIRST_DEPS.some((d) => d in deps);
  } catch {
    return false;
  }
}

/**
 * Depth-bounded walk for a source file carrying a `@Resolver`/`@Query`/`@Mutation`
 * decorator — the code-first counterpart of the SDL text scan. Bounded for the same
 * reason: a large monorepo shouldn't turn detection into a full-tree crawl.
 */
function resolverDecoratorExists(dir: string, depth: number): boolean {
  if (depth < 0 || !existsSync(dir)) return false;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && TS_RE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      try {
        if (RESOLVER_DECORATOR_RE.test(readFileSync(resolve(dir, entry.name), 'utf-8'))) return true;
      } catch {
        // unreadable — skip
      }
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
      if (resolverDecoratorExists(resolve(dir, entry.name), depth - 1)) return true;
    }
  }
  return false;
}

/**
 * Code-first GraphQL detection: a `type-graphql` / `@nestjs/graphql` dependency plus
 * a `@Resolver`/`@Query`/`@Mutation` decorator in source. Requiring both keeps a
 * project that merely lists the dep (or a stray decorator name) from being misread.
 *
 * NOTE on ordering: a `@nestjs/graphql` app that also exposes REST `@Controller`s is
 * classified `nestjs` (that detector runs first in detect/index.ts), so its resolvers
 * are not surfaced as GraphQL tools. A standalone `type-graphql` app — or a Nest app
 * with resolvers but no controllers — reaches this detector and is classified
 * `graphql`. See SPEC_GRAPHQL_STACK.md.
 */
function isCodeFirstGraphql(root: string): boolean {
  return hasCodeFirstDep(root) && resolverDecoratorExists(root, 4);
}

/**
 * GraphQL detection. Ordered AFTER the framework detectors in detect/index.ts so an
 * app that merely uses GraphQL client-side (codegen `.graphql` documents in a
 * Next.js/Vite app) is still classified by its framework. Matches either a
 * schema-first SDL surface or a code-first (decorator-driven) one.
 */
export function isGraphql(root: string): boolean {
  return sdlWithRootTypeExists(root, 3) || isCodeFirstGraphql(root);
}
