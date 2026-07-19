import { readdirSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import {
  Project,
  Node,
  SyntaxKind,
  type ClassDeclaration,
  type Decorator,
  type MethodDeclaration,
  type ParameterDeclaration,
  type PropertyDeclaration,
} from 'ts-morph';
import type { RawToolMeta, JsonSchema2020, GraphQLToolDescriptor } from '../../types.js';
import { computeGraphqlToolId, operationToolName, DEFAULT_SELECTION_DEPTH } from './parse.js';

const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', '.surfacemcp', '.next', 'build']);

// GraphQL scalar / TS-primitive names → JSON Schema. Returns null for anything that
// is not a recognized leaf, so the caller can treat it as an object/enum type.
const TS_SCALAR_TO_GQL: Record<string, string> = {
  string: 'String',
  number: 'Float', // type-graphql defaults a bare `number` field to Float
  boolean: 'Boolean',
};

function gqlScalarToJson(name: string): JsonSchema2020 | null {
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
    // Common custom scalars have no portable JSON type; treat as string.
    case 'Date':
    case 'DateTime':
    case 'GraphQLISODateTime':
    case 'GraphQLTimestamp':
      return { type: 'string' };
    default:
      return null;
  }
}

function maybeArray(schema: JsonSchema2020, isList: boolean): JsonSchema2020 {
  return isList ? { type: 'array', items: schema } : schema;
}

// ─── ts-morph helpers ─────────────────────────────────────────────────────────

function walkTs(dir: string, files: string[] = []): string[] {
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
      if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) walkTs(full, files);
    } else if (
      /\.(ts|tsx|js|mjs)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.includes('.test.') &&
      !entry.name.includes('.spec.')
    ) {
      files.push(full);
    }
  }
  return files;
}

function hasAnyDecorator(cls: ClassDeclaration, names: string[]): boolean {
  return names.some((n) => !!cls.getDecorator(n));
}

/** Object-literal options argument of a decorator (`@Query(() => T, { name })`), if any. */
function decoratorOptions(dec: Decorator): Node | undefined {
  return dec.getArguments().find((a) => Node.isObjectLiteralExpression(a));
}

function optionsStringProp(dec: Decorator, key: string): string | undefined {
  const opts = decoratorOptions(dec);
  if (!opts || !Node.isObjectLiteralExpression(opts)) return undefined;
  const prop = opts.getProperty(key);
  if (prop && Node.isPropertyAssignment(prop)) {
    const init = prop.getInitializer();
    if (init && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))) {
      return init.getLiteralValue();
    }
  }
  return undefined;
}

function optionsBoolProp(dec: Decorator, key: string): boolean | undefined {
  const opts = decoratorOptions(dec);
  if (!opts || !Node.isObjectLiteralExpression(opts)) return undefined;
  const prop = opts.getProperty(key);
  if (prop && Node.isPropertyAssignment(prop)) {
    const kind = prop.getInitializer()?.getKind();
    if (kind === SyntaxKind.TrueKeyword) return true;
    if (kind === SyntaxKind.FalseKeyword) return false;
  }
  return undefined;
}

/** First string-literal argument of a decorator (`@Arg('id')` → 'id'), else null. */
function decoratorFirstStringArg(dec: Decorator): string | null {
  const arg = dec.getArguments()[0];
  if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
    return arg.getLiteralValue();
  }
  return null;
}

type GqlTypeRef = { name: string; isList: boolean };

/** Resolve a decorator type thunk (`() => [Recipe]`) to a named type + list flag. */
function thunkType(dec: Decorator): GqlTypeRef | null {
  const arrow = dec.getArguments().find((a) => Node.isArrowFunction(a));
  if (arrow && Node.isArrowFunction(arrow)) return unwrapTypeExpr(arrow.getBody());
  return null;
}

function unwrapTypeExpr(node: Node): GqlTypeRef | null {
  if (Node.isArrayLiteralExpression(node)) {
    const el = node.getElements()[0];
    const inner = el ? unwrapTypeExpr(el) : null;
    return inner ? { name: inner.name, isList: true } : null;
  }
  if (Node.isParenthesizedExpression(node)) {
    const inner = node.getExpression();
    return inner ? unwrapTypeExpr(inner) : null;
  }
  if (Node.isIdentifier(node)) return { name: node.getText(), isList: false };
  return null;
}

/** Map a TypeScript type-node text (`Recipe[]`, `Promise<Recipe>`, `string | null`) to a GraphQL ref. */
function tsTypeToGql(text: string | undefined): GqlTypeRef {
  if (!text) return { name: 'String', isList: false };
  let t = text.replace(/\s*\|\s*(null|undefined)\b/g, '').trim();
  const promise = /^Promise<(.+)>$/.exec(t);
  if (promise) t = promise[1].trim();
  let isList = false;
  const arr = /^(?:Array<(.+)>|(.+)\[\])$/.exec(t);
  if (arr) {
    isList = true;
    t = (arr[1] ?? arr[2]).trim();
  }
  const bare = /[A-Za-z_$][A-Za-z0-9_$]*/.exec(t)?.[0] ?? 'String';
  return { name: TS_SCALAR_TO_GQL[bare] ?? bare, isList };
}

/** GraphQL type ref for a decorated property: prefer its `@Field(() => T)` thunk, else the TS type. */
function propGqlType(prop: PropertyDeclaration): GqlTypeRef {
  const field = prop.getDecorator('Field');
  if (field) {
    const thunk = thunkType(field);
    if (thunk) return thunk;
  }
  return tsTypeToGql(prop.getTypeNode()?.getText());
}

/** The `@Field`-decorated instance properties of an @ObjectType / @InputType class. */
function gqlFields(cls: ClassDeclaration): PropertyDeclaration[] {
  return cls.getProperties().filter((p) => !p.isStatic() && !!p.getDecorator('Field'));
}

function isFieldOptional(prop: PropertyDeclaration): boolean {
  if (prop.hasQuestionToken()) return true;
  const field = prop.getDecorator('Field');
  return !!field && optionsBoolProp(field, 'nullable') === true;
}

// ─── Output type → schema + selection (bounded depth + cycle guard) ─────────────

/**
 * Expand an @ObjectType class into a JSON Schema object + GraphQL selection string,
 * mirroring the schema-first `expandObject`: scalar/enum leaves are selected, nested
 * @ObjectType fields recurse while depth remains and no cycle is on the path, and a
 * field with no selectable children falls back to `__typename`.
 */
function expandObjectClass(
  cls: ClassDeclaration,
  levels: number,
  visited: Set<string>,
  index: Map<string, ClassDeclaration>,
): { objectSchema: JsonSchema2020; selection: string } {
  const properties: Record<string, JsonSchema2020> = {};
  const selectionParts: string[] = [];
  for (const prop of gqlFields(cls)) {
    const fieldName = prop.getName();
    const ref = propGqlType(prop);
    const scalar = gqlScalarToJson(ref.name);
    if (scalar) {
      properties[fieldName] = maybeArray(scalar, ref.isList);
      selectionParts.push(fieldName);
      continue;
    }
    const nestedCls = index.get(ref.name);
    if (nestedCls && levels > 1 && !visited.has(ref.name)) {
      const nested = expandObjectClass(nestedCls, levels - 1, new Set(visited).add(ref.name), index);
      properties[fieldName] = maybeArray(nested.objectSchema, ref.isList);
      selectionParts.push(`${fieldName} { ${nested.selection} }`);
    } else if (nestedCls) {
      // Depth budget exhausted or a cycle: opaque marker, not selected.
      properties[fieldName] = maybeArray({ type: 'object' }, ref.isList);
    } else {
      // Unresolved type — most often a registered enum, which is a selectable leaf.
      properties[fieldName] = maybeArray({ type: 'string' }, ref.isList);
      selectionParts.push(fieldName);
    }
  }
  const selection = selectionParts.length ? selectionParts.join(' ') : '__typename';
  return { objectSchema: { type: 'object', properties }, selection };
}

/** Return type of an operation: its decorator thunk, else the method's TS return type. */
function operationReturnType(dec: Decorator, method: MethodDeclaration): GqlTypeRef | null {
  return thunkType(dec) ?? (method.getReturnTypeNode() ? tsTypeToGql(method.getReturnTypeNode()!.getText()) : null);
}

function buildOutput(
  dec: Decorator,
  method: MethodDeclaration,
  index: Map<string, ClassDeclaration>,
): { outputSchema?: JsonSchema2020; selection?: string } {
  const ret = operationReturnType(dec, method);
  if (!ret) return {};
  const scalar = gqlScalarToJson(ret.name);
  if (scalar) return { outputSchema: maybeArray(scalar, ret.isList) };
  const cls = index.get(ret.name);
  if (cls) {
    const { objectSchema, selection } = expandObjectClass(cls, DEFAULT_SELECTION_DEPTH, new Set([ret.name]), index);
    return { outputSchema: maybeArray(objectSchema, ret.isList), selection };
  }
  // Unresolved return type: emit an opaque schema and no selection (a sub-selection
  // we can't verify would risk an invalid query). Documented limitation.
  return { outputSchema: maybeArray({ type: 'object', additionalProperties: true }, ret.isList) };
}

// ─── Args → inputSchema ─────────────────────────────────────────────────────────

/** JSON Schema for an argument/input-field type; expands @InputType classes, cycle-guarded. */
function inputTypeToJsonSchema(
  ref: GqlTypeRef,
  index: Map<string, ClassDeclaration>,
  seen: Set<string>,
): JsonSchema2020 {
  const scalar = gqlScalarToJson(ref.name);
  let base: JsonSchema2020;
  if (scalar) {
    base = scalar;
  } else {
    const cls = index.get(ref.name);
    base = cls ? inputClassToJsonSchema(cls, index, seen) : { type: 'object', additionalProperties: true };
  }
  return ref.isList ? { type: 'array', items: base } : base;
}

function inputClassToJsonSchema(
  cls: ClassDeclaration,
  index: Map<string, ClassDeclaration>,
  seen: Set<string>,
): JsonSchema2020 {
  const name = cls.getName() ?? '';
  if (seen.has(name)) return { type: 'object', additionalProperties: true };
  const next = new Set(seen).add(name);
  const properties: Record<string, JsonSchema2020> = {};
  const required: string[] = [];
  for (const prop of gqlFields(cls)) {
    const fieldName = prop.getName();
    properties[fieldName] = inputTypeToJsonSchema(propGqlType(prop), index, next);
    if (!isFieldOptional(prop)) required.push(fieldName);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

/** GraphQL type ref for an argument: prefer its `@Arg`/`@Args` type thunk, else the TS type. */
function argGqlType(param: ParameterDeclaration, argDec: Decorator): GqlTypeRef {
  const thunk = thunkType(argDec);
  if (thunk) return thunk;
  return tsTypeToGql(param.getTypeNode()?.getText());
}

function isArgNullable(param: ParameterDeclaration, argDec: Decorator): boolean {
  if (param.hasQuestionToken() || param.hasInitializer()) return true;
  if (optionsBoolProp(argDec, 'nullable') === true) return true;
  return /\b(null|undefined)\b/.test(param.getTypeNode()?.getText() ?? '');
}

/** SDL type string for a variable declaration: `ID!`, `[Recipe]`, `NewRecipeInput!`. */
function toSdlType(ref: GqlTypeRef, nullable: boolean): string {
  const core = ref.isList ? `[${ref.name}]` : ref.name;
  return nullable ? core : `${core}!`;
}

function buildArgsAndInput(
  method: MethodDeclaration,
  index: Map<string, ClassDeclaration>,
): { args: Array<{ name: string; gqlType: string }>; inputSchema: JsonSchema2020 } {
  const args: Array<{ name: string; gqlType: string }> = [];
  const properties: Record<string, JsonSchema2020> = {};
  const required: string[] = [];
  for (const param of method.getParameters()) {
    const argDec = param.getDecorator('Arg') ?? param.getDecorator('Args');
    if (!argDec) continue; // @Ctx()/@Info()/@Root() etc. are not GraphQL arguments
    const name = decoratorFirstStringArg(argDec) ?? param.getName();
    const ref = argGqlType(param, argDec);
    const nullable = isArgNullable(param, argDec);
    args.push({ name, gqlType: toSdlType(ref, nullable) });
    properties[name] = inputTypeToJsonSchema(ref, index, new Set());
    if (!nullable) required.push(name);
  }
  return {
    args,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
  };
}

// ─── Public entry point ───────────────────────────────────────────────────────

function operationDecorator(
  method: MethodDeclaration,
): { operationType: 'query' | 'mutation'; decorator: Decorator } | null {
  for (const dec of method.getDecorators()) {
    const n = dec.getName();
    if (n === 'Query') return { operationType: 'query', decorator: dec };
    if (n === 'Mutation') return { operationType: 'mutation', decorator: dec };
    // Subscription is intentionally out of scope (Query + Mutation only).
  }
  return null;
}

/**
 * Extract one MCP tool per resolver method decorated `@Query()`/`@Mutation()` from a
 * code-first (type-graphql / @nestjs/graphql) project. Tools use the SAME
 * operation-keyed toolId scheme, `query_`/`mutation_` names, and `graphql` descriptor
 * as schema-first extraction, so they are callable identically. Type mapping from TS
 * annotations/decorators is best-effort (see SPEC_GRAPHQL_STACK.md for the boundary).
 */
export function extractGraphqlCodeFirst(root: string, graphqlPath = '/graphql'): RawToolMeta[] {
  const files = walkTs(root);
  if (files.length === 0) return [];

  const project = new Project({ useInMemoryFileSystem: false, skipFileDependencyResolution: true });
  for (const file of files) {
    try {
      project.addSourceFileAtPath(file);
    } catch {
      // unparseable — skip
    }
  }

  // Index @ObjectType/@InterfaceType classes (for output selection) and
  // @InputType/@ArgsType classes (for input schemas) by name.
  const objectTypeIndex = new Map<string, ClassDeclaration>();
  const inputTypeIndex = new Map<string, ClassDeclaration>();
  for (const sf of project.getSourceFiles()) {
    for (const cls of sf.getClasses()) {
      const name = cls.getName();
      if (!name) continue;
      if (hasAnyDecorator(cls, ['ObjectType', 'InterfaceType']) && !objectTypeIndex.has(name)) {
        objectTypeIndex.set(name, cls);
      }
      if (hasAnyDecorator(cls, ['InputType', 'ArgsType']) && !inputTypeIndex.has(name)) {
        inputTypeIndex.set(name, cls);
      }
    }
  }

  const tools: RawToolMeta[] = [];
  const seen = new Set<string>();

  for (const sf of project.getSourceFiles()) {
    const sourceFile = relative(root, sf.getFilePath()).replace(/\\/g, '/'); // posix: stable across OSes
    for (const cls of sf.getClasses()) {
      if (!cls.getDecorator('Resolver')) continue;
      for (const method of cls.getMethods()) {
        const op = operationDecorator(method);
        if (!op) continue;
        const field = optionsStringProp(op.decorator, 'name') ?? method.getName();
        const toolId = computeGraphqlToolId(op.operationType, field);
        if (seen.has(toolId)) continue; // a field declared by two resolvers → first wins
        seen.add(toolId);

        const { args, inputSchema } = buildArgsAndInput(method, inputTypeIndex);
        const { outputSchema, selection } = buildOutput(op.decorator, method, objectTypeIndex);
        const descriptor: GraphQLToolDescriptor = {
          operationType: op.operationType,
          field,
          args,
          ...(selection ? { selection } : {}),
        };

        tools.push({
          name: operationToolName(op.operationType, field),
          toolId,
          method: 'POST',
          path: graphqlPath,
          inputSchema,
          // Derived from TS types + decorator options (heuristic), not an authoritative
          // SDL — hence `inferred` rather than schema-first's `introspected`.
          inputSchemaConfidence: 'inferred',
          ...(outputSchema ? { outputSchema } : {}),
          sideEffectClass: op.operationType === 'query' ? 'safe' : 'mutating',
          sourceFile,
          sourceLine: op.decorator.getStartLineNumber(),
          sourceFunctionName: method.getName(),
          isServerAction: false,
          graphql: descriptor,
        });
      }
    }
  }

  return tools;
}
