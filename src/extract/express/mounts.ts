/**
 * Mount-resolution pre-pass for the Express static extractor.
 *
 * Builds a map from each router.METHOD() CallExpression to the set of
 * absolute prefixes it is reachable under, by following:
 *   - app.use(prefix, importedRouter)        — seed mounts
 *   - router.use(subPrefix, subRouter)       — nested mounts
 *   - re-export barrels (export { default as X } from './y')
 *   - same-file Router() bindings
 *
 * Out of scope (skip silently):
 *   - Dynamic mounts: app.use(getRouter())
 *   - Spread mounts:  app.use(...arr)
 *   - Non-relative bare imports (node_modules)
 *   - Class-based / decorator routers
 */

import { existsSync, statSync } from 'node:fs';
import { resolve as nodeResolve, dirname, join } from 'node:path';
import { Node, SyntaxKind, type CallExpression, type Project, type SourceFile } from 'ts-morph';

// ─── Types ────────────────────────────────────────────────────────────────────

type ReexportEntry = { fromPath: string; srcExportName: string };

/**
 * Per-file extracted metadata. Built once per file during the scan phase.
 */
type FileInfo = {
  /** exportName -> localName (for exports of local bindings) */
  exportMap: Map<string, string>;
  /** exportName -> re-export source (for `export { X } from './y'`) */
  reexportMap: Map<string, ReexportEntry>;
  /** local binding name -> import source */
  imports: Map<string, ReexportEntry>;
  /** Set of local names that are bound to a Router() instance */
  routerLocals: Set<string>;
  sf: SourceFile;
};

type RouterBinding = {
  filePath: string;
  localNames: Set<string>;
  fileInfo: FileInfo;
};

// ─── Exported entry point ──────────────────────────────────────────────────────

/**
 * Scans all source files in the ts-morph Project and returns a map from each
 * router.METHOD() CallExpression to the list of absolute prefixes it is
 * reachable under.
 *
 * CallExpressions not in the map had no resolvable mount; callers should emit
 * them with their bare path (backwards-compat fallback).
 */
export function buildMountIndex(project: Project): Map<CallExpression, string[]> {
  const fileCache = new Map<string, FileInfo>();

  for (const sf of project.getSourceFiles()) {
    fileCache.set(sf.getFilePath(), scanFile(sf));
  }

  const prefixMap = new Map<CallExpression, string[]>();

  // Seed scan: find every <x>.use(prefix?, router) in every file
  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    const info = fileCache.get(filePath)!;

    for (const ce of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = ce.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) continue;
      if (expr.getName() !== 'use') continue;

      // Skip if the base object is itself a local Router — this is a nested
      // router.use(subPrefix, subRouter) call that will be handled recursively
      // by walkMountedRouter when the parent router is walked.
      const baseObj = expr.getExpression();
      if (Node.isIdentifier(baseObj) && info.routerLocals.has(baseObj.getText())) continue;

      const args = ce.getArguments();
      if (args.length === 0) continue;

      const { seedPrefix, routerArg } = extractUseArgs(args);
      if (!routerArg) continue;

      const resolved = resolveNode(filePath, routerArg, info, fileCache, project, new Set());
      if (!resolved) continue;

      walkMountedRouter(resolved, seedPrefix, prefixMap, fileCache, project, new Set());
    }
  }

  return prefixMap;
}

// ─── joinPath ─────────────────────────────────────────────────────────────────

/**
 * Joins two path segments into a canonical absolute path.
 *
 * Rules (per spec §3.4):
 *   - Empty/undefined prefix treated as ''
 *   - Trailing '/' stripped from prefix
 *   - sub === '' treated as '/'
 *   - joinPath('/x', '/') === '/x'  (sub=/ with non-empty prefix → prefix only)
 *   - joinPath('', '/x') === '/x'
 *   - Runs of '//' collapsed
 */
export function joinPath(prefix: string, sub: string): string {
  const p = (prefix ?? '').replace(/\/+$/, '');
  const s = sub === '' ? '/' : sub.startsWith('/') ? sub : `/${sub}`;

  if (s === '/' && p !== '') return p;
  const joined = `${p}${s}`;
  return joined.replace(/\/\/+/g, '/') || '/';
}

// ─── resolvePath ──────────────────────────────────────────────────────────────

/**
 * Resolves an import specifier relative to fromFile on disk.
 * Returns null for bare (non-relative) imports or when no file is found.
 *
 * Per spec §3.3: tries literal first (for ESM '.js' extensions pointing to
 * TypeScript files), then appended extensions, then /index variants.
 */
export function resolvePath(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;

  const base = nodeResolve(dirname(fromFile), spec);

  // For NodeNext-style imports: './routes.js' -> try './routes.ts' first
  // (spec §3.6: TS ESM source writes '.js' extensions)
  const baseNoExt = base.replace(/\.(js|mjs|cjs)$/, '');
  const candidates = [
    base,
    `${baseNoExt}.ts`,      // NodeNext: import './routes.js' -> routes.ts
    `${base}.ts`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    join(baseNoExt, 'index.ts'),
    join(base, 'index.ts'),
    join(base, 'index.js'),
    join(base, 'index.mjs'),
    join(base, 'index.cjs'),
  ];

  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {
      // stat failed — skip
    }
  }
  return null;
}

// ─── File scanner ─────────────────────────────────────────────────────────────

function scanFile(sf: SourceFile): FileInfo {
  const routerLocals = new Set<string>();
  const exportMap = new Map<string, string>();
  const reexportMap = new Map<string, ReexportEntry>();
  const imports = new Map<string, ReexportEntry>();

  scanVariableDeclarations(sf, routerLocals, imports);
  scanEsmImports(sf, imports);
  scanEsmExports(sf, exportMap, reexportMap);
  scanEsmDefaultExport(sf, routerLocals, exportMap);
  scanCjsExports(sf, exportMap, reexportMap, imports);

  return { exportMap, reexportMap, imports, routerLocals, sf };
}

function scanVariableDeclarations(
  sf: SourceFile,
  routerLocals: Set<string>,
  imports: Map<string, ReexportEntry>
): void {
  for (const decl of sf.getVariableDeclarations()) {
    const init = decl.getInitializer();
    if (!init) continue;

    if (isRouterCall(init)) routerLocals.add(decl.getName());

    const nameNode = decl.getNameNode();
    const reqPath = extractRequirePath(init);
    if (reqPath === null) continue;

    if (Node.isIdentifier(nameNode)) {
      imports.set(decl.getName(), { fromPath: reqPath, srcExportName: '__default__' });
    } else if (Node.isObjectBindingPattern(nameNode)) {
      for (const el of nameNode.getElements()) {
        if (Node.isOmittedExpression(el)) continue;
        const localName = el.getName();
        const propNode = el.getPropertyNameNode();
        imports.set(localName, { fromPath: reqPath, srcExportName: propNode ? propNode.getText() : localName });
      }
    }
  }
}

function scanEsmImports(sf: SourceFile, imports: Map<string, ReexportEntry>): void {
  for (const imp of sf.getImportDeclarations()) {
    const fromPath = imp.getModuleSpecifierValue();
    const defaultImp = imp.getDefaultImport();
    if (defaultImp) imports.set(defaultImp.getText(), { fromPath, srcExportName: '__default__' });

    for (const named of imp.getNamedImports()) {
      const localName = named.getAliasNode()?.getText() ?? named.getName();
      const srcName = named.getName() === 'default' ? '__default__' : named.getName();
      imports.set(localName, { fromPath, srcExportName: srcName });
    }
  }
}

function scanEsmExports(
  sf: SourceFile,
  exportMap: Map<string, string>,
  reexportMap: Map<string, ReexportEntry>
): void {
  for (const exp of sf.getExportDeclarations()) {
    const moduleSpec = exp.getModuleSpecifierValue();
    if (moduleSpec !== undefined) {
      const namedExports = exp.getNamedExports();
      if (namedExports.length === 0 && !exp.getNamespaceExport()) {
        reexportMap.set('*', { fromPath: moduleSpec, srcExportName: '*' });
      } else {
        for (const named of namedExports) {
          const exportedName = named.getAliasNode()?.getText() ?? named.getName();
          const srcName = named.getName() === 'default' ? '__default__' : named.getName();
          reexportMap.set(exportedName, { fromPath: moduleSpec, srcExportName: srcName });
        }
      }
    } else {
      for (const named of exp.getNamedExports()) {
        const exportedName = named.getAliasNode()?.getText() ?? named.getName();
        const srcName = named.getName() === 'default' ? '__default__' : named.getName();
        exportMap.set(exportedName, srcName);
      }
    }
  }
}

function scanEsmDefaultExport(
  sf: SourceFile,
  routerLocals: Set<string>,
  exportMap: Map<string, string>
): void {
  // Use AST descent rather than getDefaultExportSymbol() — the latter returns
  // undefined for JS files when skipFileDependencyResolution is true.
  for (const ea of sf.getDescendantsOfKind(SyntaxKind.ExportAssignment)) {
    if (ea.isExportEquals()) continue;  // module.exports = x handled in CJS scan
    const expr = ea.getExpression();
    if (Node.isIdentifier(expr)) {
      exportMap.set('__default__', expr.getText());
    } else if (isRouterCall(expr)) {
      routerLocals.add('__default_inline__');
      exportMap.set('__default__', '__default_inline__');
    }
  }
}

function scanCjsExports(
  sf: SourceFile,
  exportMap: Map<string, string>,
  reexportMap: Map<string, ReexportEntry>,
  imports: Map<string, ReexportEntry>
): void {
  for (const bin of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const leftText = bin.getLeft().getText();
    const right = bin.getRight();

    if (leftText === 'module.exports') {
      scanCjsModuleExports(right, exportMap, reexportMap, imports);
    } else if (/^module\.exports\.\w+$/.test(leftText)) {
      const propName = leftText.split('.')[2];
      if (propName && Node.isIdentifier(right)) exportMap.set(propName, right.getText());
    }
  }
}

function scanCjsModuleExports(
  right: Node,
  exportMap: Map<string, string>,
  reexportMap: Map<string, ReexportEntry>,
  imports: Map<string, ReexportEntry>
): void {
  if (Node.isIdentifier(right)) {
    exportMap.set('__default__', right.getText());
  } else if (Node.isObjectLiteralExpression(right)) {
    for (const prop of right.getProperties()) {
      if (Node.isShorthandPropertyAssignment(prop)) {
        exportMap.set(prop.getName(), prop.getName());
      } else if (Node.isPropertyAssignment(prop)) {
        const val = prop.getInitializer();
        if (val && Node.isIdentifier(val)) {
          exportMap.set(prop.getName(), val.getText());
        } else if (val && Node.isCallExpression(val)) {
          const reqPath = extractRequirePath(val);
          if (reqPath !== null) {
            const synth = `__require_${prop.getName()}__`;
            imports.set(synth, { fromPath: reqPath, srcExportName: '__default__' });
            exportMap.set(prop.getName(), synth);
          }
        }
      }
    }
  } else if (isRequireCall(right)) {
    const reqPath = extractRequirePath(right);
    if (reqPath !== null) reexportMap.set('__default__', { fromPath: reqPath, srcExportName: '__default__' });
  }
}

// ─── Resolve helpers ──────────────────────────────────────────────────────────

/**
 * Resolves an export name from a file to a RouterBinding.
 * Follows re-export chains. Returns null when unresolvable or on cycle.
 */
function resolveExport(
  filePath: string,
  exportName: string,
  fileCache: Map<string, FileInfo>,
  project: Project,
  stack: Set<string>
): RouterBinding | null {
  const key = `${filePath}::${exportName}`;
  if (stack.has(key)) {
    console.warn(`[SurfaceMCP] Circular re-export detected at ${key}`);
    return null;
  }
  stack.add(key);

  const info = getFileInfo(filePath, fileCache, project);
  if (!info) return null;

  // 1. Named re-export: export { X as Y } from './p'
  const reentry = info.reexportMap.get(exportName);
  if (reentry) {
    const targetPath = resolvePath(filePath, reentry.fromPath);
    return targetPath ? resolveExport(targetPath, reentry.srcExportName, fileCache, project, stack) : null;
  }

  // 2. Wildcard re-export: export * from './p'
  const wildcardEntry = info.reexportMap.get('*');
  if (wildcardEntry) {
    const targetPath = resolvePath(filePath, wildcardEntry.fromPath);
    if (targetPath) {
      const result = resolveExport(targetPath, exportName, fileCache, project, new Set(stack));
      if (result) return result;
    }
  }

  return resolveLocalExport(filePath, exportName, info, fileCache, project, stack);
}

function resolveLocalExport(
  filePath: string,
  exportName: string,
  info: FileInfo,
  fileCache: Map<string, FileInfo>,
  project: Project,
  stack: Set<string>
): RouterBinding | null {
  const localName = info.exportMap.get(exportName);
  if (!localName) return null;

  if (info.routerLocals.has(localName)) {
    return { filePath, localNames: new Set([localName]), fileInfo: info };
  }

  const imp = info.imports.get(localName);
  if (!imp || !imp.fromPath.startsWith('.')) return null;
  const targetPath = resolvePath(filePath, imp.fromPath);
  return targetPath ? resolveExport(targetPath, imp.srcExportName, fileCache, project, stack) : null;
}

/**
 * Resolves a local identifier name in a file to a RouterBinding.
 */
function resolveIdentifier(
  filePath: string,
  localName: string,
  info: FileInfo,
  fileCache: Map<string, FileInfo>,
  project: Project,
  stack: Set<string>
): RouterBinding | null {
  if (info.routerLocals.has(localName)) {
    return { filePath, localNames: new Set([localName]), fileInfo: info };
  }

  const imp = info.imports.get(localName);
  if (!imp || !imp.fromPath.startsWith('.')) return null;

  const targetPath = resolvePath(filePath, imp.fromPath);
  if (!targetPath) return null;

  return resolveExport(targetPath, imp.srcExportName, fileCache, project, stack);
}

/**
 * Resolves an AST node (Identifier or require() call) to a RouterBinding.
 * Handles both `someVar` and `require('./path')` forms.
 */
function resolveNode(
  filePath: string,
  node: Node,
  info: FileInfo,
  fileCache: Map<string, FileInfo>,
  project: Project,
  stack: Set<string>
): RouterBinding | null {
  if (Node.isIdentifier(node)) {
    return resolveIdentifier(filePath, node.getText(), info, fileCache, project, stack);
  }

  // require('./path') used directly as an argument
  if (Node.isCallExpression(node)) {
    const reqPath = extractRequirePath(node);
    if (reqPath !== null && reqPath.startsWith('.')) {
      const targetPath = resolvePath(filePath, reqPath);
      if (!targetPath) return null;
      return resolveExport(targetPath, '__default__', fileCache, project, stack);
    }
  }

  return null;
}

// ─── Walk mounted router ───────────────────────────────────────────────────────

const HTTP_METHOD_RE = /^(get|post|put|patch|delete|head|options)$/;

/**
 * Recursively walks a RouterBinding and records prefix entries in prefixMap
 * for each router.METHOD() call found.
 */
function walkMountedRouter(
  binding: RouterBinding,
  prefix: string,
  prefixMap: Map<CallExpression, string[]>,
  fileCache: Map<string, FileInfo>,
  project: Project,
  stack: Set<string>
): void {
  const cycleKey = `${binding.filePath}::${[...binding.localNames].sort().join(',')}::${prefix}`;
  if (stack.has(cycleKey)) return;
  stack.add(cycleKey);

  for (const ce of binding.fileInfo.sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = ce.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) continue;
    const obj = expr.getExpression();
    if (!Node.isIdentifier(obj) || !binding.localNames.has(obj.getText())) continue;

    const methodName = expr.getName();
    if (HTTP_METHOD_RE.test(methodName)) {
      recordPrefix(ce, prefix, prefixMap);
    } else if (methodName === 'use') {
      descendNestedUse(ce, binding, prefix, prefixMap, fileCache, project, stack);
    }
  }
}

function recordPrefix(ce: CallExpression, prefix: string, prefixMap: Map<CallExpression, string[]>): void {
  const existing = prefixMap.get(ce);
  if (existing) existing.push(prefix);
  else prefixMap.set(ce, [prefix]);
}

function descendNestedUse(
  ce: CallExpression,
  binding: RouterBinding,
  prefix: string,
  prefixMap: Map<CallExpression, string[]>,
  fileCache: Map<string, FileInfo>,
  project: Project,
  stack: Set<string>
): void {
  const args = ce.getArguments();
  if (args.length === 0) return;
  const { seedPrefix: subPrefix, routerArg } = extractUseArgs(args);
  if (!routerArg) return;
  const childBinding = resolveNode(binding.filePath, routerArg, binding.fileInfo, fileCache, project, new Set());
  if (!childBinding) return;
  walkMountedRouter(childBinding, joinPath(prefix, subPrefix), prefixMap, fileCache, project, new Set(stack));
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Extracts prefix and router-arg from a .use() call's argument list.
 * Handles: .use(router), .use(prefix, router), .use(prefix, mw..., router)
 */
function extractUseArgs(args: Node[]): { seedPrefix: string; routerArg: Node | undefined } {
  if (args.length === 1 && !Node.isStringLiteral(args[0])) {
    return { seedPrefix: '', routerArg: args[0] };
  }

  if (!Node.isStringLiteral(args[0])) {
    return { seedPrefix: '', routerArg: undefined };
  }

  const seedPrefix = args[0].getLiteralValue();
  let routerArg: Node | undefined;

  for (let i = args.length - 1; i >= 1; i--) {
    const a = args[i];
    if (Node.isIdentifier(a) || isRequireCall(a)) {
      routerArg = a;
      break;
    }
  }

  return { seedPrefix, routerArg };
}

function isRouterCall(node: Node): boolean {
  if (!Node.isCallExpression(node)) return false;
  const callee = node.getExpression();
  return /(^|\.)Router$/.test(callee.getText());
}

function isRequireCall(node: Node): boolean {
  if (!Node.isCallExpression(node)) return false;
  const callee = node.getExpression();
  return Node.isIdentifier(callee) && callee.getText() === 'require';
}

function extractRequirePath(node: Node): string | null {
  if (!Node.isCallExpression(node)) return null;
  const callee = node.getExpression();
  if (!Node.isIdentifier(callee) || callee.getText() !== 'require') return null;
  const args = node.getArguments();
  if (args.length !== 1 || !Node.isStringLiteral(args[0])) return null;
  return args[0].getLiteralValue();
}

function getFileInfo(
  filePath: string,
  fileCache: Map<string, FileInfo>,
  project: Project
): FileInfo | null {
  const cached = fileCache.get(filePath);
  if (cached) return cached;

  try {
    const sf = project.addSourceFileAtPath(filePath);
    const info = scanFile(sf);
    fileCache.set(filePath, info);
    return info;
  } catch {
    return null;
  }
}
