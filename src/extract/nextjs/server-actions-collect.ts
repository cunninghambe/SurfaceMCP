/** Internal pattern collectors for server-action discovery. */
import {
  SyntaxKind,
  Node,
  type SourceFile,
  type Node as TsNode,
  type FunctionDeclaration,
  type ArrowFunction,
  type FunctionExpression,
} from 'ts-morph';
import type { JsonSchema2020, InputSchemaConfidence } from '../../types.js';

export type ServerActionKind = 'file-level' | 'function-level' | 'form-bound';

export type ServerActionParam = {
  name: string;
  jsonType: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'formdata' | 'unknown';
  properties?: Record<string, ServerActionParam>;
  required: boolean;
  format?: string;
};

export type ServerAction = {
  name: string;
  kind: ServerActionKind;
  definitionFile: string;
  definitionLine: number;
  parameters: ServerActionParam[];
  schema: JsonSchema2020;
  schemaConfidence: InputSchemaConfidence;
};

type FunctionLike = FunctionDeclaration | ArrowFunction | FunctionExpression;
type FormFieldInfo = { name: string; type: string };

export function extractFormFields(content: string): FormFieldInfo[] {
  const fields: FormFieldInfo[] = [];
  const inputPattern = /<input[^>]+name=["'](\w+)["'][^>]*(?:type=["'](\w+)["'])?[^>]*\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = inputPattern.exec(content)) !== null) {
    fields.push({ name: match[1], type: match[2] ?? 'text' });
  }
  return fields;
}

export function formFieldsToSchema(fields: FormFieldInfo[]): JsonSchema2020 {
  if (fields.length === 0) return { type: 'object', additionalProperties: true };
  const properties: Record<string, { type: string; format?: string }> = {};
  const required: string[] = [];
  for (const field of fields) {
    const prop: { type: string; format?: string } = { type: 'string' };
    if (field.type === 'number') prop.type = 'number';
    else if (field.type === 'email') { prop.type = 'string'; prop.format = 'email'; }
    else if (field.type === 'checkbox') prop.type = 'boolean';
    properties[field.name] = prop;
    required.push(field.name);
  }
  return { type: 'object', properties, required };
}

export function classifyFileDirective(sf: SourceFile): 'use-server' | 'use-client' | 'none' {
  for (const stmt of sf.getStatements()) {
    if (!Node.isExpressionStatement(stmt)) break;
    const expr = stmt.getExpression();
    if (!Node.isStringLiteral(expr)) break;
    const text = expr.getLiteralText();
    if (text === 'use server') return 'use-server';
    if (text === 'use client') return 'use-client';
  }
  return 'none';
}

function resolveTypeText(typeText: string, depth: number): Pick<ServerActionParam, 'jsonType' | 'properties' | 'format'> {
  if (typeText === 'string') return { jsonType: 'string' };
  if (typeText === 'number' || typeText === 'bigint') return { jsonType: 'number' };
  if (typeText === 'boolean') return { jsonType: 'boolean' };
  if (typeText === 'Date') return { jsonType: 'string', format: 'date-time' };
  if (typeText === 'FormData') return { jsonType: 'formdata' };
  if (/^(any|unknown)$/.test(typeText)) return { jsonType: 'unknown' };
  if (/\[\]$/.test(typeText) || /^(Array|ReadonlyArray)</.test(typeText)) return { jsonType: 'array' };
  if (typeText.startsWith('{') && depth < 3) {
    return { jsonType: 'object', properties: parseObjectType(typeText, depth + 1) };
  }
  return { jsonType: 'unknown' };
}

function parseObjectType(typeText: string, depth: number): Record<string, ServerActionParam> {
  const props: Record<string, ServerActionParam> = {};
  const propPattern = /(\w+)(\?)?\s*:\s*([^;},]+)/g;
  let match: RegExpExecArray | null;
  while ((match = propPattern.exec(typeText)) !== null) {
    const resolved = resolveTypeText(match[3].trim(), depth);
    props[match[1]] = { name: match[1], required: match[2] !== '?', ...resolved };
  }
  return props;
}

export function extractParameters(node: FunctionLike): ServerActionParam[] {
  const params: ServerActionParam[] = [];
  for (let i = 0; i < node.getParameters().length; i++) {
    const param = node.getParameters()[i];
    if (param.isRestParameter()) {
      params.push({ name: param.getName(), jsonType: 'array', required: true });
      break;
    }
    const typeText = param.getTypeNode()?.getText() ?? param.getType().getText();
    const resolved = resolveTypeText(typeText, 0);
    params.push({ name: param.getName(), required: !param.isOptional() && !param.hasInitializer(), ...resolved });
  }
  return params;
}

function propToSchema(prop: ServerActionParam): JsonSchema2020 {
  if (prop.jsonType === 'object') {
    const properties: Record<string, JsonSchema2020> = {};
    const required: string[] = [];
    for (const [k, p] of Object.entries(prop.properties ?? {})) {
      properties[k] = propToSchema(p);
      if (p.required) required.push(k);
    }
    return { type: 'object', properties, required };
  }
  const s: JsonSchema2020 = { type: prop.jsonType };
  if (prop.format) s.format = prop.format;
  return s;
}

function buildSchemaFromParam(param: ServerActionParam): JsonSchema2020 {
  if (param.jsonType === 'unknown') return { type: 'object', additionalProperties: true };
  if (param.jsonType === 'object') {
    const properties: Record<string, JsonSchema2020> = {};
    const required: string[] = [];
    for (const [key, prop] of Object.entries(param.properties ?? {})) {
      properties[key] = propToSchema(prop);
      if (prop.required) required.push(key);
    }
    return { type: 'object', properties, required };
  }
  const propSchema: JsonSchema2020 = { type: param.jsonType };
  if (param.format) propSchema.format = param.format;
  return { type: 'object', properties: { value: propSchema }, required: ['value'] };
}

export function buildSchema(params: ServerActionParam[], content: string): JsonSchema2020 {
  if (params.length === 0) return { type: 'object', additionalProperties: false };
  const first = params[0];
  if (first.jsonType === 'formdata') return formFieldsToSchema(extractFormFields(content));
  return buildSchemaFromParam(first);
}

function hasUnknownProps(param: ServerActionParam): boolean {
  if (param.jsonType === 'unknown') return true;
  if (param.jsonType === 'object' && param.properties) {
    return Object.values(param.properties).some(hasUnknownProps);
  }
  return false;
}

export function computeConfidence(params: ServerActionParam[], content: string): InputSchemaConfidence {
  if (params.length === 0) return 'introspected';
  const first = params[0];
  if (first.jsonType === 'formdata') return 'inferred';
  if (/\.(parse|safeParse)\s*\(/.test(content)) return 'inferred';
  if (first.jsonType === 'unknown' || first.jsonType === 'array') return 'unknown';
  if (first.jsonType === 'object') {
    if (!first.properties || Object.keys(first.properties).length === 0) return 'inferred';
    return hasUnknownProps(first) ? 'inferred' : 'introspected';
  }
  return 'introspected';
}

function makeAction(name: string, kind: ServerActionKind, node: FunctionLike, relFile: string, content: string): ServerAction {
  const parameters = extractParameters(node);
  return {
    name,
    kind,
    definitionFile: relFile,
    definitionLine: node.getStartLineNumber(),
    parameters,
    schema: buildSchema(parameters, content),
    schemaConfidence: computeConfidence(parameters, content),
  };
}

export function collectPatternA(sf: SourceFile, relFile: string, content: string): ServerAction[] {
  const results: ServerAction[] = [];
  for (const fn of sf.getFunctions()) {
    if (!fn.isExported() || !fn.isAsync()) continue;
    const name = fn.getName();
    if (!name) { console.debug(`[server-actions] Pattern A: skipping unnamed export in ${relFile}`); continue; }
    results.push(makeAction(name, 'file-level', fn, relFile, content));
  }
  for (const vd of sf.getVariableDeclarations()) {
    const stmt = vd.getVariableStatement();
    if (!stmt?.isExported()) continue;
    const init = vd.getInitializer();
    if (!init) continue;
    if (!((Node.isArrowFunction(init) || Node.isFunctionExpression(init)) && init.isAsync())) continue;
    results.push(makeAction(vd.getName(), 'file-level', init as FunctionLike, relFile, content));
  }
  return results;
}

function hasUseServerDirective(node: FunctionLike): boolean {
  const body = node.getBody();
  if (!body || !Node.isBlock(body)) return false;
  const stmts = body.getStatements();
  if (stmts.length === 0) return false;
  const first = stmts[0];
  if (!Node.isExpressionStatement(first)) return false;
  const expr = first.getExpression();
  return Node.isStringLiteral(expr) && expr.getLiteralText() === 'use server';
}

function isInsideUseServerAncestor(node: FunctionLike): boolean {
  let parent: TsNode | null = node.getParent() ?? null;
  while (parent) {
    if (
      (Node.isFunctionDeclaration(parent) || Node.isArrowFunction(parent) || Node.isFunctionExpression(parent)) &&
      hasUseServerDirective(parent as FunctionLike)
    ) {
      return true;
    }
    parent = parent.getParent() ?? null;
  }
  return false;
}

function resolveBindingName(node: FunctionLike): string | undefined {
  if (Node.isFunctionDeclaration(node)) return node.getName() ?? undefined;
  const parent = node.getParent();
  if (Node.isVariableDeclaration(parent)) return parent.getName();
  if (Node.isPropertyAssignment(parent)) return parent.getName();
  return undefined;
}

export function collectPatternB(sf: SourceFile, relFile: string, content: string): ServerAction[] {
  const results: ServerAction[] = [];
  const seen = new Set<string>();
  const kinds = [SyntaxKind.FunctionDeclaration, SyntaxKind.ArrowFunction, SyntaxKind.FunctionExpression] as const;
  for (const kind of kinds) {
    for (const node of sf.getDescendantsOfKind(kind)) {
      const fn = node as FunctionLike;
      if (!hasUseServerDirective(fn)) continue;
      if (!fn.isAsync()) { console.debug(`[server-actions] Pattern B: skipping non-async function in ${relFile}`); continue; }
      if (isInsideUseServerAncestor(fn)) continue;
      const name = resolveBindingName(fn);
      if (!name) { console.debug(`[server-actions] Pattern B: skipping anonymous function in ${relFile}`); continue; }
      if (seen.has(name)) continue;
      seen.add(name);
      results.push(makeAction(name, 'function-level', fn, relFile, content));
    }
  }
  return results;
}

export function collectPatternC(
  sf: SourceFile,
  relFile: string,
  content: string,
  discovered: Map<string, ServerAction>,
): ServerAction[] {
  if (!/<form\s[^>]*action=\{/.test(content)) return [];
  const results: ServerAction[] = [];
  for (const attr of sf.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
    if (attr.getNameNode().getText() !== 'action') continue;
    const init = attr.getInitializer();
    if (!Node.isJsxExpression(init)) continue;
    const expr = init.getExpression();
    if (!expr) continue;
    const actionName = expr.getText().replace(/^props\./, '');
    const alreadyFound =
      discovered.has(`${relFile}:${actionName}`) ||
      [...discovered.values()].some((a) => a.name === actionName);
    if (alreadyFound) continue;
    results.push({
      name: actionName,
      kind: 'form-bound',
      definitionFile: relFile,
      definitionLine: 1,
      parameters: [],
      schema: formFieldsToSchema(extractFormFields(content)),
      schemaConfidence: 'inferred',
    });
  }
  return results;
}
