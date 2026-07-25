// Best-effort response typing for Express handlers.
//
// Express declares nothing about a response, so this is the weakest of the
// source-analysed stacks and the guards are correspondingly strict. Two signals
// are trusted, in order:
//
//  1. A typed `res` parameter — `(req, res: Response<ItemsBody>)`. That is the
//     developer stating the body type, so it wins outright.
//  2. A single unambiguous `res.json(<literal>)` in the handler body (a
//     `res.status(201).json(...)` chain counts). "Single" is load-bearing: a
//     handler with two structurally different `res.json` calls has branches we
//     cannot choose between, so nothing is emitted rather than picking one.
//
// Either way the result is 'inferred' — neither is a contract Express enforces.
// Everything else (a bare `res.send`, a helper that writes the response, a
// spread of a value we can't type) yields no outputSchema at all.

import { Node, SyntaxKind, type CallExpression, type SourceFile } from 'ts-morph';
import type { JsonSchema2020, OutputSchemaConfidence } from '../../types.js';
import {
  genericArgument,
  isInformativeSchema,
  schemaForTypeText,
  schemaForValueExpression,
  type TypeIndex,
} from '../ts-type-schema.js';

export type ResponseTypeResult = {
  outputSchema?: JsonSchema2020;
  outputSchemaConfidence?: OutputSchemaConfidence;
};

/** `Response<Body>` / `express.Response<Body, Locals>` — first type arg is the body. */
const RES_TYPE_WRAPPERS = ['Response', 'ExpressResponse'];

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

/**
 * Resolve the handler argument to a function body. Inline functions are used
 * directly; a bare identifier is followed to the first same-file declaration of
 * that name (a `function handler(...)` or a `const handler = (...) => ...`).
 */
function resolveHandler(node: Node | undefined, sf: SourceFile): FunctionLike | null {
  const direct = asFunctionLike(node);
  if (direct) return direct;
  if (!node || !Node.isIdentifier(node)) return null;

  const name = node.getText();
  const fn = sf.getFunction(name);
  if (fn) return fn;
  const decl = sf.getVariableDeclaration(name);
  return asFunctionLike(decl?.getInitializer());
}

/** Walk `res.status(201).json` / `res.json` back to the identifier it started from. */
function chainRootIdentifier(expr: Node): string | null {
  let current: Node | undefined = expr;
  for (let i = 0; current && i < 8; i++) {
    if (Node.isIdentifier(current)) return current.getText();
    if (Node.isPropertyAccessExpression(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isCallExpression(current)) {
      current = current.getExpression();
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Response schema for one Express route call: `app.get('/x', ..., handler)`.
 * `ctx` must be built with `includeShapes` so plain `interface`/`type` bodies
 * (how Express apps usually declare a response shape) resolve.
 */
export function resolveResponseSchema(
  routeCall: CallExpression,
  sf: SourceFile,
  ctx: TypeIndex
): ResponseTypeResult {
  const args = routeCall.getArguments();
  if (args.length < 2) return {};

  const handler = resolveHandler(args[args.length - 1], sf);
  if (!handler) return {};

  const params = handler.getParameters();
  const resParam = params[1];
  if (!resParam) return {};

  // 1. Typed `res` parameter.
  const bodyType = genericArgument(resParam.getTypeNode()?.getText(), RES_TYPE_WRAPPERS);
  if (bodyType) {
    const schema = schemaForTypeText(bodyType, ctx);
    if (isInformativeSchema(schema)) {
      return { outputSchema: schema, outputSchemaConfidence: 'inferred' };
    }
  }

  // 2. A single unambiguous `res.json(<literal>)`.
  const resName = resParam.getName();
  const body = handler.getBody();
  if (!body) return {};

  const candidates: JsonSchema2020[] = [];
  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    if (callee.getName() !== 'json') continue;
    if (chainRootIdentifier(callee.getExpression()) !== resName) continue;
    const arg = call.getArguments()[0];
    if (!arg) continue;
    candidates.push(schemaForValueExpression(arg, ctx));
  }

  if (candidates.length === 0) return {};
  const first = candidates[0];
  const allAgree = candidates.every((c) => JSON.stringify(c) === JSON.stringify(first));
  if (!allAgree || !isInformativeSchema(first)) return {};

  return { outputSchema: first, outputSchemaConfidence: 'inferred' };
}
