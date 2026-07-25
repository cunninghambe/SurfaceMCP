// Best-effort response typing for Django REST Framework views.
//
// The Django extractor is regex-based (there is no Python AST available here),
// so this stays in the same idiom: parse `serializers.py` textually, index the
// serializer classes, and expand the one named by a view's `serializer_class`.
//
// What resolves:
//   - explicitly declared fields — `name = serializers.CharField()` — including
//     `ChoiceField(choices=[...])` -> `enum`, and nested serializers
//     (`author = AuthorSerializer()`, `items = ItemSerializer(many=True)`);
//   - `class Meta: fields = ('id', 'name')` on a ModelSerializer: the listed
//     names become properties, typed when also declared explicitly and left open
//     (`{}`) otherwise — the key set is still worth reporting.
// What does not (and yields no schema rather than a wrong one):
//   `fields = '__all__'`, model-derived field types, `SerializerMethodField`
//   return types, `source=`/`to_representation` overrides. `DecimalField` is
//   typed as a number even though DRF renders it as a string unless
//   COERCE_DECIMAL_TO_STRING is off — the setting is not visible from here.
//
// Objects are emitted without `required`: DRF can omit fields at runtime
// (`SerializerMethodField` returning None, conditional `to_representation`), so
// the key set is a hint rather than a contract.

import type { JsonSchema2020 } from '../../types.js';

/** Hard ceiling on nested-serializer expansion; also the cycle-guard backstop. */
const MAX_SERIALIZER_DEPTH = 5;

export type SerializerDef = {
  name: string;
  /** Text of the class body, used for field parsing. */
  body: string;
};

export type SerializerIndex = Map<string, SerializerDef>;

/** DRF field class -> JSON Schema fragment. Unlisted fields degrade to `{}`. */
const FIELD_TYPES: Record<string, JsonSchema2020> = {
  CharField: { type: 'string' },
  TextField: { type: 'string' },
  SlugField: { type: 'string' },
  RegexField: { type: 'string' },
  StringRelatedField: { type: 'string' },
  EmailField: { type: 'string', format: 'email' },
  URLField: { type: 'string', format: 'uri' },
  UUIDField: { type: 'string', format: 'uuid' },
  IPAddressField: { type: 'string' },
  IntegerField: { type: 'integer' },
  FloatField: { type: 'number' },
  DecimalField: { type: 'number' },
  BooleanField: { type: 'boolean' },
  NullBooleanField: { type: 'boolean' },
  DateTimeField: { type: 'string', format: 'date-time' },
  DateField: { type: 'string', format: 'date' },
  TimeField: { type: 'string', format: 'time' },
  DurationField: { type: 'string' },
  // `choices=[...]` refines these to an `enum` when the literals are resolvable.
  ChoiceField: { type: 'string' },
  MultipleChoiceField: { type: 'array' },
  ListField: { type: 'array' },
  DictField: { type: 'object', additionalProperties: true },
  JSONField: { type: 'object', additionalProperties: true },
  FileField: { type: 'string' },
  ImageField: { type: 'string' },
};

/**
 * Slice out a top-level `class <name>(...)` block: everything up to the next
 * column-0 `class`/`def`. Shared shape with the view-class scan in ast-walk.
 */
export function extractClassBlock(
  className: string,
  content: string
): { header: string; body: string } | null {
  // The name is interpolated into a regex, so reject anything that isn't a
  // plain Python identifier rather than risk a SyntaxError on odd input.
  if (!/^[A-Za-z_]\w*$/.test(className)) return null;
  const re = new RegExp(`class\\s+${className}\\b([^:]*):`, 'm');
  const m = re.exec(content);
  if (!m) return null;
  const after = content.slice(m.index + m[0].length);
  const end = after.search(/^(?:class|def)\s+/m);
  return { header: m[1] ?? '', body: end === -1 ? after : after.slice(0, end) };
}

/** Index every `class X(...Serializer):` in a serializers.py file. */
export function buildSerializerIndex(content: string): SerializerIndex {
  const index: SerializerIndex = new Map();
  if (!content) return index;
  const re = /^class\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const name = match[1];
    if (index.has(name)) continue;
    const block = extractClassBlock(name, content);
    if (block) index.set(name, { name, body: block.body });
  }
  return index;
}

/** String/number literals of a `choices=[...]` / `choices=(...)` argument. */
function parseChoices(args: string): unknown[] | null {
  const m = /choices\s*=\s*[[(]([\s\S]*?)[\])]/.exec(args);
  if (!m) return null;
  const values: unknown[] = [];
  const literal = /'([^']*)'|"([^"]*)"|(-?\d+(?:\.\d+)?)/g;
  let hit: RegExpExecArray | null;
  while ((hit = literal.exec(m[1])) !== null) {
    if (hit[3] !== undefined) values.push(Number(hit[3]));
    else values.push(hit[1] ?? hit[2]);
  }
  if (values.length === 0) return null;
  // `choices=[('a', 'Label A'), ...]` — DRF stores the first element of each
  // pair as the value, so de-duplicate by taking every other entry when the
  // list is clearly pairs. Best-effort: keep unique values in declaration order.
  return [...new Set(values)];
}

/**
 * `fields = ('id', 'name')` / `fields = ['id']` — the `class Meta:` field list.
 * Searched across the whole class body rather than scoped to the Meta block:
 * `fields` is only ever assigned inside Meta, and a serializer's own field
 * assignments are excluded by name in `declaredFields`. Returns null for
 * `'__all__'` (model-derived, nothing statically resolvable).
 */
function metaFields(body: string): string[] | null {
  const m = /\bfields\s*=\s*[[(]([\s\S]*?)[\])]/.exec(body);
  if (!m) return null;
  const names: string[] = [];
  const literal = /'([^']*)'|"([^"]*)"/g;
  let hit: RegExpExecArray | null;
  while ((hit = literal.exec(m[1])) !== null) {
    const value = hit[1] ?? hit[2];
    if (value === '__all__') return null; // model-derived: nothing to type
    names.push(value);
  }
  return names.length > 0 ? names : null;
}

type DeclaredField = { name: string; schema: JsonSchema2020 };

/** Declared field assignments in a serializer body, in declaration order. */
function declaredFields(
  def: SerializerDef,
  index: SerializerIndex,
  depth: number,
  visited: Set<string>
): DeclaredField[] {
  const fields: DeclaredField[] = [];
  const re = /^\s+([a-zA-Z_]\w*)\s*=\s*(?:serializers\.)?([A-Za-z_]\w*)\s*\(([\s\S]*?)\)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(def.body)) !== null) {
    const [, name, fieldType, args] = match;
    if (name === 'model' || name === 'fields') continue;

    // Nested serializer: `author = AuthorSerializer()` / `ItemSerializer(many=True)`.
    if (index.has(fieldType)) {
      const many = /\bmany\s*=\s*True\b/.test(args);
      const nested = serializerSchema(fieldType, index, depth + 1, visited);
      const item = nested ?? { type: 'object' };
      fields.push({ name, schema: many ? { type: 'array', items: item } : item });
      continue;
    }

    const base = FIELD_TYPES[fieldType];
    if (!base) {
      fields.push({ name, schema: {} }); // SerializerMethodField, relations, unknown
      continue;
    }
    const schema: JsonSchema2020 = { ...base };
    if (fieldType === 'ChoiceField' || /\bchoices\s*=/.test(args)) {
      const choices = parseChoices(args);
      if (choices) {
        schema.enum = choices;
        if (choices.every((c) => typeof c === 'string')) schema.type = 'string';
      }
    }
    if (/\bmany\s*=\s*True\b/.test(args)) {
      fields.push({ name, schema: { type: 'array', items: schema } });
      continue;
    }
    fields.push({ name, schema });
  }
  return fields;
}

/**
 * Expand a serializer by name into a JSON Schema object. Depth-bounded and
 * cycle-guarded exactly like the TS DTO walk: a serializer already being
 * expanded on the current path degrades to `{ type: 'object' }`.
 * Returns null when nothing usable could be derived.
 */
export function serializerSchema(
  name: string,
  index: SerializerIndex,
  depth = 0,
  visited: Set<string> = new Set()
): JsonSchema2020 | null {
  if (depth + 1 > MAX_SERIALIZER_DEPTH || visited.has(name)) return { type: 'object' };
  const def = index.get(name);
  if (!def) return null;

  const nextVisited = new Set([...visited, name]);
  const declared = declaredFields(def, index, depth, nextVisited);
  const declaredByName = new Map(declared.map((f) => [f.name, f.schema]));

  const listed = metaFields(def.body);
  const order = listed ?? declared.map((f) => f.name);
  if (order.length === 0) return null;

  const properties: Record<string, JsonSchema2020> = {};
  for (const field of order) {
    properties[field] = declaredByName.get(field) ?? {};
  }
  // Explicitly declared fields not named in Meta.fields still ship on the wire
  // when Meta.fields is absent; when it is present it is authoritative.
  if (!listed) {
    for (const field of declared) properties[field.name] = field.schema;
  }

  if (Object.keys(properties).length === 0) return null;
  return { type: 'object', properties };
}
