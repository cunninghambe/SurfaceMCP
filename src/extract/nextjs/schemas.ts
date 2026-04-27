import { Project, Node, SyntaxKind, type SourceFile, type IfStatement } from 'ts-morph';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { type ZodSchema } from 'zod';
import type { JsonSchema2020, InputSchemaConfidence } from '../../types.js';

type SchemaResult = {
  schema: JsonSchema2020;
  confidence: InputSchemaConfidence;
};

const UNKNOWN_SCHEMA: JsonSchema2020 = { type: 'object', additionalProperties: true };

/**
 * Given a source file AST, find a zod schema being parsed (e.g., `schema.parse(req.body)`)
 * and convert it to Draft 2020-12 JSON Schema.
 */
export function extractZodSchema(
  sf: SourceFile,
  zodAlias = 'z'
): SchemaResult {
  // Look for <ident>.parse( or <ident>.safeParse( calls
  const callExprs = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of callExprs) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) continue;
    const methodName = expr.getName();
    if (methodName !== 'parse' && methodName !== 'safeParse') continue;

    const obj = expr.getExpression();
    // Try to resolve the schema variable
    const schema = tryResolveZodSchema(obj, sf, zodAlias);
    if (schema) return { schema, confidence: 'introspected' };
  }

  return { schema: UNKNOWN_SCHEMA, confidence: 'unknown' };
}

function tryResolveZodSchema(
  node: Node,
  sf: SourceFile,
  zodAlias: string
): JsonSchema2020 | null {
  // Direct z.object({...}) call
  if (isZodCall(node, zodAlias)) {
    return zodNodeToJsonSchema(node);
  }

  // Variable reference — look up declaration
  if (Node.isIdentifier(node)) {
    const name = node.getText();
    const decl = sf
      .getVariableDeclarations()
      .find((v) => v.getName() === name);
    if (!decl) return null;
    const init = decl.getInitializer();
    if (!init) return null;
    if (isZodCall(init, zodAlias)) return zodNodeToJsonSchema(init);
  }

  return null;
}

function isZodCall(node: Node, zodAlias: string): boolean {
  const text = node.getText();
  return text.startsWith(`${zodAlias}.`) || text.startsWith('zod.');
}

function zodNodeToJsonSchema(node: Node): JsonSchema2020 | null {
  // We use a best-effort approach: eval-safe eval of the zod expression is not
  // possible here, so we return a heuristic schema from text analysis.
  // For full fidelity we'd need to import and execute the module.
  // This yields a reasonable partial schema.
  const text = node.getText();

  // Parse zod.object({...}) by text
  if (text.includes('.object(')) {
    return parseZodObjectText(text);
  }
  return null;
}

/**
 * Very lightweight text-based zod object parser for common patterns.
 * Only used as a fallback when we can't exec the module.
 */
function parseZodObjectText(text: string): JsonSchema2020 {
  const schema: JsonSchema2020 = { type: 'object', properties: {}, required: [] };

  // Extract field names from z.object({ field: z.string(), ... }) pattern
  // Match `fieldName: z.<type>(<args>)` lines
  const fieldPattern = /(\w+)\s*:\s*z\.(\w+)\s*\(([^)]*)\)([^,}]*)/g;
  let match: RegExpExecArray | null;

  while ((match = fieldPattern.exec(text)) !== null) {
    const [, fieldName, zodType, , chainText] = match;
    // Pass only the chain portion (e.g. `.min(8).max(64).optional()`) to avoid
    // cross-field regex pollution from the full text.
    const fieldSchema = zodTypeToJsonSchema(zodType, chainText ?? '');
    if (!schema.properties) schema.properties = {};
    schema.properties[fieldName] = fieldSchema;

    // Fields are required by default in zod unless .optional() is chained
    const fullChain = match[0];
    if (!fullChain.includes('.optional()') && !fullChain.includes('.nullable()')) {
      if (!schema.required) schema.required = [];
      schema.required.push(fieldName);
    }
  }

  return schema;
}

function zodTypeToJsonSchema(zodType: string, chain: string): JsonSchema2020 {
  const s: JsonSchema2020 = {};

  switch (zodType) {
    case 'string':
      s.type = 'string';
      applyStringConstraints(s, chain);
      break;
    case 'number':
    case 'int':
      s.type = 'number';
      applyNumberConstraints(s, chain);
      break;
    case 'boolean':
      s.type = 'boolean';
      break;
    case 'array':
      s.type = 'array';
      break;
    case 'object':
      s.type = 'object';
      s.additionalProperties = true;
      break;
    case 'enum':
      break;
    default:
      s.type = 'string';
  }

  return s;
}

function applyStringConstraints(s: JsonSchema2020, chain: string): void {
  const emailMatch = chain.includes('.email()');
  const urlMatch = chain.includes('.url()');
  const uuidMatch = chain.includes('.uuid()');
  const dateMatch = chain.includes('.datetime()') || chain.includes('.date()');

  if (emailMatch) s.format = 'email';
  else if (urlMatch) s.format = 'uri';
  else if (uuidMatch) s.format = 'uuid';
  else if (dateMatch) s.format = 'date-time';

  const minMatch = /\.min\((\d+)\)/.exec(chain);
  const maxMatch = /\.max\((\d+)\)/.exec(chain);
  if (minMatch) s.minLength = parseInt(minMatch[1], 10);
  if (maxMatch) s.maxLength = parseInt(maxMatch[1], 10);
}

function applyNumberConstraints(s: JsonSchema2020, chain: string): void {
  const minMatch = /\.min\((\d+(?:\.\d+)?)\)/.exec(chain);
  const maxMatch = /\.max\((\d+(?:\.\d+)?)\)/.exec(chain);
  const multipleMatch = /\.multipleOf\((\d+(?:\.\d+)?)\)/.exec(chain);
  if (minMatch) s.minimum = parseFloat(minMatch[1]);
  if (maxMatch) s.maximum = parseFloat(maxMatch[1]);
  if (multipleMatch) s.multipleOf = parseFloat(multipleMatch[1]);
}

/**
 * Use zod-to-json-schema for a real zod schema object (when we can import + execute).
 * This is the authoritative path; the text parser above is fallback.
 */
export function zodSchemaToJsonSchema(
  zodSchema: ZodSchema<unknown>
): JsonSchema2020 {
  const result = zodToJsonSchema(zodSchema, {
    target: 'jsonSchema2019-09',
    $refStrategy: 'none',
  });
  return result as JsonSchema2020;
}

/**
 * Find the body variable name(s) used in a handler by looking for
 * `const body = await req.json()` (or similar) patterns.
 */
function findBodyVarNames(fn: Node): Set<string> {
  const names = new Set<string>();
  // Primary: const <name> = await req.json()
  for (const varDecl of fn.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = varDecl.getInitializer();
    if (!init) continue;
    const text = init.getText().trim();
    if (/req\.json\(\)|request\.json\(\)|body/.test(text)) {
      names.add(varDecl.getName());
    }
  }
  // Fallback: common name
  if (names.size === 0) names.add('body');
  return names;
}

/**
 * Collect variable names that were destructured from the body variable.
 * `const { a, b } = body;` → binds 'a' and 'b' as body fields.
 */
function findDestructuredBodyFields(fn: Node, bodyVarNames: Set<string>): Map<string, string> {
  // Maps local var name → body field name (same when no aliasing)
  const fieldBindings = new Map<string, string>();
  for (const varDecl of fn.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = varDecl.getInitializer();
    if (!init || !Node.isIdentifier(init)) continue;
    if (!bodyVarNames.has(init.getText())) continue;
    // LHS must be an object binding pattern: const { a, b } = body
    const nameNode = varDecl.getNameNode();
    if (!Node.isObjectBindingPattern(nameNode)) continue;
    for (const el of nameNode.getElements()) {
      const propName = el.getPropertyNameNode()?.getText() ?? el.getNameNode().getText();
      const localName = el.getNameNode().getText();
      fieldBindings.set(localName, propName);
    }
  }
  return fieldBindings;
}

/** True when this statement is a throw or an early-return with an error status. */
function isEarlyExit(stmt: Node): boolean {
  if (Node.isThrowStatement(stmt)) return true;
  if (Node.isReturnStatement(stmt)) {
    const text = stmt.getText();
    // NextResponse.json({…}, { status: 4XX }) pattern
    return /status\s*:\s*[45]\d\d/.test(text);
  }
  return false;
}

/** Return true if any immediate child statement (or the block itself) is an early exit. */
function thenIsEarlyExit(ifStmt: IfStatement): boolean {
  const thenStmt = ifStmt.getThenStatement();
  if (isEarlyExit(thenStmt)) return true;
  if (Node.isBlock(thenStmt)) {
    const stmts = thenStmt.getStatements();
    return stmts.some((s) => isEarlyExit(s));
  }
  return false;
}

/**
 * Extract field name and type from a body-access expression like `body.prop`.
 * Returns null if the expression is not a simple body member access.
 */
function extractBodyPropAccess(
  expr: Node,
  bodyVarNames: Set<string>
): { field: string; type: 'string' } | null {
  if (!Node.isPropertyAccessExpression(expr)) return null;
  const obj = expr.getExpression();
  if (!Node.isIdentifier(obj)) return null;
  if (!bodyVarNames.has(obj.getText())) return null;
  return { field: expr.getName(), type: 'string' };
}

/**
 * Walk IfStatements in the handler body and collect validated fields.
 * Returns a map of field → JsonSchema type.
 */
function collectValidatedFields(
  fn: Node,
  bodyVarNames: Set<string>,
  destructuredFields: Map<string, string>
): Map<string, JsonSchema2020> {
  const fields = new Map<string, JsonSchema2020>();

  for (const ifStmt of fn.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    if (!thenIsEarlyExit(ifStmt)) continue;

    const condition = ifStmt.getExpression();

    // Pattern 1 & 3: !body.prop (possibly combined with length check via ||)
    // Unwrap PrefixUnary `!expr`
    if (Node.isPrefixUnaryExpression(condition)) {
      const operand = condition.getOperand();
      const hit = extractBodyPropAccess(operand, bodyVarNames);
      if (hit) {
        fields.set(hit.field, { type: 'string' });
        continue;
      }
      // Could also be a simple identifier from destructuring: !name
      if (Node.isIdentifier(operand)) {
        const localName = operand.getText();
        const bodyField = destructuredFields.get(localName);
        if (bodyField) {
          fields.set(bodyField, { type: 'string' });
          continue;
        }
      }
    }

    // Pattern 3: `!body.prop || body.prop.length === 0` — left side is the guard
    if (Node.isBinaryExpression(condition)) {
      const opKind = condition.getOperatorToken().getKind();
      // ||  operator = BarBarToken
      if (opKind === SyntaxKind.BarBarToken) {
        const left = condition.getLeft();
        if (Node.isPrefixUnaryExpression(left)) {
          const hit = extractBodyPropAccess(left.getOperand(), bodyVarNames);
          if (hit) {
            fields.set(hit.field, { type: 'string' });
            continue;
          }
          if (Node.isIdentifier(left.getOperand())) {
            const bodyField = destructuredFields.get(left.getOperand().getText());
            if (bodyField) {
              fields.set(bodyField, { type: 'string' });
              continue;
            }
          }
        }
      }

      // Pattern 2: typeof body.prop !== 'string'/'number'/'boolean'
      if (
        opKind === SyntaxKind.ExclamationEqualsEqualsToken ||
        opKind === SyntaxKind.ExclamationEqualsToken
      ) {
        const left = condition.getLeft();
        const right = condition.getRight();
        if (
          Node.isTypeOfExpression(left) &&
          Node.isStringLiteral(right)
        ) {
          const typeofOperand = left.getExpression();
          const typeStr = right.getLiteralText();
          const jsType = typeStr === 'number' ? 'number' : typeStr === 'boolean' ? 'boolean' : 'string';
          const hit = extractBodyPropAccess(typeofOperand, bodyVarNames);
          if (hit) {
            fields.set(hit.field, { type: jsType });
            continue;
          }
        }
      }
    }
  }

  return fields;
}

/**
 * Analyse a route source file for manual validation patterns (if (!body.x) throw …).
 * Returns a partial schema when guards are found, or unknown if none are found
 * or if Zod .parse() is already present (defer to extractZodSchema).
 *
 * Known limitation: validation inside helper functions is not followed.
 */
export function extractManualValidationSchema(
  sf: SourceFile,
  methodName: string
): SchemaResult {
  // Defer to extractZodSchema if .parse() or .safeParse() is called anywhere in the file
  const callExprs = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of callExprs) {
    const expr = call.getExpression();
    if (Node.isPropertyAccessExpression(expr)) {
      const method = expr.getName();
      if (method === 'parse' || method === 'safeParse') {
        return { schema: UNKNOWN_SCHEMA, confidence: 'unknown' };
      }
    }
  }

  // Find exported handler: `export async function POST(` or `export function POST(`
  const handlerFn =
    sf.getFunctions().find((fn) => {
      if (!fn.isExported()) return false;
      return fn.getName() === methodName;
    }) ??
    sf.getVariableDeclarations().find((vd) => {
      if (vd.getName() !== methodName) return false;
      const stmt = vd.getVariableStatement();
      return stmt?.isExported() ?? false;
    });

  if (!handlerFn) return { schema: UNKNOWN_SCHEMA, confidence: 'unknown' };

  const bodyVarNames = findBodyVarNames(handlerFn);
  const destructuredFields = findDestructuredBodyFields(handlerFn, bodyVarNames);
  const validatedFields = collectValidatedFields(handlerFn, bodyVarNames, destructuredFields);

  if (validatedFields.size === 0) return { schema: UNKNOWN_SCHEMA, confidence: 'unknown' };

  const properties: Record<string, JsonSchema2020> = {};
  for (const [field, fieldSchema] of validatedFields) {
    properties[field] = fieldSchema;
  }
  const required = [...validatedFields.keys()].sort();

  return {
    schema: { type: 'object', properties, required },
    confidence: 'partial',
  };
}

/**
 * Load a route file from disk and run extractManualValidationSchema across all
 * detected HTTP method handlers. Returns the union of found fields.
 */
export async function extractManualValidationSchemaFromFile(
  filePath: string
): Promise<SchemaResult> {
  const HTTP_METHODS_LIST = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  try {
    const project = new Project({ useInMemoryFileSystem: false });
    const sf = project.addSourceFileAtPath(filePath);

    const allFields = new Map<string, JsonSchema2020>();
    for (const method of HTTP_METHODS_LIST) {
      const result = extractManualValidationSchema(sf, method);
      if (result.confidence === 'partial' && result.schema.properties) {
        for (const [field, schema] of Object.entries(result.schema.properties)) {
          allFields.set(field, schema);
        }
      }
    }

    if (allFields.size === 0) return { schema: UNKNOWN_SCHEMA, confidence: 'unknown' };

    const properties: Record<string, JsonSchema2020> = {};
    for (const [field, schema] of allFields) {
      properties[field] = schema;
    }
    const required = [...allFields.keys()].sort();
    return { schema: { type: 'object', properties, required }, confidence: 'partial' };
  } catch {
    return { schema: UNKNOWN_SCHEMA, confidence: 'unknown' };
  }
}

/**
 * Like extractZodSchema but constrained to descendants of `scopeNode`.
 * Optionally filters to a specific schema variable name (for pattern C).
 */
export function extractZodSchemaForNode(
  scopeNode: Node,
  sf: SourceFile,
  zodAlias = 'z',
  varName?: string
): SchemaResult {
  const callExprs = scopeNode.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of callExprs) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) continue;
    const methodName = expr.getName();
    if (methodName !== 'parse' && methodName !== 'safeParse') continue;
    const obj = expr.getExpression();
    if (varName && Node.isIdentifier(obj) && obj.getText() !== varName) continue;
    const schema = tryResolveZodSchemaInScope(obj, scopeNode, sf, zodAlias);
    if (schema) return { schema, confidence: 'introspected' };
  }
  return { schema: UNKNOWN_SCHEMA, confidence: 'unknown' };
}

/**
 * Resolve a schema identifier node against file-level declarations or direct z.* calls.
 * Handles identifiers, property-access expressions, and inline z.object({...}) nodes.
 */
export function tryResolveSchemaIdentifier(node: Node, sf: SourceFile, zodAlias = 'z'): SchemaResult {
  const schema = tryResolveZodSchema(node, sf, zodAlias);
  if (schema) return { schema, confidence: 'introspected' };
  return { schema: UNKNOWN_SCHEMA, confidence: 'unknown' };
}

/**
 * Resolve a zod schema reference constrained to a scope node first,
 * then falling back to file-level declarations.
 */
function tryResolveZodSchemaInScope(
  node: Node,
  scopeNode: Node,
  sf: SourceFile,
  zodAlias: string
): JsonSchema2020 | null {
  if (isZodCall(node, zodAlias)) return zodNodeToJsonSchema(node);

  if (Node.isIdentifier(node)) {
    const name = node.getText();
    // Local variable declaration inside the scope (pattern C)
    for (const varDecl of scopeNode.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      if (varDecl.getName() !== name) continue;
      const init = varDecl.getInitializer();
      if (!init) continue;
      if (isZodCall(init, zodAlias)) return zodNodeToJsonSchema(init);
    }
    // Fall through to file-level
    return tryResolveZodSchema(node, sf, zodAlias);
  }

  return null;
}

/**
 * Try to dynamically import a route file and extract its exported zod schema.
 */
export async function tryImportZodSchema(
  filePath: string,
  zodAlias = 'z'
): Promise<SchemaResult> {
  try {
    // Import the module at runtime and look for common schema export names
    const mod = await import(filePath) as Record<string, unknown>;

    const schemaNames = ['schema', 'bodySchema', 'inputSchema', 'requestSchema', 'Schema'];
    for (const name of schemaNames) {
      const candidate = mod[name];
      if (candidate && typeof candidate === 'object' && '_def' in candidate && 'parse' in candidate) {
        const jsonSchema = zodSchemaToJsonSchema(candidate as ZodSchema<unknown>);
        return { schema: jsonSchema, confidence: 'introspected' };
      }
    }
  } catch {
    // Dynamic import failed — fall back to AST parsing
  }

  try {
    const project = new Project({ useInMemoryFileSystem: false });
    const sf = project.addSourceFileAtPath(filePath);
    return extractZodSchema(sf, zodAlias);
  } catch {
    return { schema: UNKNOWN_SCHEMA, confidence: 'unknown' };
  }
}
