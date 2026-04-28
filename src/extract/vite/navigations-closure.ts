// Closure-arg resolver for navigation extraction.
// Resolves non-literal setState/navigate arguments to concrete string bindings
// via Pattern E1 (factory-call) and Pattern E2 (array.map).
// Spec: SPEC_CLOSURE_NAV_RESOLVE.md §3

import { SyntaxKind, type SourceFile, type Node } from 'ts-morph';

const MAX_BINDINGS = 32;
const TRIGGER_TAGS = new Set(['button', 'a', 'div', 'span', 'li', 'MenuItem', 'Item']);

export type ClosureBinding = { target: string; label?: string; ariaLabel?: string; title?: string; testId?: string };

export type ResolvedClosureArg =
  | { kind: 'resolved'; bindings: ClosureBinding[] }
  | { kind: 'skip'; reason: 'dynamic_target' | 'runtime_iterable' | 'runtime_index' | 'iterable_overflow'; detail: string };

/** Prop-setter candidate returned by findPropSetters. */
export type PropSetterInfo = { setterName: string };

export function resolveClosureArg(arg: Node, sf: SourceFile): ResolvedClosureArg {
  if (arg.getKind() !== SyntaxKind.Identifier) {
    return { kind: 'skip', reason: 'dynamic_target', detail: `non-identifier arg: ${arg.getText().slice(0, 30)}` };
  }
  return tryFactoryCallResolution(arg, sf) ?? tryArrayMapResolution(arg, sf)
    ?? { kind: 'skip', reason: 'dynamic_target', detail: `cannot resolve closure arg '${arg.getText()}'` };
}

function tryFactoryCallResolution(arg: Node, sf: SourceFile): ResolvedClosureArg | null {
  const argName = arg.getText();
  const resolution = findResolutionFunction(arg, argName);
  if (!resolution?.fnName) return null;
  const { fnNode, paramIndex, fnName } = resolution;

  const callsites = sf.getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter(c => c.getExpression().getText() === fnName);
  if (callsites.length === 0) return null;

  const factoryParamNames = getParamNames(fnNode);
  const labelMap = resolveJsxLabelParams(fnNode, factoryParamNames);
  const bindings: ClosureBinding[] = [];

  for (const cs of callsites) {
    const csArgs = cs.getArguments();
    const targetArg = csArgs[paramIndex];
    if (!targetArg) continue;
    if (targetArg.getKind() !== SyntaxKind.StringLiteral) {
      return { kind: 'skip', reason: 'dynamic_target', detail: `factory '${fnName}' called with non-literal at line ${cs.getStartLineNumber()}` };
    }
    const binding: ClosureBinding = { target: targetArg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText() };
    for (const [role, pName] of labelMap) {
      const pIdx = factoryParamNames.indexOf(pName);
      if (pIdx === -1) continue;
      const la = csArgs[pIdx];
      if (la?.getKind() === SyntaxKind.StringLiteral) applyRole(binding, role, la.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText());
    }
    bindings.push(binding);
  }

  if (bindings.length > MAX_BINDINGS) {
    return { kind: 'skip', reason: 'iterable_overflow', detail: `factory '${fnName}' has ${bindings.length} callsites (max ${MAX_BINDINGS})` };
  }
  return { kind: 'resolved', bindings };
}

type ResolutionFunction = { fnNode: Node; paramIndex: number; fnName: string | null };

function findResolutionFunction(arg: Node, paramName: string): ResolutionFunction | null {
  let current: Node | undefined = arg.getParent();
  while (current) {
    const k = current.getKind();
    if (k === SyntaxKind.ArrowFunction || k === SyntaxKind.FunctionExpression || k === SyntaxKind.FunctionDeclaration) {
      const names = getParamNames(current);
      const idx = names.indexOf(paramName);
      if (idx !== -1) return { fnNode: current, paramIndex: idx, fnName: getFunctionBindingName(current) };
    }
    current = current.getParent();
  }
  return null;
}

function getParamNames(fn: Node): string[] {
  return getParamNodes(fn).map(p => p.getName());
}

function getFunctionBindingName(fn: Node): string | null {
  if (fn.getKind() === SyntaxKind.FunctionDeclaration) {
    return fn.asKindOrThrow(SyntaxKind.FunctionDeclaration).getName() ?? null;
  }
  const parent = fn.getParent();
  if (parent?.getKind() === SyntaxKind.VariableDeclaration) {
    return parent.asKindOrThrow(SyntaxKind.VariableDeclaration).getName();
  }
  return null;
}

function tryArrayMapResolution(arg: Node, sf: SourceFile): ResolvedClosureArg | null {
  const dr = findDestructureDeclaration(arg, arg.getText());
  if (!dr) return null;
  const { mapCallNode, propertyName, arrowFn } = dr;
  const callee = mapCallNode.getExpression();
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  const itereeNode = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getExpression();
  const arrayLit = itereeNode.getKind() === SyntaxKind.ArrayLiteralExpression
    ? itereeNode.asKindOrThrow(SyntaxKind.ArrayLiteralExpression)
    : itereeNode.getKind() === SyntaxKind.Identifier ? resolveBindingToArray(itereeNode, sf, 2) : null;
  if (!arrayLit) return { kind: 'skip', reason: 'runtime_iterable', detail: `iteree of .map() does not resolve to a const array literal` };
  const elements = arrayLit.getElements();
  if (elements.length > MAX_BINDINGS) return { kind: 'skip', reason: 'iterable_overflow', detail: `array has ${elements.length} elements (max ${MAX_BINDINGS})` };
  const labelMap = resolveJsxLabelParams(arrowFn, getDestructuredLocalNames(arrowFn));
  const bindings: ClosureBinding[] = [];
  for (const el of elements) {
    if (el.getKind() !== SyntaxKind.ObjectLiteralExpression) return { kind: 'skip', reason: 'runtime_iterable', detail: `array element is not an object literal` };
    const obj = el.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
    const targetVal = getObjectStringProp(obj, propertyName);
    if (targetVal === null) return { kind: 'skip', reason: 'runtime_iterable', detail: `array element missing string property '${propertyName}'` };
    const binding: ClosureBinding = { target: targetVal };
    for (const [role, fieldName] of labelMap) {
      const val = getObjectStringProp(obj, fieldName);
      if (val !== null) applyRole(binding, role, val);
    }
    bindings.push(binding);
  }
  return { kind: 'resolved', bindings };
}

type DestructureResult = {
  mapCallNode: import('ts-morph').CallExpression;
  propertyName: string;
  arrowFn: Node;
};

function findDestructureDeclaration(arg: Node, argName: string): DestructureResult | null {
  let current: Node | undefined = arg.getParent();
  while (current) {
    const k = current.getKind();
    if (k === SyntaxKind.ArrowFunction || k === SyntaxKind.FunctionExpression) {
      for (const param of getParamNodes(current)) {
        const nn = param.getNameNode();
        if (nn.getKind() !== SyntaxKind.ObjectBindingPattern) continue;
        for (const el of nn.asKindOrThrow(SyntaxKind.ObjectBindingPattern).getElements()) {
          if (el.getNameNode().getText() !== argName) continue;
          const propertyName = el.getPropertyNameNode()?.getText() ?? argName;
          const parent = current.getParent();
          if (!parent || parent.getKind() !== SyntaxKind.CallExpression) break;
          const callExpr = parent.asKindOrThrow(SyntaxKind.CallExpression);
          const callee = callExpr.getExpression();
          if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) break;
          const method = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getName();
          if (method !== 'map' && method !== 'forEach' && method !== 'flatMap') break;
          return { mapCallNode: callExpr, propertyName, arrowFn: current };
        }
      }
    }
    current = current.getParent();
  }
  return null;
}

function resolveBindingToArray(node: Node, sf: SourceFile, depth: number): import('ts-morph').ArrayLiteralExpression | null {
  if (depth < 0) return null;
  const vd = sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration).find(v => v.getName() === node.getText());
  if (!vd) return null;
  const init = vd.getInitializer();
  if (!init) return null;
  if (init.getKind() === SyntaxKind.ArrayLiteralExpression) return init.asKindOrThrow(SyntaxKind.ArrayLiteralExpression);
  if (init.getKind() === SyntaxKind.Identifier && depth > 0) return resolveBindingToArray(init, sf, depth - 1);
  if (init.getKind() === SyntaxKind.AsExpression) {
    const inner = init.asKindOrThrow(SyntaxKind.AsExpression).getExpression();
    if (inner.getKind() === SyntaxKind.ArrayLiteralExpression) return inner.asKindOrThrow(SyntaxKind.ArrayLiteralExpression);
  }
  return null;
}

type LabelRole = 'text' | 'ariaLabel' | 'title' | 'testId';

function applyRole(binding: ClosureBinding, role: LabelRole, val: string): void {
  if (role === 'text') binding.label = val;
  else if (role === 'ariaLabel') binding.ariaLabel = val;
  else if (role === 'title') binding.title = val;
  else binding.testId = val;
}

function getJsxTagAttrs(node: Node): [string, Node[]] | null {
  if (node.getKind() === SyntaxKind.JsxElement) {
    const el = node.asKindOrThrow(SyntaxKind.JsxElement).getOpeningElement();
    return [el.getTagNameNode().getText(), el.getAttributes()];
  }
  if (node.getKind() === SyntaxKind.JsxSelfClosingElement) {
    const el = node.asKindOrThrow(SyntaxKind.JsxSelfClosingElement);
    return [el.getTagNameNode().getText(), el.getAttributes()];
  }
  return null;
}

function findTriggerInBody(startNode: Node): Node | null {
  let current: Node | undefined = startNode.getParent();
  for (let hops = 0; current && hops < 8; hops++, current = current.getParent()) {
    const ta = getJsxTagAttrs(current);
    if (!ta) continue;
    const [tag, attrs] = ta;
    if (TRIGGER_TAGS.has(tag)) return current;
    for (const attr of attrs) {
      if (attr.getKind() !== SyntaxKind.JsxAttribute) continue;
      const ja = attr.asKindOrThrow(SyntaxKind.JsxAttribute);
      if (ja.getNameNode().getText() !== 'role') continue;
      const init = ja.getInitializer();
      if (init?.getKind() === SyntaxKind.StringLiteral) {
        const v = init.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText();
        if (v === 'button' || v === 'link') return current;
      }
    }
  }
  return null;
}

function resolveJsxLabelParams(fnNode: Node, paramNames: string[]): Map<LabelRole, string> {
  const result = new Map<LabelRole, string>();
  if (paramNames.length === 0) return result;
  for (const call of fnNode.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const trigger = findTriggerInBody(call);
    if (!trigger) continue;
    for (const expr of trigger.getDescendantsOfKind(SyntaxKind.JsxExpression)) {
      const inner = expr.getExpression();
      if (!inner || inner.getKind() !== SyntaxKind.Identifier || !paramNames.includes(inner.getText())) continue;
      const name = inner.getText();
      const parent = expr.getParent();
      if (parent?.getKind() === SyntaxKind.JsxAttribute) {
        const an = parent.asKindOrThrow(SyntaxKind.JsxAttribute).getNameNode().getText();
        if (an === 'aria-label') result.set('ariaLabel', name);
        else if (an === 'title') result.set('title', name);
        else if (an === 'data-testid') result.set('testId', name);
      } else result.set('text', name);
    }
    if (result.size > 0) break;
  }
  return result;
}

function getDestructuredLocalNames(fnNode: Node): string[] {
  for (const param of getParamNodes(fnNode)) {
    const nn = param.getNameNode();
    if (nn.getKind() !== SyntaxKind.ObjectBindingPattern) continue;
    return nn.asKindOrThrow(SyntaxKind.ObjectBindingPattern).getElements().map(el => el.getNameNode().getText());
  }
  return [];
}

function getParamNodes(fn: Node): import('ts-morph').ParameterDeclaration[] {
  const k = fn.getKind();
  if (k === SyntaxKind.FunctionDeclaration) return fn.asKindOrThrow(SyntaxKind.FunctionDeclaration).getParameters();
  if (k === SyntaxKind.ArrowFunction) return fn.asKindOrThrow(SyntaxKind.ArrowFunction).getParameters();
  return fn.asKindOrThrow(SyntaxKind.FunctionExpression).getParameters();
}

function getObjectStringProp(obj: import('ts-morph').ObjectLiteralExpression, propName: string): string | null {
  for (const prop of obj.getProperties()) {
    if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
    const pa = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
    if (pa.getNameNode().getText() !== propName) continue;
    const init = pa.getInitializer();
    if (!init) return null;
    const expr = init.getKind() === SyntaxKind.AsExpression ? init.asKindOrThrow(SyntaxKind.AsExpression).getExpression() : init;
    return expr.getKind() === SyntaxKind.StringLiteral ? expr.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText() : null;
  }
  return null;
}

export function findPropSetters(sf: SourceFile): PropSetterInfo[] {
  const result: PropSetterInfo[] = [];
  for (const fn of [...sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration), ...sf.getDescendantsOfKind(SyntaxKind.ArrowFunction), ...sf.getDescendantsOfKind(SyntaxKind.FunctionExpression)]) {
    for (const param of getParamNodes(fn)) {
      const nn = param.getNameNode();
      if (nn.getKind() !== SyntaxKind.ObjectBindingPattern) continue;
      for (const el of nn.asKindOrThrow(SyntaxKind.ObjectBindingPattern).getElements()) {
        const name = el.getNameNode().getText();
        if (/^set.+/i.test(name) && isStringSetterProp(param, name)) result.push({ setterName: name });
      }
    }
  }
  return result;
}

function isStringSetterProp(param: import('ts-morph').ParameterDeclaration, setterName: string): boolean {
  try {
    const prop = param.getType().getProperty(setterName);
    if (!prop) return false;
    const sigs = prop.getValueDeclarationOrThrow().getType().getCallSignatures();
    return sigs.some(sig => {
      const sp = sig.getParameters();
      if (sp.length === 0) return false;
      const t = sp[0].getValueDeclarationOrThrow().getType();
      return t.isString() || t.isStringLiteral();
    });
  } catch {
    return false;
  }
}
