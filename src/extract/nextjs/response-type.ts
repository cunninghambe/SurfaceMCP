// Best-effort response typing for Next.js API routes.
//
// App Router (`app/api/**/route.ts`) exports one function per HTTP verb, so each
// verb gets its own schema. Two signals, in order:
//   1. a declared return type — `Promise<NextResponse<ItemsBody>>`;
//   2. the `NextResponse.json(<literal>)` / `Response.json(<literal>)` calls in
//      the handler body, used only when they all agree (a route that returns a
//      different object per branch is left untyped rather than guessed at).
//
// Pages Router (`pages/api/**`) has a single default-exported handler serving
// every verb, so its schema — from the `NextApiResponse<T>` generic, else from
// its `res.json(...)` calls — applies to all detected methods alike.
//
// Everything here is 'inferred': Next.js enforces none of it at runtime.
//
// Deliberately a separate module from `./schemas.ts` (input-schema recovery) so
// the two concerns stay independently reviewable.

import { Node, SyntaxKind, type SourceFile } from 'ts-morph';
import type { JsonSchema2020, OutputSchemaConfidence } from '../../types.js';
import {
  genericArgument,
  isInformativeSchema,
  schemaForTypeText,
  schemaForValueExpression,
  unwrapAsyncType,
  type TypeIndex,
} from '../ts-type-schema.js';

export type ResponseTypeResult = {
  outputSchema?: JsonSchema2020;
  outputSchemaConfidence?: OutputSchemaConfidence;
};

/** Generic wrappers whose first type argument is the JSON body. */
const RESPONSE_WRAPPERS = ['NextResponse', 'NextApiResponse', 'Response', 'TypedResponse'];

/** Static `.json(body)` helpers on the Web/Next response classes. */
const RESPONSE_JSON_OWNERS = new Set(['NextResponse', 'Response']);

type FunctionLike =
  | import('ts-morph').ArrowFunction
  | import('ts-morph').FunctionExpression
  | import('ts-morph').FunctionDeclaration;

function asFunctionLike(node: Node | undefined): FunctionLike | null {
  if (!node) return null;
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isFunctionDeclaration(node)) {
    return node;
  }
  return null;
}

/** Unwrap `Promise<NextResponse<T>>` / `NextResponse<T>` down to `T`'s text. */
function declaredBodyType(fn: FunctionLike): string | null {
  const returnText = unwrapAsyncType(fn.getReturnTypeNode()?.getText());
  if (!returnText) return null;
  return genericArgument(returnText, RESPONSE_WRAPPERS);
}

/** Every `NextResponse.json(x)` / `Response.json(x)` argument inside a function. */
function staticJsonBodies(fn: FunctionLike): Node[] {
  const body = fn.getBody();
  if (!body) return [];
  const found: Node[] = [];
  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    if (callee.getName() !== 'json') continue;
    const owner = callee.getExpression();
    if (!Node.isIdentifier(owner) || !RESPONSE_JSON_OWNERS.has(owner.getText())) continue;
    const arg = call.getArguments()[0];
    if (arg) found.push(arg);
  }
  return found;
}

/** Every `res.json(x)` argument, where `res` is the handler's 2nd parameter. */
function resJsonBodies(fn: FunctionLike): Node[] {
  const resName = fn.getParameters()[1]?.getName();
  const body = fn.getBody();
  if (!resName || !body) return [];
  const found: Node[] = [];
  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    if (callee.getName() !== 'json') continue;
    let root: Node | undefined = callee.getExpression();
    for (let i = 0; root && i < 8; i++) {
      if (Node.isPropertyAccessExpression(root) || Node.isCallExpression(root)) {
        root = root.getExpression();
        continue;
      }
      break;
    }
    if (!root || !Node.isIdentifier(root) || root.getText() !== resName) continue;
    const arg = call.getArguments()[0];
    if (arg) found.push(arg);
  }
  return found;
}

/** Collapse candidate body expressions to a schema, only when they all agree. */
function unanimousSchema(bodies: Node[], ctx: TypeIndex): JsonSchema2020 | null {
  if (bodies.length === 0) return null;
  const schemas = bodies.map((b) => schemaForValueExpression(b, ctx));
  const first = schemas[0];
  const allAgree = schemas.every((s) => JSON.stringify(s) === JSON.stringify(first));
  if (!allAgree || !isInformativeSchema(first)) return null;
  return first;
}

function resolveForFunction(fn: FunctionLike, ctx: TypeIndex): ResponseTypeResult {
  const declared = declaredBodyType(fn);
  if (declared) {
    const schema = schemaForTypeText(declared, ctx);
    if (isInformativeSchema(schema)) {
      return { outputSchema: schema, outputSchemaConfidence: 'inferred' };
    }
  }

  // Pages Router: the body type also rides on the `res: NextApiResponse<T>` param.
  const resType = genericArgument(fn.getParameters()[1]?.getTypeNode()?.getText(), RESPONSE_WRAPPERS);
  if (resType) {
    const schema = schemaForTypeText(resType, ctx);
    if (isInformativeSchema(schema)) {
      return { outputSchema: schema, outputSchemaConfidence: 'inferred' };
    }
  }

  const fromCalls = unanimousSchema([...staticJsonBodies(fn), ...resJsonBodies(fn)], ctx);
  if (fromCalls) return { outputSchema: fromCalls, outputSchemaConfidence: 'inferred' };

  return {};
}

/**
 * Response schemas for one API route file.
 *
 * - `perMethod` holds App Router results, keyed by the exported verb name.
 * - `fallback` holds the Pages Router default-export result, which the caller
 *   applies to every method it detected for the file.
 */
export function resolveNextResponseSchemas(
  sf: SourceFile,
  ctx: TypeIndex
): { perMethod: Map<string, ResponseTypeResult>; fallback: ResponseTypeResult } {
  const perMethod = new Map<string, ResponseTypeResult>();

  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (!name || !fn.isExported() || fn.isDefaultExport()) continue;
    const result = resolveForFunction(fn, ctx);
    if (result.outputSchema) perMethod.set(name.toUpperCase(), result);
  }

  // `export const GET = async (req) => ...`
  for (const decl of sf.getVariableDeclarations()) {
    if (!decl.isExported()) continue;
    const fn = asFunctionLike(decl.getInitializer());
    if (!fn) continue;
    const result = resolveForFunction(fn, ctx);
    if (result.outputSchema) perMethod.set(decl.getName().toUpperCase(), result);
  }

  const defaultFn =
    sf.getFunctions().find((f) => f.isDefaultExport()) ??
    asFunctionLike(sf.getExportAssignment((a) => !a.isExportEquals())?.getExpression());
  const fallback = defaultFn ? resolveForFunction(defaultFn, ctx) : {};

  return { perMethod, fallback };
}
