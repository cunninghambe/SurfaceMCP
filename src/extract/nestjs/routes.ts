import { readdirSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import {
  Project,
  SyntaxKind,
  Node,
  type ClassDeclaration,
  type Decorator,
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

/** Build the JSON Schema for one DTO property from its TS type + class-validator decorators. */
function propertySchema(prop: PropertyDeclaration): JsonSchema2020 {
  const schema: JsonSchema2020 = {};

  // Base type from the TS annotation, e.g. `name: string`.
  const tsType = tsTypeToJson(prop.getTypeNode()?.getText());
  if (tsType) schema.type = tsType;

  // class-validator decorators refine/override the type.
  for (const dec of prop.getDecorators()) {
    const refinement = validatorRefinement(dec.getName());
    if (refinement) Object.assign(schema, refinement);
  }

  return schema;
}

/** True when a property is optional (`name?: string` or `@IsOptional()`). */
function isOptionalProperty(prop: PropertyDeclaration): boolean {
  if (prop.hasQuestionToken()) return true;
  return prop.getDecorators().some((d) => d.getName() === 'IsOptional');
}

/**
 * Introspect a DTO class into a JSON Schema object. Covers a deliberate subset:
 * string/number/boolean/integer primitives, optionality, and a few
 * class-validator format hints. Returns null when the class has no usable
 * properties so the caller can fall back to the unknown schema.
 */
function dtoToSchema(cls: ClassDeclaration): JsonSchema2020 | null {
  const properties: Record<string, JsonSchema2020> = {};
  const required: string[] = [];

  for (const prop of cls.getProperties()) {
    if (prop.isStatic()) continue;
    const name = prop.getName();
    properties[name] = propertySchema(prop);
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
 * Falls back to an open object with 'unknown' confidence when the relevant
 * decorated param, its DTO type, or the DTO's properties can't be resolved.
 */
function resolveSchema(
  method: MethodDeclaration,
  wantDecorator: 'Body' | 'Query',
  dtoIndex: Map<string, ClassDeclaration>
): { inputSchema: JsonSchema2020; inputSchemaConfidence: InputSchemaConfidence } {
  const param = method.getParameters().find((p: ParameterDeclaration) =>
    p.getDecorators().some((d) => d.getName() === wantDecorator)
  );
  if (!param) {
    return { inputSchema: UNKNOWN_SCHEMA, inputSchemaConfidence: 'unknown' };
  }

  const typeName = bareTypeName(param.getTypeNode()?.getText());
  const dto = typeName ? dtoIndex.get(typeName) : undefined;
  if (!dto) {
    return { inputSchema: UNKNOWN_SCHEMA, inputSchemaConfidence: 'unknown' };
  }

  const schema = dtoToSchema(dto);
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

  // Index every class by name so `@Body() dto: SomeDto` can be resolved to its
  // declaration regardless of which file it lives in.
  const dtoIndex = new Map<string, ClassDeclaration>();
  for (const sf of project.getSourceFiles()) {
    for (const cls of sf.getClasses()) {
      const name = cls.getName();
      if (name && !dtoIndex.has(name)) dtoIndex.set(name, cls);
    }
  }

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
            const { inputSchema, inputSchemaConfidence } = resolveSchema(methodNode, key, dtoIndex);
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
