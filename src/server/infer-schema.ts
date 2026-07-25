// Infer a JSON Schema from an observed response body, and merge inferences
// across observations.
//
// This is the success-path sibling of `surface_probe`, which recovers a schema
// from a validation *error* response. Together they let a stack that can't be
// statically introspected (Express, Django, …) still converge on a typed surface
// as it gets exercised.
//
// The inference is deliberately conservative: it describes what was actually
// seen. Merging widens (a field seen as string then null becomes nullable; a
// field absent in one observation drops out of `required`) so the schema
// approaches the true shape rather than overfitting to the first response.

import type { JsonSchema2020 } from '../types.js';

const MAX_DEPTH = 6;

/** Infer a schema describing a single observed value. */
export function inferJsonSchema(value: unknown, depth = 0): JsonSchema2020 {
  if (value === null) return { type: 'null' };
  if (depth >= MAX_DEPTH) return {};

  if (Array.isArray(value)) {
    if (value.length === 0) return { type: 'array' };
    // Merge across elements so a heterogeneous array widens rather than
    // describing only its first item.
    const items = value
      .slice(0, 20) // bound the work on large collections
      .map((v) => inferJsonSchema(v, depth + 1))
      .reduce((a, b) => mergeSchemas(a, b));
    return { type: 'array', items };
  }

  switch (typeof value) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'object': {
      const properties: Record<string, JsonSchema2020> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        properties[k] = inferJsonSchema(v, depth + 1);
        required.push(k);
      }
      return required.length
        ? { type: 'object', properties, required }
        : { type: 'object', properties };
    }
    default:
      return {};
  }
}

function typeSet(s: JsonSchema2020): string[] {
  if (Array.isArray(s.type)) return s.type;
  return s.type ? [s.type] : [];
}

/**
 * Widen two inferred schemas into one that accepts both. Union of types; the
 * intersection of `required` (a key missing from either observation is optional);
 * per-key merge of `properties`; recursive merge of array `items`.
 */
export function mergeSchemas(a: JsonSchema2020, b: JsonSchema2020): JsonSchema2020 {
  if (!a || Object.keys(a).length === 0) return b;
  if (!b || Object.keys(b).length === 0) return a;

  const types = [...new Set([...typeSet(a), ...typeSet(b)])];
  const merged: JsonSchema2020 = {};
  if (types.length === 1) merged.type = types[0];
  else if (types.length > 1) merged.type = types;

  // Integer widens to number when both are seen.
  if (types.includes('integer') && types.includes('number')) {
    merged.type = types.filter((t) => t !== 'integer');
    if (Array.isArray(merged.type) && merged.type.length === 1) merged.type = merged.type[0];
  }

  if (a.properties || b.properties) {
    const keys = new Set([...Object.keys(a.properties ?? {}), ...Object.keys(b.properties ?? {})]);
    const properties: Record<string, JsonSchema2020> = {};
    for (const k of keys) {
      const pa = a.properties?.[k];
      const pb = b.properties?.[k];
      properties[k] = pa && pb ? mergeSchemas(pa, pb) : (pa ?? pb ?? {});
    }
    merged.properties = properties;

    // Only keys required in BOTH observations stay required.
    const ra = new Set(a.required ?? []);
    const rb = new Set(b.required ?? []);
    const required = [...ra].filter((k) => rb.has(k)).sort();
    if (required.length) merged.required = required;
  }

  if (a.items || b.items) {
    merged.items = a.items && b.items ? mergeSchemas(a.items, b.items) : (a.items ?? b.items);
  }

  return merged;
}
