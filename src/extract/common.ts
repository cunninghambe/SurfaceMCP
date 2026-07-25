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

/** Status codes we treat as "the success response", most specific first. */
const PREFERRED_RESPONSE_CODES = ['200', '201', '202', '203', '204', '2XX', 'DEFAULT'];

/**
 * Pick the key describing a route's success response from a `responses` map.
 * Shared by every stack that keys response schemas by status code — OpenAPI /
 * FastAPI (`responses`) and Fastify (`schema.response`). Prefers 200, then 201,
 * then the remaining explicit 2xx codes, then a `2xx` wildcard, then `default`,
 * and finally any other 2xx key in declaration order. Matching is
 * case-insensitive so Fastify's lowercase `'2xx'` resolves like OpenAPI's `2XX`.
 * Returns the key exactly as it appeared, or undefined when nothing matches.
 */
export function pickSuccessResponseKey(keys: Iterable<string>): string | undefined {
  const byUpper = new Map<string, string>();
  for (const key of keys) {
    const upper = String(key).toUpperCase();
    if (!byUpper.has(upper)) byUpper.set(upper, key);
  }
  for (const code of PREFERRED_RESPONSE_CODES) {
    const hit = byUpper.get(code);
    if (hit !== undefined) return hit;
  }
  for (const [upper, key] of byUpper) {
    if (/^2\d\d$/.test(upper)) return key;
  }
  return undefined;
}
