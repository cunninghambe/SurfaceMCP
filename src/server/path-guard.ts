import { resolve, sep, isAbsolute } from 'node:path';

export type PathGuardResult =
  | { ok: true; absPath: string }
  | { ok: false; code: 'bad_path'; message: string };

/**
 * Resolve a caller-supplied path against `root` and enforce containment.
 *
 * Rejects: non-strings, empty input, absolute inputs, paths containing a NUL
 * byte, and any resolved path that escapes `root` (via `..` traversal or
 * otherwise). On success returns the absolute path, guaranteed to sit at or
 * under `root`.
 */
export function resolveContainedPath(root: string, input: unknown): PathGuardResult {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, code: 'bad_path', message: 'Path must be a non-empty string' };
  }
  if (input.includes('\0')) {
    return { ok: false, code: 'bad_path', message: 'Path contains an invalid character' };
  }
  if (isAbsolute(input)) {
    return { ok: false, code: 'bad_path', message: 'Absolute paths are not allowed' };
  }

  const rootResolved = resolve(root);
  const abs = resolve(rootResolved, input);
  const prefix = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;

  if (abs !== rootResolved && !abs.startsWith(prefix)) {
    return { ok: false, code: 'bad_path', message: 'Resolved path escapes the project root' };
  }

  return { ok: true, absPath: abs };
}
