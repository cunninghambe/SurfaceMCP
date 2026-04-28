// Vite SPA navigation extractor — static analysis of <Link>, <a href>, useNavigate(), setState setters
// Spec: SPEC_NAV_EXTRACT.md §3

import {
  Project,
  SyntaxKind,
  type SourceFile,
  type Node,
} from 'ts-morph';
import { glob } from 'tinyglobby';
import { existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type { Navigation, NavigationSkip } from '../../types.js';
import { loadPathsMap, buildImportMap, type ImportMap, type PathsMap } from './util.js';

// ─── label extraction ─────────────────────────────────────────────────────────

/** Walk JSX element children and collect text content (strips whitespace, max 80 chars). */
function extractJsxLabel(node: Node): string {
  const parts: string[] = [];
  collectTextContent(node, parts);
  return parts.join('').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function collectTextContent(node: Node, parts: string[]): void {
  const kind = node.getKind();
  if (kind === SyntaxKind.JsxText) {
    parts.push(node.getText());
    return;
  }
  if (kind === SyntaxKind.JsxElement || kind === SyntaxKind.JsxFragment) {
    for (const child of node.getChildren()) {
      collectTextContent(child, parts);
    }
    return;
  }
  if (kind === SyntaxKind.SyntaxList) {
    for (const child of node.getChildren()) {
      collectTextContent(child, parts);
    }
    return;
  }
  if (kind === SyntaxKind.JsxExpression) {
    // Not traversable statically in a meaningful way; skip
    return;
  }
}

/** Get a string literal attribute from a JSX element's attribute list. */
function getStringAttr(attrs: Node[], name: string): string | undefined {
  for (const attr of attrs) {
    if (attr.getKind() !== SyntaxKind.JsxAttribute) continue;
    const jsxAttr = attr.asKindOrThrow(SyntaxKind.JsxAttribute);
    if (jsxAttr.getNameNode().getText() !== name) continue;
    const init = jsxAttr.getInitializer();
    if (!init) return undefined;
    if (init.getKind() === SyntaxKind.StringLiteral) {
      return init.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText();
    }
    if (init.getKind() === SyntaxKind.JsxExpression) {
      const expr = init.asKindOrThrow(SyntaxKind.JsxExpression).getExpression();
      if (expr?.getKind() === SyntaxKind.StringLiteral) {
        return expr.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText();
      }
    }
    return undefined;
  }
  return undefined;
}

/** Walk up at most 8 parent nodes to find a JSX trigger element (button, a, div, span, or role=button/link). */
function findEnclosingTrigger(node: Node): Node | null {
  const TRIGGER_TAGS = new Set(['button', 'a', 'div', 'span', 'li', 'MenuItem', 'Item']);
  let current = node.getParent();
  let hops = 0;
  while (current && hops < 8) {
    const kind = current.getKind();
    if (kind === SyntaxKind.JsxElement || kind === SyntaxKind.JsxSelfClosingElement) {
      const tagName = kind === SyntaxKind.JsxElement
        ? current.asKindOrThrow(SyntaxKind.JsxElement).getOpeningElement().getTagNameNode().getText()
        : current.asKindOrThrow(SyntaxKind.JsxSelfClosingElement).getTagNameNode().getText();
      const attrs: Node[] = kind === SyntaxKind.JsxElement
        ? current.asKindOrThrow(SyntaxKind.JsxElement).getOpeningElement().getAttributes()
        : current.asKindOrThrow(SyntaxKind.JsxSelfClosingElement).getAttributes();

      if (TRIGGER_TAGS.has(tagName)) return current;
      // Check for role="button" or role="link"
      const role = getStringAttr(attrs, 'role');
      if (role === 'button' || role === 'link') return current;
    }
    current = current.getParent();
    hops++;
  }
  return null;
}

/** Derives the highest-priority selector field name from a hint object. */
function preferredSelector(hint: {
  testId?: string;
  ariaLabel?: string;
  text?: string;
  title?: string;
}): 'testId' | 'ariaLabel' | 'text' | 'title' | undefined {
  if (hint.testId !== undefined && hint.testId !== '') return 'testId';
  if (hint.ariaLabel !== undefined && hint.ariaLabel !== '') return 'ariaLabel';
  if (hint.text !== undefined && hint.text !== '') return 'text';
  if (hint.title !== undefined && hint.title !== '') return 'title';
  return undefined;
}

/** Extract label and hint from a trigger JSX element. */
function extractTriggerInfo(trigger: Node): {
  label: string;
  /** Raw JSX text content (not title fallback). Used as triggerSelectorHint.text. */
  textContent: string;
  testId?: string;
  ariaLabel?: string;
  title?: string;
} {
  const kind = trigger.getKind();
  const attrs: Node[] = kind === SyntaxKind.JsxElement
    ? trigger.asKindOrThrow(SyntaxKind.JsxElement).getOpeningElement().getAttributes()
    : trigger.asKindOrThrow(SyntaxKind.JsxSelfClosingElement).getAttributes();

  const testId = getStringAttr(attrs, 'data-testid');
  const ariaLabel = getStringAttr(attrs, 'aria-label');
  const titleAttr = getStringAttr(attrs, 'title');
  const textContent = extractJsxLabel(trigger).trim();
  const label = textContent || titleAttr || '';

  return { label, textContent, testId, ariaLabel, title: titleAttr };
}

// ─── Pass A: <Link to="..."> and <NavLink to="..."> ─────────────────────────

function passA(
  sf: SourceFile,
  filePath: string,
  root: string,
  importMap: ImportMap,
  navigations: Navigation[],
  skips: NavigationSkip[]
): void {
  const linkLocalNames: string[] = [];
  for (const [local, src] of importMap) {
    if ((local === 'Link' || local === 'NavLink') && src === 'react-router-dom') {
      linkLocalNames.push(local);
    }
  }
  if (linkLocalNames.length === 0) return;

  const sourceFileRelative = relative(root, filePath).replace(/\\/g, '/');

  function processLinkElement(node: Node, tagName: string): void {
    const isJsxEl = node.getKind() === SyntaxKind.JsxElement;
    const attrs: Node[] = isJsxEl
      ? node.asKindOrThrow(SyntaxKind.JsxElement).getOpeningElement().getAttributes()
      : node.asKindOrThrow(SyntaxKind.JsxSelfClosingElement).getAttributes();

    const to = getStringAttr(attrs, 'to');
    const line = node.getStartLineNumber();

    if (to === undefined) {
      // Non-literal "to" attribute
      const toAttr = attrs.find(a => {
        if (a.getKind() !== SyntaxKind.JsxAttribute) return false;
        return a.asKindOrThrow(SyntaxKind.JsxAttribute).getNameNode().getText() === 'to';
      });
      if (toAttr) {
        skips.push({
          reason: 'dynamic_target',
          detail: `${tagName} with non-literal 'to' at ${sourceFileRelative}:${line}`,
          declaredAt: { file: sourceFileRelative, line },
        });
      }
      return;
    }

    const testId = getStringAttr(attrs, 'data-testid');
    const ariaLabel = getStringAttr(attrs, 'aria-label');
    const titleAttr = getStringAttr(attrs, 'title');
    const labelText = isJsxEl
      ? extractJsxLabel(node).trim()
      : to.split('/').filter(Boolean).pop() ?? to;

    const hint = { text: labelText || undefined, testId, ariaLabel, title: titleAttr };
    const nav: Navigation = {
      label: labelText,
      method: 'router-link',
      target: to,
      kind: 'url',
      triggerSelectorHint: { ...hint, preferred: preferredSelector(hint) },
      sourceFile: sourceFileRelative,
      sourceLine: line,
      confidence: 'high',
    };
    navigations.push(nav);
  }

  // Walk all JSX elements
  const allElements = [
    ...sf.getDescendantsOfKind(SyntaxKind.JsxElement),
    ...sf.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ];

  for (const el of allElements) {
    const tagName = el.getKind() === SyntaxKind.JsxElement
      ? el.asKindOrThrow(SyntaxKind.JsxElement).getOpeningElement().getTagNameNode().getText()
      : el.asKindOrThrow(SyntaxKind.JsxSelfClosingElement).getTagNameNode().getText();

    if (linkLocalNames.includes(tagName)) {
      processLinkElement(el, tagName);
    }
  }
}

// ─── Pass B: <a href="..."> ──────────────────────────────────────────────────

const SKIP_HREF_PREFIXES = ['mailto:', 'tel:', 'javascript:', 'http://', 'https://'];

function passB(
  sf: SourceFile,
  filePath: string,
  root: string,
  navigations: Navigation[],
  skips: NavigationSkip[]
): void {
  const sourceFileRelative = relative(root, filePath).replace(/\\/g, '/');

  const allAnchorElements = [
    ...sf.getDescendantsOfKind(SyntaxKind.JsxElement),
    ...sf.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ].filter(el => {
    const tagName = el.getKind() === SyntaxKind.JsxElement
      ? el.asKindOrThrow(SyntaxKind.JsxElement).getOpeningElement().getTagNameNode().getText()
      : el.asKindOrThrow(SyntaxKind.JsxSelfClosingElement).getTagNameNode().getText();
    return tagName === 'a';
  });

  for (const el of allAnchorElements) {
    const isJsxEl = el.getKind() === SyntaxKind.JsxElement;
    const attrs: Node[] = isJsxEl
      ? el.asKindOrThrow(SyntaxKind.JsxElement).getOpeningElement().getAttributes()
      : el.asKindOrThrow(SyntaxKind.JsxSelfClosingElement).getAttributes();

    const href = getStringAttr(attrs, 'href');
    if (href === undefined) continue; // no href attribute or non-literal

    const line = el.getStartLineNumber();

    // Skip off-origin or non-http hrefs
    if (SKIP_HREF_PREFIXES.some(prefix => href.startsWith(prefix))) continue;

    // Determine kind
    let kind: 'url' | 'hash';
    if (href.startsWith('#')) {
      kind = 'hash';
    } else if (href.startsWith('/')) {
      kind = 'url';
    } else {
      // Relative path without leading /: emit dynamic_target skip
      skips.push({
        reason: 'dynamic_target',
        detail: `<a href="${href}"> is a relative path without leading / at ${sourceFileRelative}:${line}`,
        declaredAt: { file: sourceFileRelative, line },
      });
      continue;
    }

    const testId = getStringAttr(attrs, 'data-testid');
    const ariaLabel = getStringAttr(attrs, 'aria-label');
    const titleAttr = getStringAttr(attrs, 'title');
    const labelText = isJsxEl ? extractJsxLabel(el).trim() : '';

    const hint = { text: labelText || undefined, testId, ariaLabel, title: titleAttr };
    navigations.push({
      label: labelText,
      method: 'link',
      target: href,
      kind,
      triggerSelectorHint: { ...hint, preferred: preferredSelector(hint) },
      sourceFile: sourceFileRelative,
      sourceLine: line,
      confidence: 'high',
    });
  }
}

// ─── Pass C: useNavigate() / navigate('...') ─────────────────────────────────

function passC(
  sf: SourceFile,
  filePath: string,
  root: string,
  importMap: ImportMap,
  navigations: Navigation[],
  skips: NavigationSkip[]
): void {
  const sourceFileRelative = relative(root, filePath).replace(/\\/g, '/');

  // Find local name(s) of useNavigate from react-router-dom
  const useNavigateLocalNames = new Set<string>();
  for (const [local, src] of importMap) {
    if (src === 'react-router-dom' && local === 'useNavigate') {
      useNavigateLocalNames.add(local);
    }
  }
  // Also catch aliased: const nav = useNavigate() - handled via binding below

  // Step 1: find variable bindings = useNavigate()
  const navigateBindings = new Map<string, boolean>(); // varName → true (is navigate fn)
  const varDecls = sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
  for (const vd of varDecls) {
    const init = vd.getInitializer();
    if (!init || init.getKind() !== SyntaxKind.CallExpression) continue;
    const call = init.asKindOrThrow(SyntaxKind.CallExpression);
    const callName = call.getExpression().getText();
    if (useNavigateLocalNames.has(callName)) {
      navigateBindings.set(vd.getName(), true);
    }
  }

  if (navigateBindings.size === 0) return;

  // Step 2: find all call expressions that call a navigate binding
  const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of calls) {
    const exprText = call.getExpression().getText();
    if (!navigateBindings.has(exprText)) continue;

    const args = call.getArguments();
    if (args.length === 0) continue;
    const arg0 = args[0];
    const line = call.getStartLineNumber();

    // Must be a string literal
    if (arg0.getKind() !== SyntaxKind.StringLiteral) {
      skips.push({
        reason: 'dynamic_target',
        detail: `${exprText}(${arg0.getText()}) non-literal at ${sourceFileRelative}:${line}`,
        declaredAt: { file: sourceFileRelative, line },
      });
      continue;
    }

    const target = arg0.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText();

    // Step 3: find enclosing trigger
    const trigger = findEnclosingTrigger(call);
    if (!trigger) {
      skips.push({
        reason: 'no_trigger_label',
        detail: `${exprText}('${target}') has no enclosing trigger at ${sourceFileRelative}:${line}`,
        declaredAt: { file: sourceFileRelative, line },
      });
      continue;
    }

    const { label, textContent, testId, ariaLabel, title } = extractTriggerInfo(trigger);

    const hint = { text: textContent || undefined, testId, ariaLabel, title };
    navigations.push({
      label,
      method: 'router-push',
      target,
      kind: 'url',
      triggerSelectorHint: { ...hint, preferred: preferredSelector(hint) },
      sourceFile: sourceFileRelative,
      sourceLine: line,
      confidence: 'medium',
    });
  }
}

// ─── Pass D: useState tab-state setter detection ─────────────────────────────

const MAX_UNION_MEMBERS = 32;

type StateVarInfo = {
  varName: string;
  setterName: string;
  unionMembers: Set<string>;
  inferredUnion: boolean; // true = inferred from callsites, not declared type
};

function passD(
  sf: SourceFile,
  filePath: string,
  root: string,
  importMap: ImportMap,
  navigations: Navigation[],
  skips: NavigationSkip[]
): void {
  const sourceFileRelative = relative(root, filePath).replace(/\\/g, '/');

  // Verify useState is imported from react
  let useStateLocalName: string | null = null;
  for (const [local, src] of importMap) {
    if (src === 'react' && local === 'useState') {
      useStateLocalName = local;
      break;
    }
  }
  if (!useStateLocalName) return;

  // D.1: Find useState<'a'|'b'>('a') declarations
  const stateVars: StateVarInfo[] = [];
  const varDecls = sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration);

  for (const vd of varDecls) {
    const init = vd.getInitializer();
    if (!init || init.getKind() !== SyntaxKind.CallExpression) continue;
    const call = init.asKindOrThrow(SyntaxKind.CallExpression);
    if (call.getExpression().getText() !== useStateLocalName) continue;

    // LHS must be [varName, setterName]
    const nameNode = vd.getNameNode();
    if (nameNode.getKind() !== SyntaxKind.ArrayBindingPattern) continue;
    const elements = nameNode.asKindOrThrow(SyntaxKind.ArrayBindingPattern).getElements();
    if (elements.length !== 2) continue;

    const varName = elements[0].getKind() === SyntaxKind.BindingElement
      ? elements[0].asKindOrThrow(SyntaxKind.BindingElement).getNameNode().getText()
      : null;
    const setterName = elements[1].getKind() === SyntaxKind.BindingElement
      ? elements[1].asKindOrThrow(SyntaxKind.BindingElement).getNameNode().getText()
      : null;

    if (!varName || !setterName) continue;

    // Setter must start with "set" (case-insensitive) and have ≥ 1 char after
    if (!/^set.+/i.test(setterName)) continue;

    // Try to get union members from type argument
    const typeArgs = call.getTypeArguments();
    const unionMembers = new Set<string>();
    let inferredUnion = false;

    if (typeArgs.length > 0) {
      // Explicit type argument: useState<'a' | 'b' | 'c'> or useState<Tab> (type alias)
      const typeArg = typeArgs[0];
      if (typeArg.getKind() === SyntaxKind.UnionType) {
        // Direct union literal: useState<'a' | 'b'>
        const unionType = typeArg.asKindOrThrow(SyntaxKind.UnionType);
        for (const member of unionType.getTypeNodes()) {
          if (member.getKind() === SyntaxKind.LiteralType) {
            const litType = member.asKindOrThrow(SyntaxKind.LiteralType);
            const lit = litType.getLiteral();
            if (lit.getKind() === SyntaxKind.StringLiteral) {
              unionMembers.add(lit.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText());
            }
          }
        }
      } else {
        // TypeReference (type alias like Tab) — resolve via type checker
        const resolvedType = typeArg.getType();
        const unionTypes = resolvedType.getUnionTypes();
        for (const ut of unionTypes) {
          const val = ut.getLiteralValue();
          if (typeof val === 'string') {
            unionMembers.add(val);
          }
        }
      }
    }

    if (unionMembers.size === 0) {
      // Fall back: try to infer from initial value (string literal arg to useState)
      const callArgs = call.getArguments();
      if (callArgs.length > 0 && callArgs[0].getKind() === SyntaxKind.StringLiteral) {
        unionMembers.add(callArgs[0].asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText());
        inferredUnion = true;
      } else {
        // Not a tab-state useState
        continue;
      }
    }

    // Check overflow before deciding on inferred-union fallback
    // (inferred-union starts with 1 member from initial value; overflow check here catches explicit types)
    if (unionMembers.size > MAX_UNION_MEMBERS) {
      skips.push({
        reason: 'union_overflow',
        detail: `${setterName} has ${unionMembers.size} union members (max ${MAX_UNION_MEMBERS})`,
        declaredAt: { file: sourceFileRelative, line: vd.getStartLineNumber() },
      });
      continue;
    }

    stateVars.push({ varName, setterName, unionMembers, inferredUnion });
  }

  if (stateVars.length === 0) return;

  // D.2 + D.3: Find setter callsites with literal args
  const allCalls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);

  // For inferred-union: accumulate all literal args first
  for (const sv of stateVars) {
    if (!sv.inferredUnion) continue;
    for (const call of allCalls) {
      if (call.getExpression().getText() !== sv.setterName) continue;
      const args = call.getArguments();
      if (args.length === 0) continue;
      const arg0 = args[0];
      if (arg0.getKind() === SyntaxKind.StringLiteral) {
        sv.unionMembers.add(arg0.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText());
      }
    }
  }

  // Deduplicate navigations by (sourceFile, sourceLine, target)
  const emitted = new Set<string>();

  for (const sv of stateVars) {
    for (const call of allCalls) {
      if (call.getExpression().getText() !== sv.setterName) continue;

      const args = call.getArguments();
      if (args.length === 0) continue;
      const arg0 = args[0];
      const line = call.getStartLineNumber();

      // Skip arrow functions used as updater: setTab(prev => ...)
      if (
        arg0.getKind() === SyntaxKind.ArrowFunction ||
        arg0.getKind() === SyntaxKind.FunctionExpression
      ) {
        skips.push({
          reason: 'dynamic_target',
          detail: `${sv.setterName}(${arg0.getText().slice(0, 30)}) updater function at ${sourceFileRelative}:${line}`,
          declaredAt: { file: sourceFileRelative, line },
        });
        continue;
      }

      if (arg0.getKind() !== SyntaxKind.StringLiteral) {
        skips.push({
          reason: 'dynamic_target',
          detail: `${sv.setterName}(${arg0.getText().slice(0, 30)}) non-literal at ${sourceFileRelative}:${line}`,
          declaredAt: { file: sourceFileRelative, line },
        });
        continue;
      }

      const target = arg0.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText();
      const dedupeKey = `${sourceFileRelative}:${line}:${target}`;
      if (emitted.has(dedupeKey)) continue;
      emitted.add(dedupeKey);

      const inUnion = sv.unionMembers.has(target);
      const confidence = sv.inferredUnion
        ? 'medium'
        : inUnion
        ? 'high'
        : 'low';

      // D.3: Find enclosing trigger
      const trigger = findEnclosingTrigger(call);
      if (!trigger) {
        // Check if it's in a useEffect or non-JSX context
        skips.push({
          reason: 'no_trigger_label',
          detail: `${sv.setterName}('${target}') has no enclosing JSX trigger at ${sourceFileRelative}:${line}`,
          declaredAt: { file: sourceFileRelative, line },
        });
        continue;
      }

      const { label, textContent, testId, ariaLabel, title } = extractTriggerInfo(trigger);

      const hint = { text: textContent || undefined, testId, ariaLabel, title };
      navigations.push({
        label,
        method: 'state-setter',
        target,
        kind: 'state',
        stateVar: sv.varName,
        triggerSelectorHint: { ...hint, preferred: preferredSelector(hint) },
        sourceFile: sourceFileRelative,
        sourceLine: line,
        confidence,
      });
    }
  }
}

// ─── Post-pass: scope classification ──────────────────────────────────────────

/**
 * Identifies the "app-root" source file path (project-root-relative).
 * Heuristic: the file with the largest union among all detected state-vars, or
 * the first file whose name is 'App.tsx' (case-insensitive) if no state-var
 * has more than 1 member.
 */
function findRootFilePath(navigations: Navigation[]): string | null {
  // Find the sourceFile whose state-setters cover the most distinct targets
  const fileCounts = new Map<string, Set<string>>();
  for (const nav of navigations) {
    if (nav.method !== 'state-setter') continue;
    if (!fileCounts.has(nav.sourceFile)) fileCounts.set(nav.sourceFile, new Set());
    fileCounts.get(nav.sourceFile)!.add(nav.target);
  }

  let bestFile: string | null = null;
  let bestCount = 0;
  for (const [file, targets] of fileCounts) {
    if (targets.size > bestCount) {
      bestCount = targets.size;
      bestFile = file;
    }
  }

  // If the winner has only 1 target it's not a reliable signal — fall back to App.tsx name match
  if (bestCount <= 1) {
    for (const file of fileCounts.keys()) {
      const basename = file.split('/').pop()?.toLowerCase() ?? '';
      if (basename === 'app.tsx' || basename === 'app.jsx') return file;
    }
    return null;
  }
  return bestFile;
}

/**
 * Classifies each navigation as 'top-level' or 'page-local'.
 * URL-based navigations (link, router-link, router-push) and hash navs are always top-level.
 * State-setters: top-level if the setter's sourceFile matches the root file; page-local otherwise.
 * Falls back to top-level when the root file is ambiguous.
 */
function classifyScope(navigations: Navigation[]): Navigation[] {
  const rootFile = findRootFilePath(navigations);

  return navigations.map(nav => {
    // URL-based and hash navigations are always top-level (crawler can reach them from any URL)
    if (nav.method === 'link' || nav.method === 'router-link' || nav.method === 'router-push') {
      return { ...nav, scope: 'top-level' as const };
    }
    if (nav.kind === 'hash') {
      return { ...nav, scope: 'top-level' as const };
    }

    // State-setters: compare sourceFile to root
    if (rootFile === null) return { ...nav, scope: 'top-level' as const };

    const scope = nav.sourceFile === rootFile ? 'top-level' as const : 'page-local' as const;
    return { ...nav, scope };
  });
}

// ─── Post-pass: sibling-navigation counting + confidence drop ─────────────────

const CONFIDENCE_DROP: Record<string, 'high' | 'medium' | 'low'> = {
  high: 'medium',
  medium: 'low',
  low: 'low',
};

/**
 * For each navigation, counts how many others in the same scope share the exact
 * same text hint (case-insensitive, trimmed). When ambiguous and preferred === 'text',
 * drops confidence one notch.
 */
function countSiblings(navigations: Navigation[]): Navigation[] {
  // Group by (scope, normalizedText) — only non-empty text counts
  const groups = new Map<string, Navigation[]>();
  for (const nav of navigations) {
    const text = nav.triggerSelectorHint.text?.trim().toLowerCase() ?? '';
    if (text === '') continue;
    const key = `${nav.scope ?? 'top-level'}::${text}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(nav);
  }

  return navigations.map(nav => {
    const text = nav.triggerSelectorHint.text?.trim().toLowerCase() ?? '';
    const key = `${nav.scope ?? 'top-level'}::${text}`;
    const group = text !== '' ? (groups.get(key) ?? []) : [];
    const siblingNavigations = Math.max(0, group.length - 1);

    let { confidence } = nav;
    if (siblingNavigations > 0 && nav.triggerSelectorHint.preferred === 'text') {
      confidence = CONFIDENCE_DROP[confidence] ?? 'low';
    }

    return { ...nav, siblingNavigations, confidence };
  });
}

// ─── Post-pass: cross-file duplicate count ────────────────────────────────────

/**
 * Counts navigations sharing (method, target, kind, scope). Sets duplicateCount = N - 1.
 */
function countDuplicates(navigations: Navigation[]): Navigation[] {
  const groups = new Map<string, Navigation[]>();
  for (const nav of navigations) {
    const key = `${nav.method}::${nav.target}::${nav.kind}::${nav.scope ?? 'top-level'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(nav);
  }

  return navigations.map(nav => {
    const key = `${nav.method}::${nav.target}::${nav.kind}::${nav.scope ?? 'top-level'}`;
    const group = groups.get(key) ?? [];
    return { ...nav, duplicateCount: Math.max(0, group.length - 1) };
  });
}

// ─── main extractor ──────────────────────────────────────────────────────────

export type ViteNavigationsResult = {
  navigations: Navigation[];
  skips: NavigationSkip[];
};

/**
 * Extract static navigations from a Vite SPA.
 * Can accept a pre-built Project for reuse (avoids double file-glob).
 */
export async function extractViteNavigations(
  root: string,
  existingProject?: Project,
  existingPathsMap?: PathsMap,
  existingFiles?: string[]
): Promise<ViteNavigationsResult> {
  let files: string[];
  let pathsMap: PathsMap;
  let project: Project;

  if (existingProject && existingPathsMap !== undefined && existingFiles !== undefined) {
    project = existingProject;
    pathsMap = existingPathsMap;
    files = existingFiles;
  } else {
    const srcDirs = ['src', 'app'].map(d => resolve(root, d));
    const existingSrcDirs = srcDirs.filter(d => existsSync(d));

    files = (
      await Promise.all(
        existingSrcDirs.map(dir =>
          glob('**/*.{tsx,jsx}', {
            cwd: dir,
            ignore: [
              'node_modules/**',
              'dist/**',
              'build/**',
              '.next/**',
              '**/*.test.*',
              '**/*.spec.*',
              '**/*.d.ts',
            ],
          }).then(matched => matched.map(f => resolve(dir, f)))
        )
      )
    ).flat();

    if (files.length === 0) return { navigations: [], skips: [] };

    pathsMap = loadPathsMap(root);

    project = new Project({
      compilerOptions: {
        jsx: 4, // ReactJSX
        allowJs: true,
        noEmit: true,
      },
      useInMemoryFileSystem: false,
      skipAddingFilesFromTsConfig: true,
    });

    for (const f of files) {
      try {
        project.addSourceFileAtPath(f);
      } catch {
        // skip unparseable files
      }
    }
  }

  const allNavigations: Navigation[] = [];
  const allSkips: NavigationSkip[] = [];

  // Only process JSX/TSX files for navigation detection
  const jsxFiles = files.filter(f => f.endsWith('.tsx') || f.endsWith('.jsx'));
  const sortedFiles = [...jsxFiles].sort();

  for (const filePath of sortedFiles) {
    const sf = project.getSourceFile(filePath);
    if (!sf) continue;

    const importMap = buildImportMap(sf);

    try {
      passA(sf, filePath, root, importMap, allNavigations, allSkips);
    } catch { /* skip file on parse error */ }

    try {
      passB(sf, filePath, root, allNavigations, allSkips);
    } catch { /* skip file on parse error */ }

    try {
      passC(sf, filePath, root, importMap, allNavigations, allSkips);
    } catch { /* skip file on parse error */ }

    try {
      passD(sf, filePath, root, importMap, allNavigations, allSkips);
    } catch { /* skip file on parse error */ }
  }

  // Post-passes: scope classification → sibling counting → duplicate counting
  const withScope = classifyScope(allNavigations);
  const withSiblings = countSiblings(withScope);
  const withDuplicates = countDuplicates(withSiblings);

  return { navigations: withDuplicates, skips: allSkips };
}
