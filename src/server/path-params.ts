// Path-parameter handling for surface_call.
//
// A discovered route template carries its parameters inline in `tool.path`, in
// one of the syntaxes the various stack extractors emit:
//   - `:name`            Express, Next.js (App/Pages Router, incl. catch-all -> :name)
//   - `{name}`           OpenAPI / FastAPI
//   - `<name>` / `<int:pk>`  Django URLconf (optional `converter:` prefix)
//
// Before a request is issued these tokens must be replaced with real values
// from the caller's `input`; the consumed keys are then omitted from the query
// string / body so they aren't sent twice.

import type { JsonSchema2020 } from '../types.js';

/** A single path parameter discovered in a route template. */
export type PathParam = {
  /** Parameter name — the key expected in `input`. */
  name: string;
  /** Exact token as it appears in the path, e.g. ":id", "{id}", "<int:pk>". */
  token: string;
};

// Group 1: :name  ·  Group 2: {name}  ·  Group 3: <[converter:]name>
const PATH_PARAM_RE = /:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\}|<(?:\w+:)?([A-Za-z_]\w*)>/g;

/** Ordered, de-duplicated list of path parameters in a route template. */
export function extractPathParams(path: string): PathParam[] {
  const params: PathParam[] = [];
  const seen = new Set<string>();
  for (const m of path.matchAll(PATH_PARAM_RE)) {
    const name = m[1] ?? m[2] ?? m[3];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    params.push({ name, token: m[0] });
  }
  return params;
}

export type SubstituteResult =
  | { ok: true; path: string; consumed: Set<string> }
  | { ok: false; missing: string[] };

/**
 * Replace every path-parameter token in `template` with the URL-encoded value
 * from `input`, in a single pass (so `:id` never clobbers `:idcard`). Returns
 * the concrete path plus the set of input keys consumed. If any path parameter
 * is absent, null, or empty in `input`, returns { ok: false, missing }.
 */
export function substitutePathParams(
  template: string,
  input: Record<string, unknown>,
): SubstituteResult {
  const params = extractPathParams(template);
  if (params.length === 0) return { ok: true, path: template, consumed: new Set() };

  const missing = params
    .filter((p) => {
      const v = input[p.name];
      return v === undefined || v === null || v === '';
    })
    .map((p) => p.name);
  if (missing.length > 0) return { ok: false, missing };

  const consumed = new Set<string>();
  const path = template.replace(PATH_PARAM_RE, (_match, g1, g2, g3) => {
    const name: string = g1 ?? g2 ?? g3;
    consumed.add(name);
    return encodeURIComponent(String(input[name]));
  });
  return { ok: true, path, consumed };
}

/**
 * Return a copy of `schema` with each path parameter present as a required
 * string property, so the generated MCP tool advertises them to callers. Params
 * already described by the extracted schema keep their richer definition.
 */
export function withPathParams(
  schema: JsonSchema2020,
  params: PathParam[],
): JsonSchema2020 {
  if (params.length === 0) return schema;

  const base = schema && (schema.type === 'object' || schema.properties)
    ? schema
    : { type: 'object' as const, properties: {} as Record<string, JsonSchema2020> };

  const properties: Record<string, JsonSchema2020> = { ...(base.properties ?? {}) };
  const required = new Set(base.required ?? []);

  for (const p of params) {
    if (!properties[p.name]) {
      properties[p.name] = { type: 'string', description: `Path parameter \`${p.token}\`` };
    }
    required.add(p.name);
  }

  return { ...base, type: 'object', properties, required: [...required] };
}
