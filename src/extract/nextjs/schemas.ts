import { Project, Node, SyntaxKind, type SourceFile } from 'ts-morph';
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
