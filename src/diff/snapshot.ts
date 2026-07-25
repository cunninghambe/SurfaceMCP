// Snapshot envelope for a discovered surface: the catalog frozen to a JSON
// document that can be committed alongside the target app and compared in CI.
//
// Design constraints:
//   - **Deterministic.** Object keys are emitted in sorted order at every level
//     and tools are sorted by `toolId`, so re-running `surfacemcp snapshot`
//     against unchanged source produces a byte-identical file. Nothing
//     timestamp-, path-, or machine-dependent is stored (a `createdAt` would
//     make every regeneration a diff).
//   - **Self-describing.** `snapshotVersion` lets a future format change be
//     detected instead of mis-parsed.
//   - **Round-trippable.** `parseSnapshot` accepts what `serializeSnapshot`
//     emits, plus the looser shapes an agent is likely to hand the MCP tool
//     (a bare tool array, or a raw `ToolCatalog`).

import type { ToolCatalog, ToolMeta } from '../types.js';

export const SNAPSHOT_VERSION = 1;

export type SurfaceSnapshot = {
  /** Format version of this envelope. Bumped only on a breaking layout change. */
  snapshotVersion: number;
  /** Surface the catalog was captured from. */
  surface: string;
  /** Catalog revision at capture time (informational; not used for joining). */
  revision: number;
  /** Discovered tools, sorted by `toolId`. */
  tools: ToolMeta[];
};

export function buildSnapshot(surface: string, catalog: ToolCatalog): SurfaceSnapshot {
  const tools = [...catalog.tools]
    // `sourceFile` keeps the host separator as the extractor emitted it. A
    // snapshot is committed and regenerated on whatever machine CI runs on, so
    // normalize to posix here — otherwise every Windows<->Linux round-trip is a
    // spurious git diff. Snapshot-local: the live catalog is untouched, and the
    // diff never joins or compares on `sourceFile`.
    .map((tool) => ({ ...tool, sourceFile: tool.sourceFile.replace(/\\/g, '/') }))
    .sort((a, b) => (a.toolId < b.toolId ? -1 : a.toolId > b.toolId ? 1 : 0));
  return { snapshotVersion: SNAPSHOT_VERSION, surface, revision: catalog.revision, tools };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively reorder object keys lexicographically. Array order is preserved —
 * only key order is canonicalized, so no schema semantics are altered (a
 * `required` array is a set to the *diff*, but reordering it here would rewrite
 * the user's data).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    out[key] = canonicalize(value[key]);
  }
  return out;
}

/** Stable-key-order JSON, 2-space indented, with a trailing newline. */
export function serializeSnapshot(snapshot: SurfaceSnapshot): string {
  return `${JSON.stringify(canonicalize(snapshot), null, 2)}\n`;
}

/** Stable-key-order JSON for any diff/report payload written to disk or stdout. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export type ParseSnapshotResult =
  | { ok: true; snapshot: SurfaceSnapshot }
  | { ok: false; code: 'bad_snapshot'; message: string };

function looksLikeTool(value: unknown): boolean {
  return isPlainObject(value) && typeof value.toolId === 'string' && value.toolId.length > 0;
}

/**
 * Coerce caller-supplied data into a snapshot.
 *
 * Accepts, in order of preference: a full snapshot envelope, a `ToolCatalog`
 * (`{ revision, tools }`), or a bare `ToolMeta[]`. Validation is deliberately
 * shallow — only the fields the diff joins on are required — so a snapshot
 * written by an older SurfaceMCP still diffs cleanly.
 */
export function parseSnapshot(value: unknown, label = 'snapshot'): ParseSnapshotResult {
  if (Array.isArray(value)) {
    if (!value.every(looksLikeTool)) {
      return { ok: false, code: 'bad_snapshot', message: `${label}: every entry must be a tool with a string toolId` };
    }
    return {
      ok: true,
      snapshot: { snapshotVersion: SNAPSHOT_VERSION, surface: '', revision: 0, tools: value as ToolMeta[] },
    };
  }

  if (!isPlainObject(value)) {
    return { ok: false, code: 'bad_snapshot', message: `${label}: expected an object or an array of tools` };
  }

  const version = value.snapshotVersion;
  if (version !== undefined && (typeof version !== 'number' || version > SNAPSHOT_VERSION)) {
    return {
      ok: false,
      code: 'bad_snapshot',
      message: `${label}: unsupported snapshotVersion ${String(version)} (this build understands up to ${SNAPSHOT_VERSION})`,
    };
  }

  const tools = value.tools;
  if (!Array.isArray(tools)) {
    return { ok: false, code: 'bad_snapshot', message: `${label}: missing "tools" array` };
  }
  if (!tools.every(looksLikeTool)) {
    return { ok: false, code: 'bad_snapshot', message: `${label}: every tool must have a string toolId` };
  }

  return {
    ok: true,
    snapshot: {
      snapshotVersion: typeof version === 'number' ? version : SNAPSHOT_VERSION,
      surface: typeof value.surface === 'string' ? value.surface : '',
      revision: typeof value.revision === 'number' ? value.revision : 0,
      tools: tools as ToolMeta[],
    },
  };
}
