import { readdirSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { Project, SyntaxKind, Node, type ObjectLiteralExpression } from 'ts-morph';
import type { RawToolMeta, JsonSchema2020, InputSchemaConfidence } from '../../types.js';
import { toolId, pathToToolName, methodToSideEffect } from '../common.js';

// Shorthand HTTP verbs Fastify exposes on an instance (`fastify.get(...)` etc).
const SHORTHAND_METHOD_RE = /\.(get|post|put|patch|delete|head|options)\s*$/;
// The full-config form: `fastify.route({ method, url, schema, handler })`.
const ROUTE_METHOD_RE = /\.route\s*$/;
const UNKNOWN_SCHEMA: JsonSchema2020 = { type: 'object', additionalProperties: true };

/** Sentinel returned by astToJsonValue when a node can't be resolved to a JSON literal. */
const UNRESOLVABLE = Symbol('unresolvable');

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

/** Strip surrounding quotes/backticks from a literal's source text. */
function literalToPath(node: Node): string | null {
  if (
    !Node.isStringLiteral(node) &&
    !Node.isNoSubstitutionTemplateLiteral(node)
  ) {
    return null;
  }
  const value = node.getLiteralValue();
  return value.startsWith('/') ? value : null;
}

/** Find a property's initializer on an object literal (plain `key: value` assignments only). */
function getProp(obj: ObjectLiteralExpression, name: string): Node | undefined {
  const prop = obj.getProperty(name);
  if (prop && Node.isPropertyAssignment(prop)) return prop.getInitializer();
  return undefined;
}

/**
 * Convert an object-literal AST node to a plain JSON value. Handles the literal
 * subset a JSON Schema can contain (objects, arrays, strings, numbers, booleans,
 * null, and negative numbers). Returns UNRESOLVABLE for anything referencing an
 * identifier, spread, or call — i.e. schemas we can't inline with confidence.
 */
function astToJsonValue(node: Node): unknown {
  if (Node.isObjectLiteralExpression(node)) {
    const obj: Record<string, unknown> = {};
    for (const prop of node.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) return UNRESOLVABLE;
      const nameNode = prop.getNameNode();
      let key: string;
      if (Node.isStringLiteral(nameNode)) key = nameNode.getLiteralValue();
      else if (Node.isIdentifier(nameNode)) key = nameNode.getText();
      else if (Node.isNumericLiteral(nameNode)) key = nameNode.getLiteralText();
      else return UNRESOLVABLE;
      const init = prop.getInitializer();
      if (!init) return UNRESOLVABLE;
      const value = astToJsonValue(init);
      if (value === UNRESOLVABLE) return UNRESOLVABLE;
      obj[key] = value;
    }
    return obj;
  }
  if (Node.isArrayLiteralExpression(node)) {
    const arr: unknown[] = [];
    for (const el of node.getElements()) {
      const value = astToJsonValue(el);
      if (value === UNRESOLVABLE) return UNRESOLVABLE;
      arr.push(value);
    }
    return arr;
  }
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralValue();
  }
  if (Node.isNumericLiteral(node)) return Number(node.getLiteralValue());
  if (Node.isTrueLiteral(node)) return true;
  if (Node.isFalseLiteral(node)) return false;
  if (node.getKind() === SyntaxKind.NullKeyword) return null;
  // Negative numbers parse as a prefix-unary expression, e.g. `minimum: -1`.
  if (Node.isPrefixUnaryExpression(node) && node.getOperatorToken() === SyntaxKind.MinusToken) {
    const operand = node.getOperand();
    if (Node.isNumericLiteral(operand)) return -Number(operand.getLiteralValue());
  }
  return UNRESOLVABLE;
}

/**
 * Resolve the inputSchema for a route from its Fastify `schema` object. Mutating
 * methods introspect `schema.body`; safe methods (GET/HEAD/OPTIONS) introspect
 * `schema.querystring`. Falls back to an open object with 'unknown' confidence
 * when no inline JSON Schema is present or it can't be resolved to a literal.
 */
function resolveSchema(
  schemaObj: ObjectLiteralExpression | undefined,
  method: string
): { inputSchema: JsonSchema2020; inputSchemaConfidence: InputSchemaConfidence } {
  if (!schemaObj) {
    return { inputSchema: UNKNOWN_SCHEMA, inputSchemaConfidence: 'unknown' };
  }
  const key = methodToSideEffect(method) === 'safe' ? 'querystring' : 'body';
  const target = getProp(schemaObj, key);
  if (!target || !Node.isObjectLiteralExpression(target)) {
    return { inputSchema: UNKNOWN_SCHEMA, inputSchemaConfidence: 'unknown' };
  }
  const value = astToJsonValue(target);
  if (value !== UNRESOLVABLE && value !== null && typeof value === 'object') {
    return { inputSchema: value as JsonSchema2020, inputSchemaConfidence: 'introspected' };
  }
  return { inputSchema: UNKNOWN_SCHEMA, inputSchemaConfidence: 'unknown' };
}

/** The `schema` property of an options/route-config object, if it is an object literal. */
function schemaObjectFrom(config: ObjectLiteralExpression): ObjectLiteralExpression | undefined {
  const schema = getProp(config, 'schema');
  return schema && Node.isObjectLiteralExpression(schema) ? schema : undefined;
}

export function extractFastifyRoutes(root: string): RawToolMeta[] {
  const allFiles = walkDir(root);

  const project = new Project({
    useInMemoryFileSystem: false,
    skipFileDependencyResolution: true,
  });
  for (const file of allFiles) {
    project.addSourceFileAtPath(file);
  }

  const records: RouteRecord[] = [];

  for (const sf of project.getSourceFiles()) {
    const sourceFile = relative(root, sf.getFilePath());
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const exprText = call.getExpression().getText();
      const args = call.getArguments();

      // ── Shorthand: fastify.get('/path', [opts], handler) ─────────────────────
      const shorthand = SHORTHAND_METHOD_RE.exec(exprText);
      if (shorthand) {
        if (args.length === 0) continue;
        const path = literalToPath(args[0]);
        if (path === null) continue;
        const method = shorthand[1].toUpperCase();
        // Options object is the first object-literal after the path (if any).
        const optionsObj = args
          .slice(1)
          .find((a): a is ObjectLiteralExpression => Node.isObjectLiteralExpression(a));
        const { inputSchema, inputSchemaConfidence } = resolveSchema(
          optionsObj ? schemaObjectFrom(optionsObj) : undefined,
          method
        );
        records.push({
          method,
          path,
          inputSchema,
          inputSchemaConfidence,
          sourceFile,
          sourceLine: call.getStartLineNumber(),
        });
        continue;
      }

      // ── Full config: fastify.route({ method, url, schema, handler }) ──────────
      if (ROUTE_METHOD_RE.test(exprText)) {
        const config = args[0];
        if (!config || !Node.isObjectLiteralExpression(config)) continue;
        const urlNode = getProp(config, 'url');
        const path = urlNode ? literalToPath(urlNode) : null;
        if (path === null) continue;

        // `method` may be a single string or an array of strings.
        const methodNode = getProp(config, 'method');
        const methods: string[] = [];
        if (methodNode && (Node.isStringLiteral(methodNode) || Node.isNoSubstitutionTemplateLiteral(methodNode))) {
          methods.push(methodNode.getLiteralValue().toUpperCase());
        } else if (methodNode && Node.isArrayLiteralExpression(methodNode)) {
          for (const el of methodNode.getElements()) {
            if (Node.isStringLiteral(el) || Node.isNoSubstitutionTemplateLiteral(el)) {
              methods.push(el.getLiteralValue().toUpperCase());
            }
          }
        }
        if (methods.length === 0) continue;

        const schemaObj = schemaObjectFrom(config);
        const sourceLine = call.getStartLineNumber();
        for (const method of methods) {
          const { inputSchema, inputSchemaConfidence } = resolveSchema(schemaObj, method);
          records.push({ method, path, inputSchema, inputSchemaConfidence, sourceFile, sourceLine });
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
