// Structural diff of two discovered API surfaces.
//
// `toolId` is the stable cross-repo cluster key (sha1 of `METHOD:path`, or
// operation-keyed for GraphQL), so two catalogs captured at different times can
// be joined on it directly. That makes a surface diff nearly free and gives CI a
// gate ("did this PR break the API?") and downstream agents (BugHunter) a
// "what's new since the last scan" worklist.
//
// This module is pure: no I/O, no config, no extraction. Feed it two `ToolMeta[]`
// (see `snapshot.ts` for acquiring them).
//
// ── Breaking vs non-breaking ────────────────────────────────────────────────
//
// "Breaking" means *a caller that worked against `before` may stop working
// against `after`*. Direction matters: an input schema is a contract the caller
// must satisfy, so **tightening inputs breaks callers**; an output schema is a
// contract the caller relies on, so **loosening outputs breaks callers**. Every
// schema rule below is therefore evaluated with a polarity that flips between
// `inputSchema` and `outputSchema`.
//
// BREAKING
//   - a tool present in `before` and absent from `after` (removed endpoint)
//   - an input property that is newly `required`
//   - an input property that was removed while it was `required`
//     (callers may still be sending it, but more importantly the server no
//     longer accepts the shape it advertised)
//   - an input property whose type set NARROWED (fewer accepted types, a new
//     `enum`, or a shrunken `enum`), or that became typed where it was untyped
//   - an input property whose value constraints TIGHTENED (`minLength` up,
//     `maximum` down, a new/changed `pattern`, …)
//   - an input property retyped incompatibly (neither a widening nor a
//     narrowing, e.g. `string` -> `number`)
//   - an output property that was REMOVED, became optional, widened, or had a
//     constraint loosened (the mirror image of the input rules)
//   - `sideEffectClass` leaving `safe` (`safe` -> `mutating` / `safe` ->
//     `external`): a call an agent treated as read-only now has side effects
//   - the same `toolId` moving to a different `method`/`path` (only reachable
//     across a `toolId` hashing change; reported rather than silently ignored)
//
// NON-BREAKING
//   - a tool present only in `after` (new endpoint)
//   - a new OPTIONAL input property; a removed OPTIONAL input property
//   - an input property that WIDENED (more accepted types, enum removed or
//     grown) or had a constraint LOOSENED
//   - an input property that became optional
//   - a new output property, or one that became required / narrowed / tightened
//   - `sideEffectClass` becoming `safe`, or moving between `mutating` and
//     `external`
//   - any `inputSchemaConfidence` change: confidence describes how well *we*
//     recovered the schema, not the target's contract. Reported (so an
//     `introspected` -> `unknown` regression is visible) but never breaking.
//   - `name` changes: the wire name is derived from method/path and the surface
//     prefix, so a rename is a cosmetic re-label of the same endpoint.
//
// Purely annotative schema keywords (`description`, `title`, `default`,
// `examples`, `$comment`, `deprecated`) are ignored: they change constantly
// during development and would bury the real signal.

import type {
  InputSchemaConfidence,
  JsonSchema2020,
  SideEffectClass,
  ToolMeta,
} from '../types.js';

// ─── Result types ─────────────────────────────────────────────────────────────

/** Which piece of a tool's metadata a change refers to. */
export type DiffField =
  | 'name'
  | 'method'
  | 'path'
  | 'surface'
  | 'sideEffectClass'
  | 'inputSchemaConfidence'
  | 'isServerAction'
  | 'inputSchema'
  | 'outputSchema';

/** The shape of an individual change. */
export type DiffChangeKind =
  | 'replaced'
  | 'added'
  | 'removed'
  | 'retyped'
  | 'widened'
  | 'narrowed'
  | 'became_required'
  | 'became_optional'
  | 'constraint_tightened'
  | 'constraint_loosened';

/** One atomic difference between the `before` and `after` version of a tool. */
export type ToolChange = {
  field: DiffField;
  /**
   * Dotted property path inside the schema for `inputSchema`/`outputSchema`
   * changes — `user.email`, `tags[]`, `''` for the schema as a whole. Absent on
   * scalar field changes.
   */
  property?: string;
  kind: DiffChangeKind;
  /** Human-readable rendering of the previous value (absent when there was none). */
  before?: string;
  /** Human-readable rendering of the new value (absent when there is none). */
  after?: string;
  breaking: boolean;
  /** Why this was (or was not) classified as breaking. */
  reason: string;
};

/** Identity of a tool that was wholly added or wholly removed. */
export type DiffToolRef = {
  toolId: string;
  name: string;
  method: string;
  path: string;
  surface: string;
  sideEffectClass: SideEffectClass;
  inputSchemaConfidence: InputSchemaConfidence;
  /** `false` for additions, `true` for removals. */
  breaking: boolean;
};

/** A tool present in both catalogs whose metadata differs. */
export type ChangedTool = {
  toolId: string;
  /** Name as of `after`. */
  name: string;
  method: string;
  path: string;
  surface: string;
  /** True when at least one of `changes` is breaking. */
  breaking: boolean;
  changes: ToolChange[];
};

export type SurfaceDiffSummary = {
  added: number;
  removed: number;
  changed: number;
  /** Tools present in both catalogs with no reportable difference. */
  unchanged: number;
  /** Tools (removed + changed) carrying at least one breaking change. */
  breakingTools: number;
  /** Individual breaking records across removals and changes. */
  breakingChanges: number;
};

export type SurfaceDiff = {
  /** In `after` only. Sorted by `toolId`. */
  added: DiffToolRef[];
  /** In `before` only. Sorted by `toolId`. */
  removed: DiffToolRef[];
  /** In both, with differences. Sorted by `toolId`; `changes` sorted within. */
  changed: ChangedTool[];
  summary: SurfaceDiffSummary;
};

// ─── Schema comparison helpers ────────────────────────────────────────────────

/** Keywords that carry no contract, only documentation. Ignored when diffing. */
const ANNOTATION_KEYWORDS = new Set([
  'description',
  'title',
  'default',
  'examples',
  '$comment',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

/** Constraints that only ever get stricter as the value goes UP. */
const LOWER_BOUND_KEYWORDS = ['minLength', 'minItems', 'minimum', 'exclusiveMinimum', 'minProperties'] as const;
/** Constraints that only ever get stricter as the value goes DOWN. */
const UPPER_BOUND_KEYWORDS = ['maxLength', 'maxItems', 'maximum', 'exclusiveMaximum', 'maxProperties'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep structural equality, ignoring purely annotative keywords and key order. */
function semanticallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => semanticallyEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a).filter((k) => !ANNOTATION_KEYWORDS.has(k)).sort();
    const keysB = Object.keys(b).filter((k) => !ANNOTATION_KEYWORDS.has(k)).sort();
    if (keysA.length !== keysB.length) return false;
    if (keysA.some((k, i) => k !== keysB[i])) return false;
    return keysA.every((k) => semanticallyEqual(a[k], b[k]));
  }
  return false;
}

/** JSON type name of a literal `enum`/`const` member. */
function literalType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    default:
      return 'object';
  }
}

/**
 * The set of JSON types a schema accepts, as a sorted array. An empty set means
 * "unconstrained" (any type) — `{}`, a bare `$ref`, or a schema with no `type`,
 * `enum`, `const`, or type-bearing union members.
 */
function typeSet(schema: JsonSchema2020 | undefined): string[] {
  if (!schema) return [];
  const types = new Set<string>();

  if (typeof schema.type === 'string') types.add(schema.type);
  else if (Array.isArray(schema.type)) for (const t of schema.type) types.add(t);

  if (Array.isArray(schema.enum)) for (const v of schema.enum) types.add(literalType(v));
  if (schema.const !== undefined) types.add(literalType(schema.const));

  for (const key of ['anyOf', 'oneOf'] as const) {
    const members = schema[key];
    if (!Array.isArray(members)) continue;
    for (const member of members) for (const t of typeSet(member)) types.add(t);
  }

  return [...types].sort();
}

/** `integer` is a subset of `number`, so `number` accepts everything `integer` does. */
function accepts(outer: string[], inner: string[]): boolean {
  if (outer.length === 0) return true; // unconstrained accepts anything
  if (inner.length === 0) return false;
  const set = new Set(outer);
  return inner.every((t) => set.has(t) || (t === 'integer' && set.has('number')));
}

function renderTypes(types: string[]): string {
  return types.length === 0 ? 'any' : types.join('|');
}

/** Enum members as a stable set of JSON-encoded literals, or undefined when absent. */
function enumSet(schema: JsonSchema2020 | undefined): Set<string> | undefined {
  if (!schema || !Array.isArray(schema.enum)) return undefined;
  return new Set(schema.enum.map((v) => JSON.stringify(v)));
}

function isSubset(sub: Set<string>, sup: Set<string>): boolean {
  for (const v of sub) if (!sup.has(v)) return false;
  return true;
}

// ─── Polarity ─────────────────────────────────────────────────────────────────

/**
 * Which contract a schema belongs to. Callers must *satisfy* an input, and
 * *rely on* an output, so a tightening that breaks an input caller is exactly
 * the loosening that breaks an output consumer. Every schema rule is written
 * for the input direction and mirrored for output by this flag.
 */
type Polarity = 'input' | 'output';

/** Breaking iff the schema is an input (i.e. the change tightens the contract). */
function breakingIfInput(polarity: Polarity): boolean {
  return polarity === 'input';
}

/** Breaking iff the schema is an output (i.e. the change loosens the contract). */
function breakingIfOutput(polarity: Polarity): boolean {
  return polarity === 'output';
}

// ─── Schema diff ──────────────────────────────────────────────────────────────

function joinPath(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

/** Compare the bound/pattern constraints of a single property. */
function diffConstraints(
  before: JsonSchema2020,
  after: JsonSchema2020,
  field: DiffField,
  property: string,
  polarity: Polarity,
  out: ToolChange[]
): void {
  const push = (kind: 'constraint_tightened' | 'constraint_loosened', b: string, a: string, keyword: string): void => {
    const breaking = kind === 'constraint_tightened' ? breakingIfInput(polarity) : breakingIfOutput(polarity);
    out.push({
      field,
      property,
      kind,
      before: b,
      after: a,
      breaking,
      reason: breaking
        ? `\`${keyword}\` ${kind === 'constraint_tightened' ? 'tightened' : 'loosened'} on ${polarity} property "${property}"`
        : `\`${keyword}\` ${kind === 'constraint_tightened' ? 'tightened' : 'loosened'} on ${polarity} property "${property}" (compatible direction)`,
    });
  };

  for (const keyword of LOWER_BOUND_KEYWORDS) {
    const b = before[keyword] as number | undefined;
    const a = after[keyword] as number | undefined;
    if (b === a) continue;
    // Absent lower bound behaves as -Infinity: adding one tightens.
    const bv = typeof b === 'number' ? b : Number.NEGATIVE_INFINITY;
    const av = typeof a === 'number' ? a : Number.NEGATIVE_INFINITY;
    if (av > bv) push('constraint_tightened', String(b ?? 'none'), String(a ?? 'none'), keyword);
    else if (av < bv) push('constraint_loosened', String(b ?? 'none'), String(a ?? 'none'), keyword);
  }

  for (const keyword of UPPER_BOUND_KEYWORDS) {
    const b = before[keyword] as number | undefined;
    const a = after[keyword] as number | undefined;
    if (b === a) continue;
    // Absent upper bound behaves as +Infinity: adding one tightens.
    const bv = typeof b === 'number' ? b : Number.POSITIVE_INFINITY;
    const av = typeof a === 'number' ? a : Number.POSITIVE_INFINITY;
    if (av < bv) push('constraint_tightened', String(b ?? 'none'), String(a ?? 'none'), keyword);
    else if (av > bv) push('constraint_loosened', String(b ?? 'none'), String(a ?? 'none'), keyword);
  }

  if (before.pattern !== after.pattern) {
    // A regex can't be proven weaker than another without solving language
    // inclusion, so removing one is the only provably safe direction.
    if (after.pattern === undefined) push('constraint_loosened', String(before.pattern), 'none', 'pattern');
    else push('constraint_tightened', String(before.pattern ?? 'none'), String(after.pattern), 'pattern');
  }

  if (before.format !== after.format) {
    if (after.format === undefined) push('constraint_loosened', String(before.format), 'none', 'format');
    else push('constraint_tightened', String(before.format ?? 'none'), String(after.format), 'format');
  }
}

/** Compare the type/enum of a single property, recursing into objects and arrays. */
function diffProperty(
  before: JsonSchema2020,
  after: JsonSchema2020,
  field: DiffField,
  property: string,
  polarity: Polarity,
  depth: number,
  out: ToolChange[]
): void {
  if (semanticallyEqual(before, after)) return;

  const beforeTypes = typeSet(before);
  const afterTypes = typeSet(after);
  const beforeRender = renderTypes(beforeTypes);
  const afterRender = renderTypes(afterTypes);

  if (beforeRender !== afterRender) {
    const widened = accepts(afterTypes, beforeTypes);
    const narrowed = accepts(beforeTypes, afterTypes);
    if (widened && !narrowed) {
      const breaking = breakingIfOutput(polarity);
      out.push({
        field,
        property,
        kind: 'widened',
        before: beforeRender,
        after: afterRender,
        breaking,
        reason: breaking
          ? `${polarity} property "${property}" widened ${beforeRender} -> ${afterRender}; consumers may not handle the new type`
          : `${polarity} property "${property}" widened ${beforeRender} -> ${afterRender}; existing values still accepted`,
      });
    } else if (narrowed && !widened) {
      const breaking = breakingIfInput(polarity);
      out.push({
        field,
        property,
        kind: 'narrowed',
        before: beforeRender,
        after: afterRender,
        breaking,
        reason: breaking
          ? `${polarity} property "${property}" narrowed ${beforeRender} -> ${afterRender}; previously valid values are now rejected`
          : `${polarity} property "${property}" narrowed ${beforeRender} -> ${afterRender}; still assignable to the old type`,
      });
    } else {
      out.push({
        field,
        property,
        kind: 'retyped',
        before: beforeRender,
        after: afterRender,
        breaking: true,
        reason: `${polarity} property "${property}" retyped ${beforeRender} -> ${afterRender}; neither type accepts the other`,
      });
    }
  } else {
    // Same accepted types — an `enum` can still narrow or widen the value space.
    const beforeEnum = enumSet(before);
    const afterEnum = enumSet(after);
    if (beforeEnum || afterEnum) {
      const render = (s: Set<string> | undefined): string => (s ? `[${[...s].sort().join(',')}]` : 'unconstrained');
      if (!beforeEnum && afterEnum) {
        const breaking = breakingIfInput(polarity);
        out.push({
          field, property, kind: 'narrowed', before: render(beforeEnum), after: render(afterEnum), breaking,
          reason: `${polarity} property "${property}" gained an enum constraint`,
        });
      } else if (beforeEnum && !afterEnum) {
        const breaking = breakingIfOutput(polarity);
        out.push({
          field, property, kind: 'widened', before: render(beforeEnum), after: render(afterEnum), breaking,
          reason: `${polarity} property "${property}" dropped its enum constraint`,
        });
      } else if (beforeEnum && afterEnum && !semanticallyEqual([...beforeEnum].sort(), [...afterEnum].sort())) {
        const shrunk = isSubset(afterEnum, beforeEnum);
        const grew = isSubset(beforeEnum, afterEnum);
        if (shrunk && !grew) {
          const breaking = breakingIfInput(polarity);
          out.push({
            field, property, kind: 'narrowed', before: render(beforeEnum), after: render(afterEnum), breaking,
            reason: `${polarity} property "${property}" enum lost member(s)`,
          });
        } else if (grew && !shrunk) {
          const breaking = breakingIfOutput(polarity);
          out.push({
            field, property, kind: 'widened', before: render(beforeEnum), after: render(afterEnum), breaking,
            reason: `${polarity} property "${property}" enum gained member(s)`,
          });
        } else {
          out.push({
            field, property, kind: 'retyped', before: render(beforeEnum), after: render(afterEnum), breaking: true,
            reason: `${polarity} property "${property}" enum members replaced`,
          });
        }
      }
    }
  }

  diffConstraints(before, after, field, property, polarity, out);

  // Recurse one level down into object properties and array items. Depth-guarded
  // so a cyclic (`$ref`-expanded) schema can't spin.
  if (depth > 0) {
    if (before.properties || after.properties) {
      diffObjectShape(before, after, field, property, polarity, depth - 1, out);
    }
    if (before.items && after.items) {
      diffProperty(before.items, after.items, field, `${property}[]`, polarity, depth - 1, out);
    }
  }
}

/** Compare the `properties` + `required` of two object schemas. */
function diffObjectShape(
  before: JsonSchema2020,
  after: JsonSchema2020,
  field: DiffField,
  prefix: string,
  polarity: Polarity,
  depth: number,
  out: ToolChange[]
): void {
  const beforeProps = before.properties ?? {};
  const afterProps = after.properties ?? {};
  const beforeRequired = new Set(before.required ?? []);
  const afterRequired = new Set(after.required ?? []);

  const names = [...new Set([...Object.keys(beforeProps), ...Object.keys(afterProps)])].sort();

  for (const name of names) {
    const path = joinPath(prefix, name);
    const b = beforeProps[name];
    const a = afterProps[name];

    if (!b && a) {
      // A new REQUIRED input property breaks every existing caller; a new
      // optional one does not. Outputs are the mirror: additions are safe.
      const nowRequired = afterRequired.has(name);
      const breaking = polarity === 'input' && nowRequired;
      out.push({
        field,
        property: path,
        kind: 'added',
        after: renderTypes(typeSet(a)),
        breaking,
        reason: breaking
          ? `new required ${polarity} property "${path}"; existing callers omit it`
          : `new ${nowRequired ? 'required' : 'optional'} ${polarity} property "${path}"`,
      });
      continue;
    }

    if (b && !a) {
      const wasRequired = beforeRequired.has(name);
      // Input: only a required property's disappearance is a contract break.
      // Output: any disappearance breaks consumers reading it.
      const breaking = polarity === 'input' ? wasRequired : true;
      out.push({
        field,
        property: path,
        kind: 'removed',
        before: renderTypes(typeSet(b)),
        breaking,
        reason: breaking
          ? `${wasRequired ? 'required ' : ''}${polarity} property "${path}" removed`
          : `optional ${polarity} property "${path}" removed`,
      });
      continue;
    }

    if (!b || !a) continue;

    if (!beforeRequired.has(name) && afterRequired.has(name)) {
      const breaking = breakingIfInput(polarity);
      out.push({
        field,
        property: path,
        kind: 'became_required',
        breaking,
        reason: breaking
          ? `${polarity} property "${path}" is now required; existing callers may omit it`
          : `${polarity} property "${path}" is now always present (stronger guarantee)`,
      });
    } else if (beforeRequired.has(name) && !afterRequired.has(name)) {
      const breaking = breakingIfOutput(polarity);
      out.push({
        field,
        property: path,
        kind: 'became_optional',
        breaking,
        reason: breaking
          ? `${polarity} property "${path}" is no longer guaranteed to be present`
          : `${polarity} property "${path}" is now optional (relaxed)`,
      });
    }

    diffProperty(b, a, field, path, polarity, depth, out);
  }
}

const MAX_SCHEMA_DEPTH = 6;

/** Diff one schema slot (`inputSchema` or `outputSchema`) of a tool. */
export function diffSchemas(
  before: JsonSchema2020 | undefined,
  after: JsonSchema2020 | undefined,
  field: 'inputSchema' | 'outputSchema',
  polarity: Polarity
): ToolChange[] {
  const out: ToolChange[] = [];

  if (!before && !after) return out;

  if (!before && after) {
    // Gaining an output schema is pure information. Gaining an input schema
    // means the endpoint is now advertised as constrained where it was open.
    const breaking = breakingIfInput(polarity) && typeSet(after).length > 0;
    out.push({
      field,
      property: '',
      kind: 'added',
      after: renderTypes(typeSet(after)),
      breaking,
      reason: breaking
        ? `${field} appeared where the tool previously advertised none`
        : `${field} appeared (newly discovered shape)`,
    });
    if (after.properties) {
      diffObjectShape({ type: 'object' }, after, field, '', polarity, MAX_SCHEMA_DEPTH, out);
    }
    return out;
  }

  if (before && !after) {
    const breaking = breakingIfOutput(polarity);
    out.push({
      field,
      property: '',
      kind: 'removed',
      before: renderTypes(typeSet(before)),
      breaking,
      reason: breaking
        ? `${field} disappeared; consumers lost the documented response shape`
        : `${field} disappeared (schema no longer recovered)`,
    });
    return out;
  }

  if (!before || !after) return out;
  if (semanticallyEqual(before, after)) return out;

  diffProperty(before, after, field, '', polarity, MAX_SCHEMA_DEPTH, out);
  return out;
}

// ─── Scalar field diff ────────────────────────────────────────────────────────

const CONFIDENCE_RANK: Record<InputSchemaConfidence, number> = {
  unknown: 0,
  partial: 1,
  inferred: 2,
  introspected: 3,
};

function diffScalarFields(before: ToolMeta, after: ToolMeta): ToolChange[] {
  const out: ToolChange[] = [];

  // The same toolId with a different method/path can only happen if the hashing
  // changed underneath us (or a snapshot was hand-edited). Surface it loudly
  // rather than silently diffing two unrelated endpoints.
  for (const field of ['method', 'path'] as const) {
    if (before[field] !== after[field]) {
      out.push({
        field,
        kind: 'replaced',
        before: before[field],
        after: after[field],
        breaking: true,
        reason: `${field} changed under a stable toolId — the endpoint moved`,
      });
    }
  }

  if (before.name !== after.name) {
    out.push({
      field: 'name',
      kind: 'replaced',
      before: before.name,
      after: after.name,
      breaking: false,
      reason: 'tool renamed; the endpoint itself is unchanged',
    });
  }

  if (before.surface !== after.surface) {
    out.push({
      field: 'surface',
      kind: 'replaced',
      before: before.surface,
      after: after.surface,
      breaking: false,
      reason: 'tool moved to a different surface',
    });
  }

  if (before.isServerAction !== after.isServerAction) {
    out.push({
      field: 'isServerAction',
      kind: 'replaced',
      before: String(before.isServerAction),
      after: String(after.isServerAction),
      breaking: false,
      reason: 'server-action classification changed',
    });
  }

  if (before.sideEffectClass !== after.sideEffectClass) {
    // Leaving `safe` is the dangerous direction: an agent that treated the call
    // as a free read now mutates state or hits a third party.
    const breaking = before.sideEffectClass === 'safe';
    out.push({
      field: 'sideEffectClass',
      kind: 'replaced',
      before: before.sideEffectClass,
      after: after.sideEffectClass,
      breaking,
      reason: breaking
        ? `reclassified safe -> ${after.sideEffectClass}; callers may have treated it as side-effect-free`
        : `reclassified ${before.sideEffectClass} -> ${after.sideEffectClass}`,
    });
  }

  if (before.inputSchemaConfidence !== after.inputSchemaConfidence) {
    const improved =
      CONFIDENCE_RANK[after.inputSchemaConfidence] > CONFIDENCE_RANK[before.inputSchemaConfidence];
    out.push({
      field: 'inputSchemaConfidence',
      kind: 'replaced',
      before: before.inputSchemaConfidence,
      after: after.inputSchemaConfidence,
      // Confidence describes how well we recovered the schema, not the target's
      // contract — never breaking in either direction.
      breaking: false,
      reason: improved
        ? 'schema confidence improved'
        : 'schema confidence degraded; extraction recovered less than before',
    });
  }

  return out;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const FIELD_ORDER: DiffField[] = [
  'method',
  'path',
  'name',
  'surface',
  'sideEffectClass',
  'inputSchemaConfidence',
  'isServerAction',
  'inputSchema',
  'outputSchema',
];

function compareChanges(a: ToolChange, b: ToolChange): number {
  const fa = FIELD_ORDER.indexOf(a.field);
  const fb = FIELD_ORDER.indexOf(b.field);
  if (fa !== fb) return fa - fb;
  const pa = a.property ?? '';
  const pb = b.property ?? '';
  if (pa !== pb) return pa < pb ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return 0;
}

function toRef(tool: ToolMeta, breaking: boolean): DiffToolRef {
  return {
    toolId: tool.toolId,
    name: tool.name,
    method: tool.method,
    path: tool.path,
    surface: tool.surface,
    sideEffectClass: tool.sideEffectClass,
    inputSchemaConfidence: tool.inputSchemaConfidence,
    breaking,
  };
}

/** Index by `toolId`. Duplicate ids (never emitted by extraction) collapse last-wins. */
function indexByToolId(tools: ToolMeta[]): Map<string, ToolMeta> {
  const map = new Map<string, ToolMeta>();
  for (const tool of tools) map.set(tool.toolId, tool);
  return map;
}

/**
 * Diff two discovered surfaces, joined on the stable `toolId`.
 *
 * Output is fully deterministic: `added`/`removed`/`changed` are sorted by
 * `toolId` and each tool's `changes` by (field, property, kind), so a snapshot
 * of the result is committable and reviewable.
 */
export function diffCatalogs(before: ToolMeta[], after: ToolMeta[]): SurfaceDiff {
  const beforeById = indexByToolId(before);
  const afterById = indexByToolId(after);

  const added: DiffToolRef[] = [];
  const removed: DiffToolRef[] = [];
  const changed: ChangedTool[] = [];
  let unchanged = 0;

  for (const [toolId, afterTool] of afterById) {
    if (!beforeById.has(toolId)) {
      added.push(toRef(afterTool, false));
    }
  }

  for (const [toolId, beforeTool] of beforeById) {
    const afterTool = afterById.get(toolId);
    if (!afterTool) {
      // A removed endpoint is unconditionally breaking.
      removed.push(toRef(beforeTool, true));
      continue;
    }

    const changes = [
      ...diffScalarFields(beforeTool, afterTool),
      ...diffSchemas(beforeTool.inputSchema, afterTool.inputSchema, 'inputSchema', 'input'),
      ...diffSchemas(beforeTool.outputSchema, afterTool.outputSchema, 'outputSchema', 'output'),
    ].sort(compareChanges);

    if (changes.length === 0) {
      unchanged++;
      continue;
    }

    changed.push({
      toolId,
      name: afterTool.name,
      method: afterTool.method,
      path: afterTool.path,
      surface: afterTool.surface,
      breaking: changes.some((c) => c.breaking),
      changes,
    });
  }

  const byToolId = <T extends { toolId: string }>(a: T, b: T): number =>
    a.toolId < b.toolId ? -1 : a.toolId > b.toolId ? 1 : 0;

  added.sort(byToolId);
  removed.sort(byToolId);
  changed.sort(byToolId);

  const breakingChanges =
    removed.length + changed.reduce((n, t) => n + t.changes.filter((c) => c.breaking).length, 0);

  return {
    added,
    removed,
    changed,
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged,
      breakingTools: removed.length + changed.filter((t) => t.breaking).length,
      breakingChanges,
    },
  };
}

/**
 * Render a human-readable summary of a diff. Multi-line, no trailing newline —
 * callers write it to stderr (stdout is reserved for the machine-readable JSON).
 */
export function formatDiffSummary(diff: SurfaceDiff): string {
  const lines: string[] = [];
  const { summary } = diff;
  lines.push(
    `Surface diff: +${summary.added} added, -${summary.removed} removed, ~${summary.changed} changed, ${summary.unchanged} unchanged`
  );

  for (const ref of diff.removed) {
    lines.push(`  - [BREAKING] removed  ${ref.method} ${ref.path}  (${ref.name}, ${ref.toolId})`);
  }
  for (const ref of diff.added) {
    lines.push(`  + added    ${ref.method} ${ref.path}  (${ref.name}, ${ref.toolId})`);
  }
  for (const tool of diff.changed) {
    lines.push(`  ~ changed  ${tool.method} ${tool.path}  (${tool.name}, ${tool.toolId})`);
    for (const change of tool.changes) {
      const marker = change.breaking ? '[BREAKING] ' : '';
      const where = change.property ? `${change.field}:${change.property || '<root>'}` : change.field;
      const delta =
        change.before !== undefined && change.after !== undefined
          ? ` ${change.before} -> ${change.after}`
          : change.after !== undefined
            ? ` -> ${change.after}`
            : change.before !== undefined
              ? ` ${change.before} ->`
              : '';
      lines.push(`      ${marker}${where} ${change.kind}${delta}`);
    }
  }

  lines.push(
    summary.breakingTools > 0
      ? `${summary.breakingTools} tool(s) with breaking changes (${summary.breakingChanges} breaking change(s) total)`
      : 'No breaking changes.'
  );
  return lines.join('\n');
}
