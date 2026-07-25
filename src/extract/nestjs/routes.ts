import { readdirSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import {
  Project,
  Node,
  type Decorator,
  type MethodDeclaration,
  type ParameterDeclaration,
} from 'ts-morph';
import type {
  RawToolMeta,
  JsonSchema2020,
  InputSchemaConfidence,
  OutputSchemaConfidence,
} from '../../types.js';
import { toolId, pathToToolName, methodToSideEffect } from '../common.js';
import {
  buildTypeIndex,
  declarationToSchema,
  isInformativeSchema,
  schemaForTypeText,
  unwrapAsyncType,
  type TypeIndex,
} from '../ts-type-schema.js';

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
  outputSchema?: JsonSchema2020;
  outputSchemaConfidence?: OutputSchemaConfidence;
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
 *
 * The type walk itself (nested DTOs, enums, arrays, class-validator refinements,
 * depth + cycle guards) lives in ../ts-type-schema.ts and is shared with the
 * response-typing paths.
 */
function resolveSchema(
  method: MethodDeclaration,
  wantDecorator: 'Body' | 'Query',
  ctx: TypeIndex
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
  const dto = typeName ? ctx.classes.get(typeName) : undefined;
  if (!dto) {
    return { inputSchema: UNKNOWN_SCHEMA, inputSchemaConfidence: 'unknown' };
  }

  const schema = declarationToSchema(dto, ctx, 0, new Set([dto.getName() ?? typeName!]));
  if (!schema) {
    return { inputSchema: UNKNOWN_SCHEMA, inputSchemaConfidence: 'unknown' };
  }
  return { inputSchema: schema, inputSchemaConfidence: 'introspected' };
}

// ─── Response typing ──────────────────────────────────────────────────────────

/** Swagger response decorators whose `type` option names the response DTO. */
const SWAGGER_RESPONSE_DECORATORS = new Set([
  'ApiResponse',
  'ApiOkResponse',
  'ApiCreatedResponse',
  'ApiAcceptedResponse',
  'ApiDefaultResponse',
]);

type OutputResult = {
  outputSchema?: JsonSchema2020;
  outputSchemaConfidence?: OutputSchemaConfidence;
};

/** Named property of a decorator's options object literal, as a raw node. */
function decoratorOption(dec: Decorator, name: string): Node | undefined {
  for (const arg of dec.getArguments()) {
    if (!Node.isObjectLiteralExpression(arg)) continue;
    const prop = arg.getProperty(name);
    if (prop && Node.isPropertyAssignment(prop)) return prop.getInitializer();
  }
  return undefined;
}

function optionIsTrue(dec: Decorator, name: string): boolean {
  return decoratorOption(dec, name)?.getText() === 'true';
}

/**
 * `@ApiResponse({ status, type, isArray })` and its status-specific aliases.
 * A `status` outside 2xx is ignored (an error-response declaration is not the
 * success shape). `type: [X]` and `isArray: true` both wrap the schema in an
 * array. Resolved through the shared type index, so `type: ItemDto` expands the
 * DTO exactly as an input DTO would.
 */
function swaggerResponseSchema(method: MethodDeclaration, ctx: TypeIndex): JsonSchema2020 | undefined {
  for (const dec of method.getDecorators()) {
    if (!SWAGGER_RESPONSE_DECORATORS.has(dec.getName())) continue;

    const statusNode = decoratorOption(dec, 'status');
    if (statusNode) {
      const statusText = statusNode.getText().replace(/^HttpStatus\./, '');
      const numeric = Number(statusText);
      const is2xx = Number.isFinite(numeric)
        ? numeric >= 200 && numeric < 300
        : /^(OK|CREATED|ACCEPTED|NO_CONTENT|NON_AUTHORITATIVE_INFORMATION|RESET_CONTENT|PARTIAL_CONTENT)$/.test(
            statusText
          );
      if (!is2xx) continue;
    }

    const typeNode = decoratorOption(dec, 'type');
    if (!typeNode) continue;

    // `type: [ItemDto]` — Swagger's array shorthand.
    let typeText = typeNode.getText();
    let isArray = optionIsTrue(dec, 'isArray');
    if (Node.isArrayLiteralExpression(typeNode)) {
      const first = typeNode.getElements()[0];
      if (!first) continue;
      typeText = first.getText();
      isArray = true;
    }

    const schema = schemaForTypeText(typeText, ctx);
    if (!isInformativeSchema(schema)) continue;
    return isArray ? { type: 'array', items: schema } : schema;
  }
  return undefined;
}

/**
 * Response schema for a handler method. A Swagger `@Api*Response({ type })`
 * decorator is a declared contract -> 'introspected'; otherwise the declared TS
 * return type (`ItemDto`, `ItemDto[]`, `Promise<ItemDto[]>`) is derived ->
 * 'inferred'. Handlers with no return annotation and no decorator emit nothing.
 */
function resolveOutputSchema(method: MethodDeclaration, ctx: TypeIndex): OutputResult {
  const declared = swaggerResponseSchema(method, ctx);
  if (declared) return { outputSchema: declared, outputSchemaConfidence: 'introspected' };

  const returnText = unwrapAsyncType(method.getReturnTypeNode()?.getText());
  if (!returnText) return {};
  const schema = schemaForTypeText(returnText, ctx);
  if (!isInformativeSchema(schema)) return {};
  return { outputSchema: schema, outputSchemaConfidence: 'inferred' };
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
  // DTO-typed property, an enum-typed property, or a handler's return type can
  // be resolved to its declaration regardless of which file it lives in.
  // `includeShapes` is deliberately off: Nest DTOs are classes, and leaving the
  // interface / type-alias maps empty keeps resolution identical to before the
  // walk was shared.
  const ctx = buildTypeIndex(project);

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
          const output = resolveOutputSchema(methodNode, ctx);

          for (const method of httpMethods) {
            const key = methodToSideEffect(method) === 'safe' ? 'Query' : 'Body';
            const { inputSchema, inputSchemaConfidence } = resolveSchema(methodNode, key, ctx);
            records.push({
              method,
              path,
              inputSchema,
              inputSchemaConfidence,
              ...output,
              sourceFile,
              sourceLine,
            });
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
      ...(route.outputSchema
        ? { outputSchema: route.outputSchema, outputSchemaConfidence: route.outputSchemaConfidence }
        : {}),
      sideEffectClass: methodToSideEffect(route.method),
      sourceFile: route.sourceFile,
      sourceLine: route.sourceLine,
      isServerAction: false,
    });
  }

  return tools;
}
