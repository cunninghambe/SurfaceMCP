// #target-code-exec: schema introspection can `await import(...)` a file from the
// TARGET project so a zod schema can be read off the live module object. That
// EXECUTES target-project code (module top level, and anything it imports) inside
// the SurfaceMCP process — at every extraction and at every file-watcher regen.
//
// The feature is genuinely useful (it is the only way to resolve a schema behind a
// re-export or a runtime composition), so it stays on by default. This module is
// the choke point that makes it auditable and bounded:
//
//   1. `schemaIntrospection.dynamicImport: false` turns it off per surface.
//   2. The module must resolve INSIDE the surface root, after realpath on both
//      sides — so a `../../../etc/…` specifier, or a symlink pointing out of the
//      project, is refused instead of executed.
//   3. Every import that does happen is logged at warn level with its path.
//
// It is NOT a sandbox: a hostile file inside the surface root still runs with the
// SurfaceMCP process's privileges. See SPEC_SECURITY_HARDENING.md §3.6 for the
// trust assumption this documents.

import { realpathSync } from 'node:fs';
import { isContainedPath } from '../server/path-guard.js';
import { log } from '../log.js';

export type DynamicImportPolicy = {
  /** Surface root. The resolved module must sit at or under this directory. */
  root: string;
  /** `false` disables dynamic import for this surface. Defaults to enabled. */
  enabled?: boolean;
};

/** Paths already announced in the log; see the audit-trail note in importTargetModule. */
const loggedImports = new Set<string>();

/** Test seam: forget which paths have been logged. */
export function resetDynamicImportLogState(): void {
  loggedImports.clear();
}

/** True unless the surface explicitly opted out. */
export function isDynamicImportEnabled(policy: DynamicImportPolicy | undefined): boolean {
  return policy !== undefined && policy.enabled !== false;
}

/**
 * Realpath `absPath` and `root` and return the real path when it is contained by
 * the real root; `null` when it escapes, does not exist, or cannot be resolved.
 * Realpathing both sides is what closes the symlink-escape hole — a file inside
 * the project that links to `/etc/…` resolves out of the root and is refused.
 */
export function resolveContainedRealPath(root: string, absPath: string): string | null {
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathSync(root);
    realTarget = realpathSync(absPath);
  } catch {
    return null;
  }
  return isContainedPath(realRoot, realTarget) ? realTarget : null;
}

/**
 * Import a module from the target project, subject to {@link DynamicImportPolicy}.
 * Returns the module namespace, or `null` when the import is disabled, escapes the
 * surface root, or fails.
 *
 * The specifier passed to `import()` is the containment-checked real path, exactly
 * as the previous inline call sites passed it — deliberately NOT converted to a
 * `file://` URL, because that would newly enable execution on Windows (where a
 * bare `C:\…` specifier has always thrown `ERR_UNSUPPORTED_ESM_URL_SCHEME`).
 *
 * @param reason short label for the log line, e.g. 'nextjs route schema'.
 */
export async function importTargetModule(
  absPath: string,
  policy: DynamicImportPolicy | undefined,
  reason: string
): Promise<Record<string, unknown> | null> {
  if (!isDynamicImportEnabled(policy)) return null;

  const contained = resolveContainedRealPath(policy!.root, absPath);
  if (contained === null) {
    log.warn(
      { path: absPath, root: policy!.root, reason },
      'schema introspection: refusing to import a module that resolves outside the surface root'
    );
    return null;
  }

  // Audit trail: one warn per distinct module per process. Deduped so a
  // file-watcher regen loop doesn't drown the log, but never silenced — every
  // target file we execute is named at least once.
  if (!loggedImports.has(contained)) {
    loggedImports.add(contained);
    log.warn(
      { path: contained, reason },
      'schema introspection: executing target-project code via dynamic import (set schemaIntrospection.dynamicImport=false to disable)'
    );
  }

  try {
    return (await import(contained)) as Record<string, unknown>;
  } catch {
    // Not importable (TS source without a loader, syntax error, missing dep) —
    // callers fall back to static AST parsing.
    return null;
  }
}
