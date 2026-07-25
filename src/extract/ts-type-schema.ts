// Shared TypeScript-type -> JSON Schema machinery for the TS-based extractors.
//
// This walk started life inside the NestJS extractor, where it turned `@Body()`
// DTO classes into `inputSchema`. Response typing needs the very same walk for
// NestJS return types, Express `Response<T>` generics and Next.js
// `NextApiResponse<T>` / `NextResponse<T>` generics, so it lives here instead of
// being written a second time.
//
// NestJS behavior is preserved by construction: it builds its TypeIndex with the
// default options, which leaves the interface / type-alias maps empty, so every
// lookup resolves exactly as it did when the maps did not exist.
//
// Coverage (per property):
//  - primitives: string / number / boolean / integer (`@IsInt`), with `@IsEmail`
//    and `@IsUUID` string formats;
//  - arrays: `tags: string[]`, `Array<T>`, or `@IsArray()` + `@Is*({ each: true })`
//    -> `{ type: 'array', items: {...} }` (items may themselves be a named type);
//  - named object types (classes always; interfaces / type aliases when
//    `includeShapes` is on): inlined recursively, bounded by MAX_TYPE_DEPTH and
//    guarded against cycles (a name seen earlier on the current resolution path
//    degrades to `{ type: 'object' }` instead of recursing forever);
//  - enums: `@IsEnum(E)` and/or a property typed by a resolvable TS enum
//    -> `{ enum: [...values] }` (+ `type` when the members are uniform);
//  - numeric / length constraints from class-validator decorators.
// Still unsupported (degrade to an open `{}` or best-available type, never throw):
//  union / intersection / generic (non-array) types, tuple types, index
//  signatures, `Record<...>`/map-shaped props, and `@IsEnum` over an inline
//  object literal (only named TS enums resolve).

import {
  Node,
  SyntaxKind,
  type ClassDeclaration,
  type Decorator,
  type EnumDeclaration,
  type EnumMember,
  type InterfaceDeclaration,
  type Project,
  type PropertySignature,
  type SourceFile,
  type TypeAliasDeclaration,
} from 'ts-morph';
import type { JsonSchema2020 } from '../types.js';

/** Hard ceiling on nested-type expansion; also the cycle-guard backstop. */
export const MAX_TYPE_DEPTH = 5;

/** Named declarations a type reference can resolve to, indexed for one pass. */
export type TypeIndex = {
  classes: Map<string, ClassDeclaration>;
  enums: Map<string, EnumDeclaration>;
  interfaces: Map<string, InterfaceDeclaration>;
  typeAliases: Map<string, TypeAliasDeclaration>;
};

export type TypeIndexOptions = {
  /**
   * Also index `interface` / `type` declarations. Off by default so callers that
   * only ever resolved classes (NestJS DTOs) keep byte-identical behavior; the
   * response-typing callers turn it on because plain TS shapes are how Express /
   * Next.js handlers declare their bodies.
   */
  includeShapes?: boolean;
};

export function emptyTypeIndex(): TypeIndex {
  return { classes: new Map(), enums: new Map(), interfaces: new Map(), typeAliases: new Map() };
}

/** Index every named declaration in `files` (first declaration of a name wins). */
export function indexSourceFiles(
  files: Iterable<SourceFile>,
  opts: TypeIndexOptions = {}
): TypeIndex {
  const index = emptyTypeIndex();
  for (const sf of files) {
    for (const cls of sf.getClasses()) {
      const name = cls.getName();
      if (name && !index.classes.has(name)) index.classes.set(name, cls);
    }
    for (const en of sf.getEnums()) {
      const name = en.getName();
      if (name && !index.enums.has(name)) index.enums.set(name, en);
    }
    if (!opts.includeShapes) continue;
    for (const iface of sf.getInterfaces()) {
      const name = iface.getName();
      if (!index.interfaces.has(name)) index.interfaces.set(name, iface);
    }
    for (const alias of sf.getTypeAliases()) {
      const name = alias.getName();
      if (!index.typeAliases.has(name)) index.typeAliases.set(name, alias);
    }
  }
  return index;
}

/** Index every source file already added to `project`. */
export function buildTypeIndex(project: Project, opts: TypeIndexOptions = {}): TypeIndex {
  return indexSourceFiles(project.getSourceFiles(), opts);
}

// ─── Type-text helpers ────────────────────────────────────────────────────────

/** Map a TypeScript type-node text to a JSON Schema primitive type, if recognizable. */
export function tsTypeToJson(typeText: string | undefined): string | null {
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
export function arrayElementText(typeText: string | undefined): string | null {
  if (!typeText) return null;
  const t = typeText.trim();
  const bracket = /^(.+)\[\]$/.exec(t);
  if (bracket) return bracket[1].trim();
  const generic = /^(?:Readonly)?Array<(.+)>$/.exec(t);
  if (generic) return generic[1].trim();
  return null;
}

/** Strip generic/union/array decoration from a type text to a bare declared name. */
export function bareTypeName(typeText: string | undefined): string | null {
  if (!typeText) return null;
  // Take the first identifier-like token (drops `| undefined`, `[]`, generics).
  const match = /[A-Za-z_$][A-Za-z0-9_$]*/.exec(typeText);
  return match ? match[0] : null;
}

/** Split a generic argument list on its top-level commas. */
function splitTypeArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '<' || c === '[' || c === '{' || c === '(') depth++;
    else if (c === '>' || c === ']' || c === '}' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(args.slice(start).trim());
  return parts.filter((p) => p.length > 0);
}

const ASYNC_WRAPPERS = new Set(['Promise', 'PromiseLike', 'Awaited']);

/**
 * Peel `Promise<...>` / `PromiseLike<...>` / `Awaited<...>` off a return-type
 * text, bounded so a pathological nesting can't spin. `Promise<Item[]>` ->
 * `Item[]`; a non-wrapped text is returned unchanged.
 */
export function unwrapAsyncType(typeText: string | undefined, limit = 3): string | undefined {
  let t = typeText?.trim();
  for (let i = 0; t && i < limit; i++) {
    const arg = genericArgument(t, ASYNC_WRAPPERS);
    if (arg === null) break;
    t = arg;
  }
  return t;
}

/**
 * First type argument of `Wrapper<T, ...>` when `Wrapper`'s bare name is one of
 * `wrappers` (a dotted qualifier such as `express.Response<T>` is accepted).
 * Returns null when the text isn't such a generic. Only the first argument is
 * returned because the response-body type is always first in the generics we
 * care about (`Response<ResBody, Locals>`, `NextApiResponse<T>`).
 */
export function genericArgument(
  typeText: string | undefined,
  wrappers: Iterable<string>
): string | null {
  const t = typeText?.trim();
  if (!t) return null;
  const match = /^([A-Za-z_$][\w$.]*)\s*<([\s\S]+)>$/.exec(t);
  if (!match) return null;
  const base = match[1].split('.').pop() ?? match[1];
  const allowed = wrappers instanceof Set ? wrappers : new Set(wrappers);
  if (!allowed.has(base)) return null;
  const args = splitTypeArgs(match[2]);
  return args.length > 0 ? args[0] : null;
}

// ─── class-validator decorator support ────────────────────────────────────────

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
export function decoratorHasEach(dec: Decorator): boolean {
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
export function enumToSchema(en: EnumDeclaration): JsonSchema2020 {
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
function enumFromDecorator(dec: Decorator, ctx: TypeIndex): JsonSchema2020 | null {
  const arg = dec.getArguments()[0];
  if (!arg) return null;
  const name = bareTypeName(arg.getText());
  const en = name ? ctx.enums.get(name) : undefined;
  return en ? enumToSchema(en) : null;
}

/** Apply one class-validator decorator's refinement onto `target` in place. */
export function applyDecorator(target: JsonSchema2020, dec: Decorator, ctx: TypeIndex): void {
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

// ─── Type -> schema walk ──────────────────────────────────────────────────────

/** Normalized view of one member of an object-ish declaration. */
type PropertyLike = {
  name: string;
  typeText: string | undefined;
  optional: boolean;
  decorators: Decorator[];
};

type NamedTypeDeclaration = ClassDeclaration | InterfaceDeclaration | TypeAliasDeclaration;

function lookupNamedType(name: string, ctx: TypeIndex): NamedTypeDeclaration | undefined {
  return ctx.classes.get(name) ?? ctx.interfaces.get(name) ?? ctx.typeAliases.get(name);
}

/**
 * Expand a named type reference, honoring the depth ceiling and cycle guard.
 * `visited` is the chain of names already being expanded on the current path;
 * re-encountering one (or exceeding MAX_TYPE_DEPTH) degrades to an open object
 * rather than recursing forever.
 */
function resolveNamedType(
  name: string,
  ctx: TypeIndex,
  depth: number,
  visited: Set<string>
): JsonSchema2020 {
  if (depth + 1 > MAX_TYPE_DEPTH || visited.has(name)) return { type: 'object' };
  const decl = lookupNamedType(name, ctx);
  if (!decl) return { type: 'object' };
  const nested = declarationToSchema(decl, ctx, depth + 1, new Set([...visited, name]));
  return nested ?? { type: 'object' };
}

/** Schema for a bare (non-array) type: primitive, resolvable enum, named type, or open `{}`. */
export function schemaForBaseType(
  typeText: string | undefined,
  ctx: TypeIndex,
  depth: number,
  visited: Set<string>
): JsonSchema2020 {
  const prim = tsTypeToJson(typeText);
  if (prim) return { type: prim };
  const name = bareTypeName(typeText);
  if (name && ctx.enums.has(name)) return enumToSchema(ctx.enums.get(name)!);
  if (name && lookupNamedType(name, ctx)) return resolveNamedType(name, ctx, depth, visited);
  return {};
}

/** Schema for a type text that may itself be an array; wraps `schemaForBaseType`. */
export function schemaForTypeText(
  typeText: string | undefined,
  ctx: TypeIndex,
  depth = 0,
  visited: Set<string> = new Set()
): JsonSchema2020 {
  const elem = arrayElementText(typeText);
  if (elem !== null) {
    return { type: 'array', items: schemaForBaseType(elem, ctx, depth, visited) };
  }
  return schemaForBaseType(typeText, ctx, depth, visited);
}

/** Build the JSON Schema for one property from its TS type + class-validator decorators. */
function propertySchema(
  prop: PropertyLike,
  ctx: TypeIndex,
  depth: number,
  visited: Set<string>
): JsonSchema2020 {
  const { decorators, typeText } = prop;
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

  // Scalar / enum / nested-object property.
  const schema = schemaForBaseType(typeText, ctx, depth, visited);
  for (const dec of decorators) {
    if (decoratorHasEach(dec)) continue; // per-element decorators don't refine a scalar
    applyDecorator(schema, dec, ctx);
  }
  return schema;
}

function propertySignatureLike(prop: PropertySignature): PropertyLike {
  return {
    name: prop.getName(),
    typeText: prop.getTypeNode()?.getText(),
    optional: prop.hasQuestionToken(),
    decorators: [],
  };
}

/** Own, non-static members of a class / interface / type-literal alias. */
function declarationProperties(decl: NamedTypeDeclaration): PropertyLike[] | null {
  if (Node.isClassDeclaration(decl)) {
    const props: PropertyLike[] = [];
    for (const prop of decl.getProperties()) {
      if (prop.isStatic()) continue;
      const decorators = prop.getDecorators();
      props.push({
        name: prop.getName(),
        typeText: prop.getTypeNode()?.getText(),
        optional: prop.hasQuestionToken() || decorators.some((d) => d.getName() === 'IsOptional'),
        decorators,
      });
    }
    return props;
  }
  if (Node.isInterfaceDeclaration(decl)) {
    return decl.getProperties().map(propertySignatureLike);
  }
  const typeNode = decl.getTypeNode();
  if (typeNode && Node.isTypeLiteral(typeNode)) {
    return typeNode.getMembers().filter(Node.isPropertySignature).map(propertySignatureLike);
  }
  return null; // alias to something other than an object literal type
}

/**
 * Introspect a named declaration into a JSON Schema object, recursing into
 * nested named types (depth-bounded, cycle-guarded via `visited`). Returns null
 * when nothing usable could be derived so the caller can fall back.
 */
export function declarationToSchema(
  decl: NamedTypeDeclaration,
  ctx: TypeIndex,
  depth: number,
  visited: Set<string>
): JsonSchema2020 | null {
  const props = declarationProperties(decl);
  if (props === null) {
    // `type Items = Item[]` / `type A = B`: resolve the aliased type text instead.
    const typeNode = Node.isTypeAliasDeclaration(decl) ? decl.getTypeNode() : undefined;
    if (!typeNode) return null;
    const aliased = schemaForTypeText(typeNode.getText(), ctx, depth, visited);
    return isInformativeSchema(aliased) ? aliased : null;
  }

  const properties: Record<string, JsonSchema2020> = {};
  const required: string[] = [];
  for (const prop of props) {
    properties[prop.name] = propertySchema(prop, ctx, depth, visited);
    if (!prop.optional) required.push(prop.name);
  }

  if (Object.keys(properties).length === 0) return null;

  const schema: JsonSchema2020 = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * Whether a derived schema says anything an agent can assert on. `{}` and a bare
 * `{ type: 'object' }` do not, so response typing drops them rather than
 * advertising a schema that carries no information.
 */
export function isInformativeSchema(schema: JsonSchema2020 | undefined | null): boolean {
  if (!schema || Object.keys(schema).length === 0) return false;
  if (schema.enum !== undefined || schema.const !== undefined) return true;
  if (schema.$ref !== undefined) return true;
  if (schema.type === 'array') return true;
  if (schema.type === 'object') return Object.keys(schema.properties ?? {}).length > 0;
  return typeof schema.type === 'string';
}

// ─── Value -> schema inference ────────────────────────────────────────────────

/**
 * Infer a JSON Schema from a *value* expression — the argument of a
 * `res.json(...)` / `NextResponse.json(...)` call. Only literal structure is
 * trusted: object and array literals give up their key set and element type,
 * primitives give their type, and an identifier is followed to a same-file
 * declaration when it carries a type annotation or a literal initializer.
 * Anything else (a call, an await, a member access) degrades to `{}` — the key
 * is still reported, its type is simply left open.
 *
 * Objects are emitted without `required`: a handler can take an early-return
 * branch we didn't see, so the key set is a hint rather than a contract.
 */
export function schemaForValueExpression(
  node: Node | undefined,
  ctx: TypeIndex,
  depth = 0,
  visited: Set<string> = new Set()
): JsonSchema2020 {
  if (!node || depth >= MAX_TYPE_DEPTH) return {};

  if (Node.isParenthesizedExpression(node)) {
    return schemaForValueExpression(node.getExpression(), ctx, depth, visited);
  }
  if (Node.isAsExpression(node) || Node.isSatisfiesExpression(node)) {
    const typed = schemaForTypeText(node.getTypeNode()?.getText(), ctx, depth, visited);
    if (isInformativeSchema(typed)) return typed;
    return schemaForValueExpression(node.getExpression(), ctx, depth, visited);
  }
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return { type: 'string' };
  }
  if (Node.isTemplateExpression(node)) return { type: 'string' };
  if (Node.isNumericLiteral(node)) return { type: 'number' };
  if (Node.isTrueLiteral(node) || Node.isFalseLiteral(node)) return { type: 'boolean' };
  if (node.getKind() === SyntaxKind.NullKeyword) return { type: 'null' };

  if (Node.isArrayLiteralExpression(node)) {
    const elements = node.getElements();
    if (elements.length === 0) return { type: 'array' };
    const first = schemaForValueExpression(elements[0], ctx, depth + 1, visited);
    const uniform = elements.every(
      (el) =>
        JSON.stringify(schemaForValueExpression(el, ctx, depth + 1, visited)) ===
        JSON.stringify(first)
    );
    if (!uniform || !isInformativeSchema(first)) return { type: 'array' };
    return { type: 'array', items: first };
  }

  if (Node.isObjectLiteralExpression(node)) {
    const properties: Record<string, JsonSchema2020> = {};
    let open = false;
    for (const prop of node.getProperties()) {
      if (Node.isPropertyAssignment(prop)) {
        const nameNode = prop.getNameNode();
        let key: string | null = null;
        if (Node.isIdentifier(nameNode)) key = nameNode.getText();
        else if (Node.isStringLiteral(nameNode)) key = nameNode.getLiteralValue();
        else if (Node.isNumericLiteral(nameNode)) key = nameNode.getLiteralText();
        if (key === null) {
          open = true; // computed key: shape is wider than what we can name
          continue;
        }
        const init = prop.getInitializer();
        properties[key] = init ? schemaForValueExpression(init, ctx, depth + 1, visited) : {};
        continue;
      }
      if (Node.isShorthandPropertyAssignment(prop)) {
        properties[prop.getName()] = resolveIdentifierSchema(
          prop.getNameNode(),
          ctx,
          depth + 1,
          visited
        );
        continue;
      }
      open = true; // spread element, method, accessor
    }
    if (Object.keys(properties).length === 0) return open ? { type: 'object' } : {};
    return { type: 'object', properties, ...(open ? { additionalProperties: true } : {}) };
  }

  if (Node.isIdentifier(node)) {
    return resolveIdentifierSchema(node, ctx, depth, visited);
  }

  return {};
}

/**
 * Follow an identifier to the first same-file `const`/`let` of that name and use
 * its type annotation, else its literal initializer. `visited` stops
 * `const a = a`-style self references from spinning.
 */
function resolveIdentifierSchema(
  node: Node,
  ctx: TypeIndex,
  depth: number,
  visited: Set<string>
): JsonSchema2020 {
  const name = node.getText();
  if (visited.has(`value:${name}`)) return {};
  const decl = node
    .getSourceFile()
    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .find((d) => d.getName() === name);
  if (!decl) return {};
  const nextVisited = new Set([...visited, `value:${name}`]);
  const typeText = decl.getTypeNode()?.getText();
  if (typeText) {
    const typed = schemaForTypeText(typeText, ctx, depth, nextVisited);
    if (isInformativeSchema(typed)) return typed;
  }
  const init = decl.getInitializer();
  if (!init) return {};
  return schemaForValueExpression(init, ctx, depth + 1, nextVisited);
}
