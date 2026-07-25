import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', '.surfacemcp', '.next', 'build']);
const TS_RE = /\.(ts|tsx|js|mjs)$/i;

/**
 * The server package. `@trpc/client` / `@trpc/react-query` are deliberately NOT
 * accepted: a consumer of someone else's tRPC API has no router to introspect.
 */
const SERVER_DEP = '@trpc/server';

/** `initTRPC.create()` / `initTRPC.context<…>().create()` — the router builder root. */
const INIT_TRPC_RE = /\binitTRPC\b/;
/** The conventional procedure bindings a tRPC router file exposes. */
const PROCEDURE_RE = /\b(?:publicProcedure|protectedProcedure)\b/;
/** A router constructor invoked with an object literal of procedures. */
const ROUTER_CALL_RE = /\b(?:createTRPCRouter|router)\s*\(\s*\{/;

/** True when package.json lists `@trpc/server` as a direct (dev)dependency. */
function hasServerDep(root: string): boolean {
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
    return SERVER_DEP in deps;
  } catch {
    return false;
  }
}

/**
 * Depth-bounded walk for a file that actually *builds* a tRPC router: either an
 * `initTRPC` call, or a `publicProcedure`/`protectedProcedure` binding together with
 * a `router({ … })` / `createTRPCRouter({ … })` call in the same file. The walk is
 * bounded so a large monorepo can't turn detection into a full-tree crawl; the T3
 * layout (`src/server/api/routers/*.ts`) sits inside the budget.
 */
function trpcServerSignalExists(dir: string, depth: number): boolean {
  if (depth < 0 || !existsSync(dir)) return false;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !TS_RE.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
    try {
      const text = readFileSync(resolve(dir, entry.name), 'utf-8');
      if (INIT_TRPC_RE.test(text)) return true;
      if (PROCEDURE_RE.test(text) && ROUTER_CALL_RE.test(text)) return true;
    } catch {
      // unreadable — skip
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
      if (trpcServerSignalExists(resolve(dir, entry.name), depth - 1)) return true;
    }
  }
  return false;
}

/**
 * tRPC detection: a direct `@trpc/server` dependency AND a source file that builds a
 * router. Both are required — a Next.js app that only *consumes* a remote tRPC API
 * commonly lists `@trpc/server` for its type imports, and would false-positive on the
 * dependency alone.
 *
 * NOTE on ordering: this runs FIRST in detect/index.ts, ahead of `nextjs`. tRPC is
 * overwhelmingly deployed inside a Next.js app (the T3 stack), where the entire
 * programmatic surface is the tRPC router and the only Next route handler is the
 * `app/api/trpc/[trpc]/route.ts` catch-all adapter. Detecting `nextjs` first would
 * surface that single opaque catch-all instead of every procedure, so the more
 * specific signal wins. The cost is documented in SPEC_TRPC_STACK.md: a hybrid app
 * with both tRPC and hand-written REST route handlers surfaces only its procedures
 * (multi-stack-per-root is out of scope).
 */
export function isTrpc(root: string): boolean {
  return hasServerDep(root) && trpcServerSignalExists(root, 4);
}
