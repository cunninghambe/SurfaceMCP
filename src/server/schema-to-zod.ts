// Converts an extracted Draft 2020-12 JSON Schema into a Zod type so the MCP SDK
// advertises real, typed parameters to callers instead of an opaque bag. This is
// the core product promise — the per-route schemas that the extractors work hard
// to recover (zod introspection, OpenAPI, probe recovery) must survive the MCP
// boundary rather than being flattened to `z.record(z.unknown())`.

import { z } from 'zod';
import type { JsonSchema2020 } from '../types.js';

const MAX_DEPTH = 12; // guard against pathological / cyclic ($ref) schemas

/** Fallback used when a schema is absent, unknown, or too deep to model. */
function anyObject(): z.ZodTypeAny {
  return z.record(z.unknown());
}

function primaryType(schema: JsonSchema2020): string | undefined {
  if (Array.isArray(schema.type)) {
    return schema.type.find((t) => t !== 'null');
  }
  return schema.type;
}

function isNullable(schema: JsonSchema2020): boolean {
  return Array.isArray(schema.type) && schema.type.includes('null');
}

function stringSchema(schema: JsonSchema2020): z.ZodTypeAny {
  let s = z.string();
  switch (schema.format) {
    case 'email': s = s.email(); break;
    case 'uri':
    case 'url': s = s.url(); break;
    case 'uuid': s = s.uuid(); break;
    case 'date-time': s = s.datetime({ offset: true }); break;
    default: break;
  }
  if (typeof schema.minLength === 'number') s = s.min(schema.minLength);
  if (typeof schema.maxLength === 'number') s = s.max(schema.maxLength);
  if (typeof schema.pattern === 'string') {
    try {
      s = s.regex(new RegExp(schema.pattern));
    } catch {
      // invalid regex in the source schema — skip the constraint
    }
  }
  return s;
}

function numberSchema(schema: JsonSchema2020, integer: boolean): z.ZodTypeAny {
  let n = z.number();
  if (integer) n = n.int();
  if (typeof schema.minimum === 'number') n = n.min(schema.minimum);
  if (typeof schema.maximum === 'number') n = n.max(schema.maximum);
  if (typeof schema.exclusiveMinimum === 'number') n = n.gt(schema.exclusiveMinimum);
  if (typeof schema.exclusiveMaximum === 'number') n = n.lt(schema.exclusiveMaximum);
  if (typeof schema.multipleOf === 'number') n = n.multipleOf(schema.multipleOf);
  return n;
}

function enumSchema(values: unknown[]): z.ZodTypeAny {
  if (values.length === 0) return z.unknown();
  if (values.every((v) => typeof v === 'string')) {
    return z.enum(values as [string, ...string[]]);
  }
  const literals: z.ZodTypeAny[] = values.map((v) => z.literal(v as z.Primitive));
  return literals.length === 1 ? literals[0]! : z.union(literals as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

function objectSchema(schema: JsonSchema2020, depth: number): z.ZodTypeAny {
  const props = schema.properties;
  if (!props || Object.keys(props).length === 0) {
    return anyObject();
  }
  const required = new Set(schema.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, propSchema] of Object.entries(props)) {
    let zt = convert(propSchema, depth + 1);
    if (!required.has(key)) zt = zt.optional();
    shape[key] = zt;
  }
  const obj = z.object(shape);
  // additionalProperties:false -> strict; otherwise allow extras (agents may add
  // path params or the introspected schema may be partial).
  return schema.additionalProperties === false ? obj.strict() : obj.passthrough();
}

function convert(schema: JsonSchema2020 | undefined, depth: number): z.ZodTypeAny {
  if (!schema || depth > MAX_DEPTH) return anyObject();

  if (schema.const !== undefined) return z.literal(schema.const as z.Primitive);
  if (Array.isArray(schema.enum)) return applyNullable(schema, enumSchema(schema.enum));

  const combinator = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(combinator) && combinator.length > 0) {
    const options = combinator.map((s) => convert(s, depth + 1));
    const union = options.length === 1
      ? options[0]!
      : z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    return applyNullable(schema, union);
  }

  const type = primaryType(schema);
  let zt: z.ZodTypeAny;
  switch (type) {
    case 'string': zt = stringSchema(schema); break;
    case 'integer': zt = numberSchema(schema, true); break;
    case 'number': zt = numberSchema(schema, false); break;
    case 'boolean': zt = z.boolean(); break;
    case 'array': {
      const items = convert(schema.items, depth + 1);
      let arr = z.array(items);
      if (typeof schema.minItems === 'number') arr = arr.min(schema.minItems);
      if (typeof schema.maxItems === 'number') arr = arr.max(schema.maxItems);
      zt = arr;
      break;
    }
    case 'object': zt = objectSchema(schema, depth); break;
    default:
      // No usable type: if it has properties treat as object, else accept anything.
      zt = schema.properties ? objectSchema(schema, depth) : z.unknown();
  }
  return applyNullable(schema, zt);
}

function applyNullable(schema: JsonSchema2020, zt: z.ZodTypeAny): z.ZodTypeAny {
  return isNullable(schema) ? zt.nullable() : zt;
}

/** Public entry point: JSON Schema 2020-12 -> Zod type for an MCP tool parameter. */
export function jsonSchemaToZod(schema: JsonSchema2020 | undefined): z.ZodTypeAny {
  // Preserve the historical pass-through for object-shaped-but-propertyless schemas
  // (a bare `{type:'object'}` accepts any body).
  if (!schema || (!schema.type && !schema.properties && !schema.enum &&
      !schema.const && !schema.anyOf && !schema.oneOf)) {
    return anyObject();
  }
  return convert(schema, 0);
}
