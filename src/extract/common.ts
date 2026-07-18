// Shared naming / hashing / classification helpers for the per-stack extractors.
//
// These were previously copy-pasted into each extractor and had to stay
// byte-identical, because `toolId` is the stable cluster key downstream agents
// (e.g. BugHunter) rely on. One copy had already silently drifted into a no-op.
// Centralizing them removes that hazard. Stack-specific path *normalizers*
// (`[id]`->`:id`, `{id}`->`:id`, `<int:pk>`->`:pk`) stay in their own extractor;
// callers pass an already-normalized path here, exactly as before.

import { createHash } from 'node:crypto';
import type { SideEffectClass } from '../types.js';

/** Stable 12-char id: sha1 of `METHOD:path`. The cluster key for a tool. */
export function toolId(method: string, path: string): string {
  return createHash('sha1').update(`${method}:${path}`).digest('hex').slice(0, 12);
}

/**
 * Human-facing bare tool name, e.g. `get_users_id`. Strips leading slash and all
 * path-parameter punctuation (`/ : { } < >`) to underscores, collapses runs, and
 * prefixes the lowercased method. The character class is a superset of every
 * stack's syntax; since each stack's paths only contain its own param style, the
 * output is identical to the previous per-stack implementations.
 */
export function pathToToolName(method: string, path: string): string {
  const normalized = path
    .replace(/^\//, '')
    .replace(/[/:{}<>]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `${method.toLowerCase()}_${normalized || 'root'}`;
}

/** GET/HEAD/OPTIONS are side-effect-free; everything else is mutating by default. */
export function methodToSideEffect(method: string): SideEffectClass {
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) ? 'safe' : 'mutating';
}
