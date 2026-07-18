import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildSchema,
  getNamedType,
  isNonNullType,
  isListType,
  isScalarType,
  isEnumType,
  isObjectType,
  isInterfaceType,
  isInputObjectType,
  type GraphQLSchema,
  type GraphQLType,
  type GraphQLField,
  type GraphQLInputObjectType,
  type GraphQLObjectType,
  type GraphQLInterfaceType,
  type GraphQLEnumType,
} from 'graphql';
import type { RawToolMeta, JsonSchema2020, GraphQLToolDescriptor } from '../../types.js';

const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', '.surfacemcp', '.next', 'build']);
const SDL_RE = /\.(graphql|gql)$/i;

/**
 * Operation-keyed stable id. Every GraphQL tool shares `POST <graphqlPath>`, so the
 * REST `sha1(method:path)` scheme would collapse them onto one id. Key on the
 * operation instead — mirrors the server-actions precedent (`sha1(serveraction:…)`).
 */
function computeGraphqlToolId(operationType: 'query' | 'mutation', field: string): string {
  return createHash('sha1')
    .update(`graphql:${operationType}:${field}`)
    .digest('hex')
    .slice(0, 12);
}

/** `query_<field>` / `mutation_<field>`. Path-based `pathToToolName` can't express this. */
function operationToolName(operationType: 'query' | 'mutation', field: string): string {
  return `${operationType}_${field}`;
}

function walkSdl(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) walkSdl(full, files);
    } else if (SDL_RE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function relPosix(root: string, abs: string): string {
  return relative(root, abs).replace(/\\/g, '/');
}

// ─── GraphQL type → JSON Schema ───────────────────────────────────────────────

function scalarToJsonSchema(name: string): JsonSchema2020 {
  switch (name) {
    case 'ID':
    case 'String':
      return { type: 'string' };
    case 'Int':
      return { type: 'integer' };
    case 'Float':
      return { type: 'number' };
    case 'Boolean':
      return { type: 'boolean' };
    // Custom scalars (Date, JSON, …) have no portable JSON Schema type; treat as string.
    default:
      return { type: 'string' };
  }
}

function enumToJsonSchema(t: GraphQLEnumType): JsonSchema2020 {
  return { type: 'string', enum: t.getValues().map((v) => v.value ?? v.name) };
}

/** True when a `!`/`[]`-wrapped type contains a list anywhere in its wrapper chain. */
function typeContainsList(type: GraphQLType): boolean {
  let t: GraphQLType | undefined = type;
  while (t) {
    if (isListType(t)) return true;
    if (isNonNullType(t)) {
      t = t.ofType;
      continue;
    }
    return false;
  }
  return false;
}

function maybeArray(schema: JsonSchema2020, isList: boolean): JsonSchema2020 {
  return isList ? { type: 'array', items: schema } : schema;
}

/**
 * Map a GraphQL *input position* type (arg or input-object field) to JSON Schema.
 * `!` (non-null) is handled by the caller via `required`; here it is unwrapped.
 * Input objects nest recursively; `seen` guards against recursive input types.
 */
function inputTypeToJsonSchema(type: GraphQLType, seen: Set<string>): JsonSchema2020 {
  if (isNonNullType(type)) return inputTypeToJsonSchema(type.ofType, seen);
  if (isListType(type)) return { type: 'array', items: inputTypeToJsonSchema(type.ofType, seen) };
  const named = getNamedType(type);
  if (isScalarType(named)) return scalarToJsonSchema(named.name);
  if (isEnumType(named)) return enumToJsonSchema(named);
  if (isInputObjectType(named)) return inputObjectToJsonSchema(named, seen);
  // An object/interface/union in input position is invalid GraphQL; be permissive.
  return { type: 'object', additionalProperties: true };
}

function inputObjectToJsonSchema(t: GraphQLInputObjectType, seen: Set<string>): JsonSchema2020 {
  if (seen.has(t.name)) {
    // Recursive input type — stop expanding to avoid infinite recursion.
    return { type: 'object', additionalProperties: true };
  }
  const nextSeen = new Set(seen).add(t.name);
  const properties: Record<string, JsonSchema2020> = {};
  const required: string[] = [];
  for (const [fieldName, field] of Object.entries(t.getFields())) {
    properties[fieldName] = inputTypeToJsonSchema(field.type, nextSeen);
    if (isNonNullType(field.type)) required.push(fieldName);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

/** Build the inputSchema for a root field from its arguments. */
function buildInputSchema(field: GraphQLField<unknown, unknown>): JsonSchema2020 {
  const properties: Record<string, JsonSchema2020> = {};
  const required: string[] = [];
  for (const arg of field.args) {
    properties[arg.name] = inputTypeToJsonSchema(arg.type, new Set());
    if (isNonNullType(arg.type)) required.push(arg.name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

/**
 * Build the outputSchema + shallow selection set for a root field's return type.
 * Depth limit: object return types are expanded exactly one level. Scalar/enum leaf
 * fields become JSON Schema properties and enter the selection set; nested object /
 * list-of-object fields are emitted as opaque `{type:'object'}` / `{type:'array'}`
 * markers and are NOT selected (selecting them would need a nested sub-selection).
 */
function buildOutputAndSelection(returnType: GraphQLType): {
  outputSchema?: JsonSchema2020;
  selection?: string;
} {
  const isList = typeContainsList(returnType);
  const named = getNamedType(returnType);

  if (isScalarType(named)) {
    return { outputSchema: maybeArray(scalarToJsonSchema(named.name), isList) };
  }
  if (isEnumType(named)) {
    return { outputSchema: maybeArray(enumToJsonSchema(named), isList) };
  }
  if (isObjectType(named) || isInterfaceType(named)) {
    const { objectSchema, selection } = shallowObject(named);
    return { outputSchema: maybeArray(objectSchema, isList), selection };
  }
  // Union or otherwise unhandled composite — return __typename so the query is valid.
  return { outputSchema: maybeArray({ type: 'object', additionalProperties: true }, isList), selection: '__typename' };
}

function shallowObject(t: GraphQLObjectType | GraphQLInterfaceType): {
  objectSchema: JsonSchema2020;
  selection: string;
} {
  const properties: Record<string, JsonSchema2020> = {};
  const selectionFields: string[] = [];
  for (const [fieldName, field] of Object.entries(t.getFields())) {
    if (fieldName.startsWith('__')) continue;
    const fieldIsList = typeContainsList(field.type);
    const fieldNamed = getNamedType(field.type);
    if (isScalarType(fieldNamed)) {
      properties[fieldName] = maybeArray(scalarToJsonSchema(fieldNamed.name), fieldIsList);
      selectionFields.push(fieldName);
    } else if (isEnumType(fieldNamed)) {
      properties[fieldName] = maybeArray(enumToJsonSchema(fieldNamed), fieldIsList);
      selectionFields.push(fieldName);
    } else {
      // Nested object/list-of-object: opaque marker, not selected (depth limit).
      properties[fieldName] = maybeArray({ type: 'object' }, fieldIsList);
    }
  }
  // A GraphQL object selection set can't be empty; __typename is always valid.
  const selection = selectionFields.length ? selectionFields.join(' ') : '__typename';
  return { objectSchema: { type: 'object', properties }, selection };
}

// ─── Schema discovery ─────────────────────────────────────────────────────────

type LoadedSchema = {
  schema: GraphQLSchema;
  /** SDL source files actually used to build `schema` (posix-relative to root). */
  usedFiles: Array<{ rel: string; text: string }>;
  /** True when exactly one SDL file was used, so astNode line numbers map to it. */
  singleFile: boolean;
};

/**
 * Load a GraphQL schema from the project's SDL files. Prefers a single combined
 * parse (so schemas split across files work); if that fails — most often a
 * duplicate definition across files — falls back to the first individual file that
 * builds and declares a Query or Mutation root.
 */
function loadSchema(root: string): LoadedSchema | null {
  const abs = walkSdl(root).sort((a, b) => relPosix(root, a).localeCompare(relPosix(root, b)));
  const files: Array<{ rel: string; text: string }> = [];
  for (const f of abs) {
    try {
      files.push({ rel: relPosix(root, f), text: readFileSync(f, 'utf-8') });
    } catch {
      // unreadable — skip
    }
  }
  if (files.length === 0) return null;

  try {
    const schema = buildSchema(files.map((f) => f.text).join('\n\n'));
    if (schema.getQueryType() || schema.getMutationType()) {
      return { schema, usedFiles: files, singleFile: files.length === 1 };
    }
  } catch {
    // fall through to per-file
  }

  for (const f of files) {
    try {
      const schema = buildSchema(f.text);
      if (schema.getQueryType() || schema.getMutationType()) {
        return { schema, usedFiles: [f], singleFile: true };
      }
    } catch {
      // try next
    }
  }
  return null;
}

function fieldLine(field: GraphQLField<unknown, unknown>, singleFile: boolean): number {
  if (!singleFile) return 0;
  const loc = field.astNode?.loc;
  return loc ? loc.startToken.line : 0;
}

/** SDL file that textually declares the given root type block, for `sourceFile`. */
function rootTypeFile(loaded: LoadedSchema, typeName: 'Query' | 'Mutation'): string {
  const re = new RegExp(`\\btype\\s+${typeName}\\b`);
  const match = loaded.usedFiles.find((f) => re.test(f.text));
  return (match ?? loaded.usedFiles[0]).rel;
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Extract one MCP tool per top-level Query and Mutation field from a schema-first
 * GraphQL SDL. `graphqlPath` (default '/graphql') becomes each tool's `path`.
 */
export function extractGraphqlSchema(root: string, graphqlPath = '/graphql'): RawToolMeta[] {
  const loaded = loadSchema(root);
  if (!loaded) return [];

  const tools: RawToolMeta[] = [];

  const roots: Array<{ operationType: 'query' | 'mutation'; type: GraphQLObjectType | null | undefined; file: string }> = [
    { operationType: 'query', type: loaded.schema.getQueryType(), file: rootTypeFile(loaded, 'Query') },
    { operationType: 'mutation', type: loaded.schema.getMutationType(), file: rootTypeFile(loaded, 'Mutation') },
  ];

  for (const { operationType, type, file } of roots) {
    if (!type) continue;
    for (const [fieldName, field] of Object.entries(type.getFields())) {
      if (fieldName.startsWith('__')) continue; // skip introspection meta-fields
      const inputSchema = buildInputSchema(field);
      const { outputSchema, selection } = buildOutputAndSelection(field.type);
      const descriptor: GraphQLToolDescriptor = {
        operationType,
        field: fieldName,
        args: field.args.map((a) => ({ name: a.name, gqlType: String(a.type) })),
        ...(selection ? { selection } : {}),
      };

      tools.push({
        name: operationToolName(operationType, fieldName),
        toolId: computeGraphqlToolId(operationType, fieldName),
        method: 'POST',
        path: graphqlPath,
        inputSchema,
        inputSchemaConfidence: 'introspected',
        ...(outputSchema ? { outputSchema } : {}),
        sideEffectClass: operationType === 'query' ? 'safe' : 'mutating',
        sourceFile: file,
        sourceLine: fieldLine(field, loaded.singleFile),
        sourceFunctionName: fieldName,
        isServerAction: false,
        graphql: descriptor,
      });
    }
  }

  return tools;
}
