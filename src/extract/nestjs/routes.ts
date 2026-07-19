import { readdirSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import {
  Project,
  SyntaxKind,
  Node,
  type ClassDeclaration,
  type Decorator,
  type EnumDeclaration,
  type EnumMember,
  type MethodDeclaration,
  type ParameterDeclaration,
  type PropertyDeclaration,
} from 'ts-morph';
import type { RawToolMeta, JsonSchema2020, InputSchemaConfidence } from '../../types.js';
import { toolId, pathToToolName, methodToSideEffect } from '../common.js';

const UNKNOWN_SCHEMA: JsonSchema2020 = { type: 'object', additionalProperties: true };

// Nest HTTP-method decorators -> the HTTP verb(s) they emit. `@All()` maps to a
// GET+POST pair (the two most common verbs) so both a safe and a mutating tool
// surface for a catch-all handler; the alternative (GET-only) would drop the
// mutating variant entirely.
const METHOD_DECORATORS: Record<string, string[]> = {
  Get: ['GET'],
  Post: ['POST'],
  Put: ['PUT'],
  Patch: ['PATCH'],
  Delete: ['DELETE'],
  Head: ['HEAD'],
  Options: ['OPTIONS'],
  All: ['GET', 'POST'],
};

type RouteRecord = {
  method: string;
  path: string;
  inputSchema: JsonSchema2020;
  inputSchemaConfidence: InputSchemaConfidence;
  sourceFile: string;
  sourceLine: number;
};

function walkDir(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
      walkDir(full, files);
    } else if (/\.(ts|js)$/.test(entry.name) && !entry.name.includes('.test.') && !entry.name.includes('.spec.')) {
      files.push(full);
    }
  }
  return files;
}

/** First string-literal argument of a decorator (`@Controller('items')` -> 'items'), else null. */
function decoratorStringArg(dec: Decorator): string | null {
  const arg = dec.getArguments()[0];
  if (!arg) return null;
  if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) {
    return arg.getLiteralValue();
  }
  return null;
}

/**
 * Compose a controller prefix and a method-decorator path into a single route.
 * Both are optional and may carry surrounding slashes; each segment is trimmed
 * of slashes and rejoined so `('items', ':id')` -> `/items/:id` and `('', '')`
 * -> `/`. Nest uses path-to-regexp, so `:id`-style params pass through as-is.
 */
function composeRoute(prefix: string, sub: string): string {
  const parts = [prefix, sub]
    .map((s) => s.replace(/^\/+|\/+$/g, '').trim())
    .filter((s) => s.length > 0);
  return `/${parts.join('/')}`;
}

/**
 * Introspection covers (per DTO property):
 *  - primitives: string / number / boolean / integer (`@IsInt`), with `@IsEmail`
 *    and `@IsUUID` string formats;
 *  - arrays: `tags: string[]`, `Array<T>`, or `@IsArray()` + `@Is*({ each: true })`
 *    -> `{ type: 'array', items: {...} }` (items may themselves be a nested DTO);
 *  - nested DTO-typed properties: inlined recursively, bounded by MAX_DTO_DEPTH
 *    and guarded against cycles (a DTO seen earlier on the current resolution
 *    path degrades to `{ type: 'object' }` instead of recursing forever);
 *  - enums: `@IsEnum(E)` and/or a property typed by a resolvable TS enum
 *    -> `{ enum: [...values] }` (+ `type` when the members are uniform);
 *  - numeric / length constraints: `@Min`/`@Max` -> `minimum`/`maximum`,
 *    `@MinLength`/`@MaxLength` -> `minLength`/`maxLength`,
 *    `@IsPositive`/`@IsNegative` -> `exclusiveMinimum`/`exclusiveMaximum: 0`.
 * Still unsupported (degrade to an open `{}` or best-available type, never throw):
 *  union / intersection / generic (non-array) types, tuple types, index
 *  signatures, `Record<...>`/map-shaped props, and `@IsEnum` over an inline
 *  object literal (only named TS enums resolve).
 */

/** Hard ceiling on nested-DTO expansion; also the cycle-guard backstop. */
const MAX_DTO_DEPTH = 5;

/** Shared lookup tables for a single extraction pass. */
type IntrospectCtx = {
  dtoIndex: Map<string, ClassDeclaration>;
  enumIndex: Map<string, EnumDeclaration>;
};

/** Map a TypeScript type-node text to a JSON Schema primitive type, if recognizable. */
function tsTypeToJson(typeText: string | undefined): string | null {
  switch (typeText) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return null;
  }
}

/**
 * If `typeText` is an array type (`T[]`, `Array<T>`, `ReadonlyArray<T>`), return
 * the element type text; otherwise null. Text-based so it is stable across OSes
 * and needs no type-checker.
 */
function arrayElementText(typeText: string | undefined): string | null {
  if (!typeText) return null;
  const t = typeText.trim();
  const bracket = /^(.+)\[\]$/.exec(t);
  if (bracket) return bracket[1].trim();
  const generic = /^(?:Readonly)?Array<(.+)>$/.exec(t);
  if (generic) return generic[1].trim();
  return null;
}

/**
 * class-validator decorator -> a JSON Schema refinement. Covers the common
 * primitive validators; unrecognized decorators are ignored (best-effort).
 */
function validatorRefinement(name: string): Partial<JsonSchema2020> | null {
  switch (name) {
    case 'IsString':
      return { type: 'string' };
    case 'IsInt':
      return { type: 'integer' };
    case 'IsNumber':
      return { type: 'number' };
    case 'IsBoolean':
      return { type: 'boolean' };
    case 'IsEmail':
      return { type: 'string', format: 'email' };
    case 'IsUUID':
      return { type: 'string', format: 'uuid' };
    default:
      return null;
  }
}

/** First numeric argument of a decorator (`@Min(3)` -> 3, `@Min(-5)` -> -5), else null. */
function firstNumericArg(dec: Decorator): number | null {
  const arg = dec.getArguments()[0];
  if (!arg) return null;
  const n = Number(arg.getText());
  return Number.isFinite(n) ? n : null;
}

/** True when a decorator carries a `{ each: true }` option (per-element validation). */
function decoratorHasEach(dec: Decorator): boolean {
  for (const arg of dec.getArguments()) {
    if (!Node.isObjectLiteralExpression(arg)) continue;
    const prop = arg.getProperty('each');
    if (prop && Node.isPropertyAssignment(prop)) {
      if (prop.getInitializer()?.getText() === 'true') return true;
    }
  }
  return false;
}

/** Resolve a single enum member's literal value, falling back to its computed value / name. */
function enumMemberValue(member: EnumMember): string | number {
  const init = member.getInitializer();
  if (init) {
    if (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init)) {
      return init.getLiteralValue();
    }
    if (Node.isNumericLiteral(init)) return Number(init.getLiteralValue());
    if (Node.isPrefixUnaryExpression(init)) {
      const n = Number(init.getText());
      if (Number.isFinite(n)) return n;
    }
  }
  const computed = member.getValue();
  if (typeof computed === 'string' || typeof computed === 'number') return computed;
  // Un-computable member (e.g. references an external const): fall back to its name.
  return member.getName();
}

/** A resolvable TS enum -> `{ enum: [...values] }`, plus `type` when members are uniform. */
function enumToSchema(en: EnumDeclaration): JsonSchema2020 {
  const values = en.getMembers().map(enumMemberValue);
  if (values.length === 0) return { type: 'object' };
  const schema: JsonSchema2020 = { enum: values };
  const allString = values.every((v) => typeof v === 'string');
  const allNumber = values.every((v) => typeof v === 'number');
  if (allString) schema.type = 'string';
  else if (allNumber) schema.type = 'number';
  return schema;
}

/** `@IsEnum(SomeEnum)` -> the enum's schema, when the argument names a resolvable TS enum. */
function enumFromDecorator(dec: Decorator, ctx: IntrospectCtx): JsonSchema2020 | null {
  const arg = dec.getArguments()[0];
  if (!arg) return null;
  const name = bareTypeName(arg.getText());
  const en = name ? ctx.enumIndex.get(name) : undefined;
  return en ? enumToSchema(en) : null;
}

/**
 * Expand a nested DTO reference by name, honoring the depth ceiling and cycle
 * guard. `visited` is the chain of DTO names already being expanded on the
 * current path; re-encountering one (or exceeding MAX_DTO_DEPTH) degrades to an
 * open object rather than recursing forever.
 */
function resolveDtoRef(
  name: string,
  ctx: IntrospectCtx,
  depth: number,
  visited: Set<string>
): JsonSchema2020 {
  if (depth + 1 > MAX_DTO_DEPTH || visited.has(name)) return { type: 'object' };
  const cls = ctx.dtoIndex.get(name);
  if (!cls) return { type: 'object' };
  const nested = dtoToSchema(cls, ctx, depth + 1, new Set([...visited, name]));
  return nested ?? { type: 'object' };
}

/** Schema for a bare (non-array) type: primitive, resolvable enum, nested DTO, or open `{}`. */
function schemaForBaseType(
  typeText: string | undefined,
  ctx: IntrospectCtx,
  depth: number,
  visited: Set<string>
): JsonSchema2020 {
  const prim = tsTypeToJson(typeText);
  if (prim) return { type: prim };
  const name = bareTypeName(typeText);
  if (name && ctx.enumIndex.has(name)) return enumToSchema(ctx.enumIndex.get(name)!);
  if (name && ctx.dtoIndex.has(name)) return resolveDtoRef(name, ctx, depth, visited);
  return {};
}

/** Schema for a type text that may itself be an array; wraps `schemaForBaseType`. */
function schemaForTypeText(
  typeText: string | undefined,
  ctx: IntrospectCtx,
  depth: number,
  visited: Set<string>
): JsonSchema2020 {
  const elem = arrayElementText(typeText);
  if (elem !== null) {
    return { type: 'array', items: schemaForBaseType(elem, ctx, depth, visited) };
  }
  return schemaForBaseType(typeText, ctx, depth, visited);
}

/** Apply one class-validator decorator's refinement onto `target` in place. */
function applyDecorator(
  target: JsonSchema2020,
  dec: Decorator,
  ctx: IntrospectCtx
): void {
  const name = dec.getName();

  const refinement = validatorRefinement(name);
  if (refinement) {
    Object.assign(target, refinement);
    return;
  }
  if (name === 'IsEnum') {
    const enumSchema = enumFromDecorator(dec, ctx);
    if (enumSchema) Object.assign(target, enumSchema);
    return;
  }

  const n = firstNumericArg(dec);
  switch (name) {
    case 'Min':
      if (n !== null) target.minimum = n;
      return;
    case 'Max':
      if (n !== null) target.maximum = n;
      return;
    case 'MinLength':
      if (n !== null) target.minLength = n;
      return;
    case 'MaxLength':
      if (n !== null) target.maxLength = n;
      return;
    case 'IsPositive':
      target.exclusiveMinimum = 0;
      return;
    case 'IsNegative':
      target.exclusiveMaximum = 0;
      return;
  }
}

/** Build the JSON Schema for one DTO property from its TS type + class-validator decorators. */
function propertySchema(
  prop: PropertyDeclaration,
  ctx: IntrospectCtx,
  depth: number,
  visited: Set<string>
): JsonSchema2020 {
  const decorators = prop.getDecorators();
  const typeText = prop.getTypeNode()?.getText();
  const elem = arrayElementText(typeText);
  const hasIsArray = decorators.some((d) => d.getName() === 'IsArray');

  // Array property: from `T[]`/`Array<T>` and/or `@IsArray()`. Item schema comes
  // from the element type; `@Is*({ each: true })` decorators refine each item.
  if (elem !== null || hasIsArray) {
    const items: JsonSchema2020 =
      elem !== null ? schemaForBaseType(elem, ctx, depth, visited) : {};
    for (const dec of decorators) {
      if (decoratorHasEach(dec)) applyDecorator(items, dec, ctx);
    }
    return { type: 'array', items };
  }

  // Scalar / enum / nested-DTO property.
  const schema = schemaForBaseType(typeText, ctx, depth, visited);
  for (const dec of decorators) {
    if (decoratorHasEach(dec)) continue; // per-element decorators don't refine a scalar
    applyDecorator(schema, dec, ctx);
  }
  return schema;
}

/** True when a property is optional (`name?: string` or `@IsOptional()`). */
function isOptionalProperty(prop: PropertyDeclaration): boolean {
  if (prop.hasQuestionToken()) return true;
  return prop.getDecorators().some((d) => d.getName() === 'IsOptional');
}

/**
 * Introspect a DTO class into a JSON Schema object, recursing into nested DTOs
 * (depth-bounded, cycle-guarded via `visited`). Returns null when the class has
 * no usable properties so the caller can fall back to the unknown schema.
 */
function dtoToSchema(
  cls: ClassDeclaration,
  ctx: IntrospectCtx,
  depth: number,
  visited: Set<string>
): JsonSchema2020 | null {
  const properties: Record<string, JsonSchema2020> = {};
  const required: string[] = [];

  for (const prop of cls.getProperties()) {
    if (prop.isStatic()) continue;
    const name = prop.getName();
    properties[name] = propertySchema(prop, ctx, depth, visited);
    if (!isOptionalProperty(prop)) required.push(name);
  }

  if (Object.keys(properties).length === 0) return null;

  const schema: JsonSchema2020 = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** Strip generic/union/array decoration from a param type to a bare class name. */
function bareTypeName(typeText: string | undefined): string | null {
  if (!typeText) return null;
  // Take the first identifier-like token (drops `| undefined`, `[]`, generics).
  const match = /[A-Za-z_$][A-Za-z0-9_$]*/.exec(typeText);
  return match ? match[0] : null;
}

/**
 * Resolve the input schema for a handler. Mutating methods introspect the
 * `@Body()` param's DTO; safe methods introspect the `@Query()` param's DTO.
 * A single-field pick (`@Body('field') field: T`) introspects just that field's
 * type and wraps it in a one-property object. Falls back to an open object with
 * 'unknown' confidence when the relevant decorated param, its DTO type, or the
 * DTO's properties can't be resolved.
 */
function resolveSchema(
  method: MethodDeclaration,
  wantDecorator: 'Body' | 'Query',
  ctx: IntrospectCtx
): { inputSchema: JsonSchema2020; inputSchemaConfidence: InputSchemaConfidence } {
  const param = method.getParameters().find((p: ParameterDeclaration) =>
    p.getDecorators().some((d) => d.getName() === wantDecorator)
  );
  if (!param) {
    return { inputSchema: UNKNOWN_SCHEMA, inputSchemaConfidence: 'unknown' };
  }

  const decorator = param.getDecorators().find((d) => d.getName() === wantDecorator)!;
  const paramType = param.getTypeNode()?.getText();

  // Single-field pick: `@Body('field') field: T` / `@Query('field') field: T`.
  // Introspect just that field's type; only when it resolves to something
  // concrete, otherwise fall through to the 'unknown' behavior.
  const fieldName = decoratorStringArg(decorator);
  if (fieldName) {
    const fieldSchema = schemaForTypeText(paramType, ctx, 0, new Set());
    if (Object.keys(fieldSchema).length > 0) {
      return {
        inputSchema: {
          type: 'object',
          properties: { [fieldName]: fieldSchema },
          required: [fieldName],
        },
        inputSchemaConfidence: 'introspected',
      };
    }
    return { inputSchema: UNKNOWN_SCHEMA, inputSchemaConfidence: 'unknown' };
  }

  const typeName = bareTypeName(paramType);
  const dto = typeName ? ctx.dtoIndex.get(typeName) : undefined;
  if (!dto) {
    return { inputSchema: UNKNOWN_SCHEMA, inputSchemaConfidence: 'unknown' };
  }

  const schema = dtoToSchema(dto, ctx, 0, new Set([dto.getName() ?? typeName!]));
  if (!schema) {
    return { inputSchema: UNKNOWN_SCHEMA, inputSchemaConfidence: 'unknown' };
  }
  return { inputSchema: schema, inputSchemaConfidence: 'introspected' };
}

export function extractNestjsRoutes(root: string): RawToolMeta[] {
  const allFiles = walkDir(root);

  const project = new Project({
    useInMemoryFileSystem: false,
    skipFileDependencyResolution: true,
  });
  for (const file of allFiles) {
    project.addSourceFileAtPath(file);
  }

  // Index every class and enum by name so `@Body() dto: SomeDto`, a nested
  // DTO-typed property, or an enum-typed property can be resolved to its
  // declaration regardless of which file it lives in.
  const dtoIndex = new Map<string, ClassDeclaration>();
  const enumIndex = new Map<string, EnumDeclaration>();
  for (const sf of project.getSourceFiles()) {
    for (const cls of sf.getClasses()) {
      const name = cls.getName();
      if (name && !dtoIndex.has(name)) dtoIndex.set(name, cls);
    }
    for (const en of sf.getEnums()) {
      const name = en.getName();
      if (name && !enumIndex.has(name)) enumIndex.set(name, en);
    }
  }
  const ctx: IntrospectCtx = { dtoIndex, enumIndex };

  const records: RouteRecord[] = [];

  for (const sf of project.getSourceFiles()) {
    const sourceFile = relative(root, sf.getFilePath()).replace(/\\/g, '/'); // posix: stable across OSes
    for (const cls of sf.getClasses()) {
      const controller = cls.getDecorator('Controller');
      if (!controller) continue;
      const prefix = decoratorStringArg(controller) ?? '';

      for (const methodNode of cls.getMethods()) {
        for (const dec of methodNode.getDecorators()) {
          const httpMethods = METHOD_DECORATORS[dec.getName()];
          if (!httpMethods) continue;

          const sub = decoratorStringArg(dec) ?? '';
          const path = composeRoute(prefix, sub);
          const sourceLine = dec.getStartLineNumber();

          for (const method of httpMethods) {
            const key = methodToSideEffect(method) === 'safe' ? 'Query' : 'Body';
            const { inputSchema, inputSchemaConfidence } = resolveSchema(methodNode, key, ctx);
            records.push({ method, path, inputSchema, inputSchemaConfidence, sourceFile, sourceLine });
          }
        }
      }
    }
  }

  const nameCounts = new Map<string, number>();
  const tools: RawToolMeta[] = [];

  for (const route of records) {
    const base = pathToToolName(route.method, route.path);
    const count = nameCounts.get(base) ?? 0;
    nameCounts.set(base, count + 1);
    const name = count === 0 ? base : `${base}_${count + 1}`;

    tools.push({
      name,
      toolId: toolId(route.method, route.path),
      method: route.method,
      path: route.path,
      inputSchema: route.inputSchema,
      inputSchemaConfidence: route.inputSchemaConfidence,
      sideEffectClass: methodToSideEffect(route.method),
      sourceFile: route.sourceFile,
      sourceLine: route.sourceLine,
      isServerAction: false,
    });
  }

  return tools;
}
