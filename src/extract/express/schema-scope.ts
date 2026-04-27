import { Node, SyntaxKind, type CallExpression, type SourceFile } from 'ts-morph';
import { dirname, resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';
import type { JsonSchema2020, InputSchemaConfidence } from '../../types.js';
import {
  zodSchemaToJsonSchema,
  extractZodSchemaForNode,
  tryResolveSchemaIdentifier,
} from '../nextjs/schemas.js';
import type { ZodSchema } from 'zod';

export const DEFAULT_BODY_VALIDATOR_NAMES = [
  'validateBody',
  'validate',
  'zValidate',
  'zodValidate',
  'validateRequest',
] as const;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UNKNOWN_SCHEMA: JsonSchema2020 = { type: 'object', additionalProperties: true };
const UNKNOWN_RESULT = { schema: UNKNOWN_SCHEMA, confidence: 'unknown' as InputSchemaConfidence };

type SchemaResult = { schema: JsonSchema2020; confidence: InputSchemaConfidence };

export async function resolveRouteSchema(
  routeCall: CallExpression,
  sf: SourceFile,
  method: string,
  config?: { bodyValidatorNames?: string[] }
): Promise<SchemaResult> {
  if (SAFE_METHODS.has(method.toUpperCase())) return UNKNOWN_RESULT;

  const validatorNames = new Set<string>([
    ...DEFAULT_BODY_VALIDATOR_NAMES,
    ...(config?.bodyValidatorNames ?? []),
  ]);

  const args = routeCall.getArguments();
  if (args.length < 2) return UNKNOWN_RESULT;

  // Pattern A: validateBody(<schemaRef>) middleware in args[1..end-1]
  for (let i = 1; i < args.length - 1; i++) {
    const arg = args[i];
    if (!Node.isCallExpression(arg)) continue;
    const callee = arg.getExpression();
    const calleeName = Node.isIdentifier(callee)
      ? callee.getText()
      : Node.isPropertyAccessExpression(callee)
      ? callee.getName()
      : null;
    if (!calleeName || !validatorNames.has(calleeName)) continue;
    const schemaArg = arg.getArguments()[0];
    if (!schemaArg) continue;
    return resolveSchemaRef(schemaArg, sf, undefined);
  }

  // Pattern B/C: parse/safeParse inside the handler body (last arg)
  const handler = args[args.length - 1];
  if (!handler) return UNKNOWN_RESULT;
  if (!Node.isArrowFunction(handler) && !Node.isFunctionExpression(handler)) return UNKNOWN_RESULT;

  for (const call of handler.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) continue;
    const methodName = expr.getName();
    if (methodName !== 'parse' && methodName !== 'safeParse') continue;
    const lhs = expr.getExpression();
    const result = await resolveSchemaRef(lhs, sf, handler);
    if (result.confidence !== 'unknown') return result;
  }

  return UNKNOWN_RESULT;
}

async function resolveSchemaRef(
  node: Node,
  sf: SourceFile,
  scopeNode: Node | undefined
): Promise<SchemaResult> {
  // Unwrap chained calls: `schema.partial()` → resolve `schema`
  const baseNode = unwrapCallChain(node);

  // Step 1: local declaration inside scopeNode (pattern C)
  if (scopeNode && Node.isIdentifier(baseNode)) {
    const localResult = extractZodSchemaForNode(scopeNode, sf, 'z', baseNode.getText());
    if (localResult.confidence !== 'unknown') return localResult;
  }

  // Step 2: file-level identifier or direct z.* call
  const fileResult = tryResolveSchemaIdentifier(baseNode, sf);
  if (fileResult.confidence !== 'unknown') return fileResult;

  // Step 3: member access on imported namespace (e.g. schemas.userRegistration)
  if (Node.isPropertyAccessExpression(baseNode)) {
    const memberResult = await tryResolveMemberAccess(baseNode, sf);
    if (memberResult.confidence !== 'unknown') return memberResult;
    // Pattern A/B found but schema reference unresolvable → inferred
    return { schema: UNKNOWN_SCHEMA, confidence: 'inferred' };
  }

  // Identifier found but unresolvable → inferred
  if (Node.isIdentifier(baseNode)) {
    return { schema: UNKNOWN_SCHEMA, confidence: 'inferred' };
  }

  return UNKNOWN_RESULT;
}

/** Walk call-chain wrappers (e.g. `schema.partial()`) to find the base schema reference. */
function unwrapCallChain(node: Node): Node {
  if (!Node.isCallExpression(node)) return node;
  const expr = node.getExpression();
  if (Node.isPropertyAccessExpression(expr)) {
    return unwrapCallChain(expr.getExpression());
  }
  return node;
}

async function tryResolveMemberAccess(
  node: Node,
  sf: SourceFile
): Promise<SchemaResult> {
  if (!Node.isPropertyAccessExpression(node)) return UNKNOWN_RESULT;
  const objExpr = node.getExpression();
  if (!Node.isIdentifier(objExpr)) return UNKNOWN_RESULT;

  const nsName = objExpr.getText();
  const propName = node.getName();
  const importPath = findImportPath(sf, nsName);
  if (!importPath) return UNKNOWN_RESULT;

  const dir = dirname(sf.getFilePath());
  const resolved = resolveImportPath(dir, importPath);
  if (!resolved) return UNKNOWN_RESULT;

  try {
    const mod = await import(resolved) as Record<string, unknown>;
    const candidate = findMemberInModule(mod, nsName, propName);
    if (candidate && typeof candidate === 'object' && '_def' in candidate && 'parse' in candidate) {
      return { schema: zodSchemaToJsonSchema(candidate as ZodSchema<unknown>), confidence: 'introspected' };
    }
  } catch {
    // dynamic import failed — not resolvable
  }

  return UNKNOWN_RESULT;
}

function findImportPath(sf: SourceFile, bindingName: string): string | null {
  for (const decl of sf.getImportDeclarations()) {
    const ns = decl.getNamespaceImport();
    if (ns?.getText() === bindingName) return decl.getModuleSpecifierValue();
    const named = decl.getNamedImports().find((n) => n.getAliasNode()?.getText() === bindingName || n.getName() === bindingName);
    if (named) return decl.getModuleSpecifierValue();
    const def = decl.getDefaultImport();
    if (def?.getText() === bindingName) return decl.getModuleSpecifierValue();
  }
  return null;
}

function resolveImportPath(dir: string, importPath: string): string | null {
  const extensions = ['.ts', '.js', ''];
  for (const ext of extensions) {
    const candidate = resolvePath(dir, importPath + ext);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findMemberInModule(
  mod: Record<string, unknown>,
  nsName: string,
  propName: string
): unknown {
  // Direct export: `export const userRegistration = z.object(...)`
  const direct = mod[propName];
  if (direct) return direct;
  // Namespace export: `export const schemas = { userRegistration: z.object(...) }`
  const ns = mod[nsName];
  if (ns && typeof ns === 'object') return (ns as Record<string, unknown>)[propName];
  // Default export as namespace: `export default { userRegistration: z.object(...) }`
  const def = mod['default'];
  if (def && typeof def === 'object') return (def as Record<string, unknown>)[propName];
  return undefined;
}
