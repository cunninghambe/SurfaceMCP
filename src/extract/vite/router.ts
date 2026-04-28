// Vite SPA route extractor — spec § 3
// Supports:
//   P1/P2: <Routes>/<Route> JSX (incl. nested + index)
//   P3:    createBrowserRouter([...]) config form
//   P4:    React.lazy() elements

import {
  Project,
  SyntaxKind,
  type SourceFile,
  type Node,
  type JsxAttributeLike,
} from 'ts-morph';
import { glob } from 'tinyglobby';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type { Page, PageSkip, Navigation } from '../../types.js';
import {
  loadPathsMap,
  resolveImportSpecifier,
  tryResolveFile,
  buildImportMap,
  type ImportMap,
  type PathsMap,
} from './util.js';

// ─── types ──────────────────────────────────────────────────────────────────

type LazyEntry = { importPath: string; namedExport?: string };
type LazyMap = Map<string, LazyEntry>;       // varName → { importPath, namedExport? }

// ─── path helpers ────────────────────────────────────────────────────────────

function joinRoute(parent: string, child: string): string {
  if (!child) return parent || '/';
  // If child is already absolute, use as-is
  if (child.startsWith('/')) return child.replace(/\/+/g, '/');
  // If parent is empty, the child is a top-level segment
  if (!parent) return child;
  const combined = parent.endsWith('/')
    ? parent + child
    : parent + '/' + child;
  return combined.replace(/\/+/g, '/');
}

function normRoute(r: string): string {
  if (!r) return '/';
  // Strip trailing slash except root
  if (r !== '/' && r.endsWith('/')) r = r.slice(0, -1);
  // Collapse leading double slashes
  return r.replace(/^\/\/+/, '/');
}

function dynamicParams(route: string): string[] {
  const params: string[] = [];
  const colonRe = /:([A-Za-z_][\w]*)/g;
  let m: RegExpExecArray | null;
  while ((m = colonRe.exec(route)) !== null) params.push(m[1]);
  if (route.includes('*')) params.push('*');
  return params;
}

// ─── JSX attribute helpers ───────────────────────────────────────────────────

function getJsxAttr(attrs: JsxAttributeLike[], name: string): string | undefined {
  for (const attr of attrs) {
    if (attr.getKind() !== SyntaxKind.JsxAttribute) continue;
    const jsxAttr = attr.asKindOrThrow(SyntaxKind.JsxAttribute);
    if (jsxAttr.getNameNode().getText() !== name) continue;
    const init = jsxAttr.getInitializer();
    if (!init) return undefined;
    // "string" literal
    if (init.getKind() === SyntaxKind.StringLiteral) {
      return init.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText();
    }
    // {expr}
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

function getElementTagName(attrs: JsxAttributeLike[]): string | undefined {
  for (const attr of attrs) {
    if (attr.getKind() !== SyntaxKind.JsxAttribute) continue;
    const jsxAttr = attr.asKindOrThrow(SyntaxKind.JsxAttribute);
    if (jsxAttr.getNameNode().getText() !== 'element') continue;
    const init = jsxAttr.getInitializer();
    if (!init) return undefined;
    if (init.getKind() === SyntaxKind.JsxExpression) {
      const expr = init.asKindOrThrow(SyntaxKind.JsxExpression).getExpression();
      if (!expr) return undefined;
      // <Foo /> self-closing
      if (expr.getKind() === SyntaxKind.JsxSelfClosingElement) {
        return expr.asKindOrThrow(SyntaxKind.JsxSelfClosingElement).getTagNameNode().getText();
      }
      // <Foo>...</Foo>
      if (expr.getKind() === SyntaxKind.JsxElement) {
        return expr.asKindOrThrow(SyntaxKind.JsxElement).getOpeningElement().getTagNameNode().getText();
      }
    }
    return undefined;
  }
  return undefined;
}

function isIndexRoute(attrs: JsxAttributeLike[]): boolean {
  return attrs.some(a => {
    if (a.getKind() !== SyntaxKind.JsxAttribute) return false;
    return a.asKindOrThrow(SyntaxKind.JsxAttribute).getNameNode().getText() === 'index';
  });
}

// ─── per-file: collect lazy declarations ─────────────────────────────────────

function buildLazyMap(sf: SourceFile): LazyMap {
  const map: LazyMap = new Map();
  const varDecls = sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
  for (const vd of varDecls) {
    const init = vd.getInitializer();
    if (!init) continue;
    if (init.getKind() !== SyntaxKind.CallExpression) continue;
    const call = init.asKindOrThrow(SyntaxKind.CallExpression);
    const callText = call.getExpression().getText();
    if (!/(?:^|[^A-Za-z])lazy$/.test(callText) && callText !== 'React.lazy') continue;

    const args = call.getArguments();
    if (args.length === 0) continue;
    const arg0 = args[0];
    if (arg0.getKind() !== SyntaxKind.ArrowFunction) continue;
    const arrow = arg0.asKindOrThrow(SyntaxKind.ArrowFunction);
    const body = arrow.getBody();

    // Extract import() call (may be chained with .then)
    let importPath: string | undefined;
    let namedExport: string | undefined;

    // Walk all call expressions inside the arrow to find import(...)
    const callsInArrow = arrow.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const c of callsInArrow) {
      if (c.getExpression().getKind() === SyntaxKind.ImportKeyword) {
        const importArgs = c.getArguments();
        if (importArgs.length > 0 && importArgs[0].getKind() === SyntaxKind.StringLiteral) {
          importPath = importArgs[0].asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText();
        }
      }
    }

    if (!importPath) {
      // Try to get import path from body directly
      if (body.getKind() === SyntaxKind.CallExpression) {
        const bodyCall = body.asKindOrThrow(SyntaxKind.CallExpression);
        // import('...')
        if (bodyCall.getExpression().getKind() === SyntaxKind.ImportKeyword) {
          const importArgs = bodyCall.getArguments();
          if (importArgs.length > 0 && importArgs[0].getKind() === SyntaxKind.StringLiteral) {
            importPath = importArgs[0].asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText();
          }
        }
        // import('...').then(...)
        if (bodyCall.getExpression().getKind() === SyntaxKind.PropertyAccessExpression) {
          const propAccess = bodyCall.getExpression().asKindOrThrow(SyntaxKind.PropertyAccessExpression);
          const receiver = propAccess.getExpression();
          if (receiver.getKind() === SyntaxKind.CallExpression) {
            const innerCall = receiver.asKindOrThrow(SyntaxKind.CallExpression);
            if (innerCall.getExpression().getKind() === SyntaxKind.ImportKeyword) {
              const importArgs = innerCall.getArguments();
              if (importArgs.length > 0 && importArgs[0].getKind() === SyntaxKind.StringLiteral) {
                importPath = importArgs[0].asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText();
              }
            }
          }
        }
      }
    }

    if (!importPath) continue;

    // Extract named export from .then((m) => ({ default: m.NamedExport }))
    const thenCalls = arrow.getDescendantsOfKind(SyntaxKind.CallExpression).filter(c => {
      const expr = c.getExpression();
      return expr.getKind() === SyntaxKind.PropertyAccessExpression &&
        expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getName() === 'then';
    });

    for (const thenCall of thenCalls) {
      const thenArgs = thenCall.getArguments();
      if (thenArgs.length === 0) continue;
      const thenArg = thenArgs[0];
      if (thenArg.getKind() !== SyntaxKind.ArrowFunction) continue;
      const thenBody = thenArg.asKindOrThrow(SyntaxKind.ArrowFunction).getBody();
      // ({ default: m.NamedExport })
      const objLits = [thenBody, ...thenBody.getDescendants()]
        .filter((n): n is Node => n.getKind() === SyntaxKind.ObjectLiteralExpression);
      for (const obj of objLits) {
        const props = obj.asKindOrThrow(SyntaxKind.ObjectLiteralExpression).getProperties();
        for (const prop of props) {
          if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
          const propAssign = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
          if (propAssign.getName() !== 'default') continue;
          const val = propAssign.getInitializer();
          if (val?.getKind() === SyntaxKind.PropertyAccessExpression) {
            namedExport = val.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getName();
          }
        }
      }
    }

    const varName = vd.getName();
    map.set(varName, { importPath, namedExport });
  }
  return map;
}

// ─── resolution ─────────────────────────────────────────────────────────────

function resolveComponent(
  componentName: string,
  lazyMap: LazyMap,
  importMap: ImportMap,
  filePath: string,
  root: string,
  pathsMap: PathsMap
): { sourceFile: string; lazy: boolean; componentName: string } {
  const lazy = lazyMap.get(componentName);
  if (lazy) {
    const resolved = resolveImportSpecifier(lazy.importPath, filePath, root, pathsMap);
    const name = lazy.namedExport ?? componentName;
    return { sourceFile: resolved, lazy: true, componentName: name };
  }

  const importSpec = importMap.get(componentName);
  if (importSpec) {
    const resolved = resolveImportSpecifier(importSpec, filePath, root, pathsMap);
    return { sourceFile: resolved, lazy: false, componentName };
  }

  return { sourceFile: '<unresolved>', lazy: false, componentName };
}

// ─── Pass A: JSX Routes/Route scanning ──────────────────────────────────────

function jsxChildrenHaveIndexRoute(node: Node): boolean {
  const children = node.asKindOrThrow(SyntaxKind.JsxElement).getJsxChildren();
  for (const child of children) {
    if (child.getKind() !== SyntaxKind.JsxSelfClosingElement) continue;
    const sc = child.asKindOrThrow(SyntaxKind.JsxSelfClosingElement);
    if (sc.getTagNameNode().getText() !== 'Route') continue;
    if (isIndexRoute(sc.getAttributes())) return true;
  }
  return false;
}

function walkJsxRoutes(
  node: Node,
  parentPath: string,
  filePath: string,
  root: string,
  lazyMap: LazyMap,
  importMap: ImportMap,
  pathsMap: PathsMap,
  pages: Page[],
  skips: PageSkip[]
): void {
  const kind = node.getKind();

  if (
    kind === SyntaxKind.JsxElement ||
    kind === SyntaxKind.JsxSelfClosingElement
  ) {
    const isJsxEl = kind === SyntaxKind.JsxElement;
    const tagName = isJsxEl
      ? node.asKindOrThrow(SyntaxKind.JsxElement).getOpeningElement().getTagNameNode().getText()
      : node.asKindOrThrow(SyntaxKind.JsxSelfClosingElement).getTagNameNode().getText();

    if (tagName === 'Route') {
      const attrs: JsxAttributeLike[] = isJsxEl
        ? node.asKindOrThrow(SyntaxKind.JsxElement).getOpeningElement().getAttributes()
        : node.asKindOrThrow(SyntaxKind.JsxSelfClosingElement).getAttributes();

      const index = isIndexRoute(attrs);
      const rawPath = index ? undefined : getJsxAttr(attrs, 'path');
      const elementTagName = getElementTagName(attrs);

      const effectivePath = index
        ? parentPath
        : rawPath !== undefined
        ? normRoute(joinRoute(parentPath, rawPath))
        : undefined;

      if (effectivePath === undefined) {
        skips.push({
          route: '<unknown>',
          reason: 'dynamic_path',
          detail: `Non-literal or missing path at ${relative(root, filePath)}:${node.getStartLineNumber()}`,
          declaredAt: { file: relative(root, filePath), line: node.getStartLineNumber() },
        });
      } else if (elementTagName) {
        // § 8.2: suppress layout-only entry when an index child will emit at the same path
        const hasIndexChild = isJsxEl && !index && jsxChildrenHaveIndexRoute(node);
        if (!hasIndexChild) {
          const resolved = resolveComponent(elementTagName, lazyMap, importMap, filePath, root, pathsMap);
          if (resolved.sourceFile === '<unresolved>') {
            skips.push({
              route: effectivePath,
              reason: 'unresolved_component',
              detail: `Could not resolve component ${elementTagName}`,
              declaredAt: { file: relative(root, filePath), line: node.getStartLineNumber() },
            });
          }
          pages.push({
            route: effectivePath,
            sourceFile: resolved.sourceFile,
            componentName: resolved.componentName,
            lazy: resolved.lazy,
            dynamicParams: dynamicParams(effectivePath),
            declaredAt: { file: relative(root, filePath), line: node.getStartLineNumber() },
            source: 'static',
          });
        }
      }

      // Recurse into children for nested routes
      if (isJsxEl && !index) {
        const children = node.asKindOrThrow(SyntaxKind.JsxElement).getJsxChildren();
        for (const child of children) {
          walkJsxRoutes(child, effectivePath ?? parentPath, filePath, root, lazyMap, importMap, pathsMap, pages, skips);
        }
      }
      return;
    }
  }

  // Walk children for non-Route nodes
  for (const child of node.getChildren()) {
    walkJsxRoutes(child, parentPath, filePath, root, lazyMap, importMap, pathsMap, pages, skips);
  }
}

// ─── Pass B: createBrowserRouter scanning ───────────────────────────────────

function processRouteObject(
  obj: Node,
  parentPath: string,
  filePath: string,
  root: string,
  importMap: ImportMap,
  pathsMap: PathsMap,
  pages: Page[],
  skips: PageSkip[],
  project: Project
): void {
  if (obj.getKind() !== SyntaxKind.ObjectLiteralExpression) return;
  const objLit = obj.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
  const props = objLit.getProperties();

  let routePath: string | undefined;
  let elementTagName: string | undefined;
  let isIndex = false;
  let childrenNode: Node | undefined;

  for (const prop of props) {
    if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
    const pa = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
    const propName = pa.getName();
    const init = pa.getInitializer();
    if (!init) continue;

    if (propName === 'path') {
      if (init.getKind() === SyntaxKind.StringLiteral) {
        routePath = init.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText();
      } else {
        skips.push({
          route: '<unknown>',
          reason: 'dynamic_path',
          detail: `Non-literal path in createBrowserRouter at ${relative(root, filePath)}:${obj.getStartLineNumber()}`,
          declaredAt: { file: relative(root, filePath), line: obj.getStartLineNumber() },
        });
      }
    } else if (propName === 'index') {
      isIndex = true;
    } else if (propName === 'element') {
      if (init.getKind() === SyntaxKind.JsxSelfClosingElement) {
        elementTagName = init.asKindOrThrow(SyntaxKind.JsxSelfClosingElement).getTagNameNode().getText();
      } else if (init.getKind() === SyntaxKind.JsxElement) {
        elementTagName = init.asKindOrThrow(SyntaxKind.JsxElement).getOpeningElement().getTagNameNode().getText();
      }
    } else if (propName === 'children') {
      childrenNode = init;
    }
  }

  const effectivePath = isIndex
    ? parentPath
    : routePath !== undefined
    ? normRoute(joinRoute(parentPath, routePath))
    : undefined;

  if (effectivePath !== undefined && elementTagName) {
    // For createBrowserRouter, no lazy map available (the import map from the file handles it)
    const importSpec = importMap.get(elementTagName);
    if (importSpec) {
      const resolved = resolveImportSpecifier(importSpec, filePath, root, pathsMap);
      pages.push({
        route: effectivePath,
        sourceFile: resolved,
        componentName: elementTagName,
        lazy: false,
        dynamicParams: dynamicParams(effectivePath),
        declaredAt: { file: relative(root, filePath), line: obj.getStartLineNumber() },
        source: 'static',
      });
    } else {
      skips.push({
        route: effectivePath,
        reason: 'unresolved_component',
        detail: `Could not resolve component ${elementTagName} in createBrowserRouter`,
        declaredAt: { file: relative(root, filePath), line: obj.getStartLineNumber() },
      });
      pages.push({
        route: effectivePath,
        sourceFile: '<unresolved>',
        componentName: elementTagName,
        lazy: false,
        dynamicParams: dynamicParams(effectivePath),
        declaredAt: { file: relative(root, filePath), line: obj.getStartLineNumber() },
        source: 'static',
      });
    }
  }

  // Recurse into children
  if (childrenNode && childrenNode.getKind() === SyntaxKind.ArrayLiteralExpression) {
    const items = childrenNode.asKindOrThrow(SyntaxKind.ArrayLiteralExpression).getElements();
    for (const item of items) {
      processRouteObject(item, effectivePath ?? parentPath, filePath, root, importMap, pathsMap, pages, skips, project);
    }
  }
}

function processCreateBrowserRouter(
  sf: SourceFile,
  filePath: string,
  root: string,
  importMap: ImportMap,
  pathsMap: PathsMap,
  pages: Page[],
  skips: PageSkip[],
  project: Project
): void {
  const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of calls) {
    const exprText = call.getExpression().getText();
    if (!/(?:^|[^A-Za-z.])createBrowserRouter$/.test(exprText)) continue;

    const args = call.getArguments();
    if (args.length === 0) continue;
    const arg0 = args[0];

    if (arg0.getKind() === SyntaxKind.ArrayLiteralExpression) {
      const items = arg0.asKindOrThrow(SyntaxKind.ArrayLiteralExpression).getElements();
      for (const item of items) {
        processRouteObject(item, '', filePath, root, importMap, pathsMap, pages, skips, project);
      }
    } else if (arg0.getKind() === SyntaxKind.Identifier) {
      // Try to resolve identifier
      const sym = arg0.getSymbol();
      const decl = sym?.getValueDeclaration();
      if (decl) {
        let valueNode: Node | undefined;
        if (decl.getKind() === SyntaxKind.VariableDeclaration) {
          valueNode = decl.asKindOrThrow(SyntaxKind.VariableDeclaration).getInitializer();
        }
        // Unwrap `as` casts
        if (valueNode?.getKind() === SyntaxKind.AsExpression) {
          valueNode = valueNode.asKindOrThrow(SyntaxKind.AsExpression).getExpression();
        }
        if (valueNode?.getKind() === SyntaxKind.ArrayLiteralExpression) {
          const items = valueNode.asKindOrThrow(SyntaxKind.ArrayLiteralExpression).getElements();
          for (const item of items) {
            processRouteObject(item, '', filePath, root, importMap, pathsMap, pages, skips, project);
          }
        } else {
          skips.push({
            route: '<unknown>',
            reason: 'dynamic_route_array',
            detail: `createBrowserRouter argument '${arg0.getText()}' resolved but is not an array literal`,
            declaredAt: { file: relative(root, filePath), line: call.getStartLineNumber() },
          });
        }
      } else {
        skips.push({
          route: '<unknown>',
          reason: 'dynamic_route_array',
          detail: `createBrowserRouter argument '${arg0.getText()}' could not be resolved`,
          declaredAt: { file: relative(root, filePath), line: call.getStartLineNumber() },
        });
      }
    } else {
      skips.push({
        route: '<unknown>',
        reason: 'unsupported_router_arg',
        detail: `Unsupported createBrowserRouter argument type: ${arg0.getKindName()}`,
        declaredAt: { file: relative(root, filePath), line: call.getStartLineNumber() },
      });
    }
  }
}

// ─── tab-state routing detection ────────────────────────────────────────────

function detectTabStateRouting(files: string[]): number {
  let count = 0;
  const re = /window\.history\.pushState\s*\(/g;
  for (const f of files) {
    try {
      const text = readFileSync(f, 'utf-8');
      const matches = text.match(re);
      if (matches) count += matches.length;
    } catch {
      // skip unreadable files
    }
  }
  return count;
}

// ─── deduplication ───────────────────────────────────────────────────────────

function dedup(pages: Page[], skips: PageSkip[]): Page[] {
  const seen = new Map<string, Page>();
  const result: Page[] = [];
  for (const page of pages) {
    if (seen.has(page.route)) {
      skips.push({
        route: page.route,
        reason: 'duplicate_route',
        detail: `Duplicate route ${page.route} — keeping first occurrence`,
        declaredAt: page.declaredAt,
      });
    } else {
      seen.set(page.route, page);
      result.push(page);
    }
  }
  return result;
}

// ─── main extractor ──────────────────────────────────────────────────────────

export async function extractVitePages(root: string): Promise<{ pages: Page[]; skips: PageSkip[] }> {
  const srcDirs = ['src', 'app'].map(d => resolve(root, d));
  const existingSrcDirs = srcDirs.filter(d => existsSync(d));

  const files = (
    await Promise.all(
      existingSrcDirs.map(dir =>
        glob('**/*.{tsx,jsx,ts,js}', {
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

  if (files.length === 0) return { pages: [], skips: [] };

  const pathsMap = loadPathsMap(root);

  const project = new Project({
    compilerOptions: {
      jsx: 4, // ReactJSX
      allowJs: true,
      noEmit: true,
    },
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
  });

  // Add all files to project
  for (const f of files) {
    try {
      project.addSourceFileAtPath(f);
    } catch {
      // skip unparseable files
    }
  }

  const allPages: Page[] = [];
  const allSkips: PageSkip[] = [];

  // Sort files for determinism
  const sortedFiles = [...files].sort();

  for (const filePath of sortedFiles) {
    const sf = project.getSourceFile(filePath);
    if (!sf) continue;

    const lazyMap = buildLazyMap(sf);
    const importMap = buildImportMap(sf);

    // Pass A: JSX routes
    walkJsxRoutes(sf, '', filePath, root, lazyMap, importMap, pathsMap, allPages, allSkips);

    // Pass B: createBrowserRouter
    processCreateBrowserRouter(sf, filePath, root, importMap, pathsMap, allPages, allSkips, project);
  }

  // Deduplication
  const dedupedPages = dedup(allPages, allSkips);

  // Crawl-seed fallback: when no static routes resolved, emit a seed page so
  // BugHunter can discover routes at runtime via link-following.
  if (dedupedPages.length === 0) {
    const pushStateCount = detectTabStateRouting(files);
    const reasonDetail = pushStateCount > 0
      ? `tab-state routing suspected (${pushStateCount} pushState callsites); seeding crawl from /`
      : 'no static routes resolved; seeding crawl from /';

    dedupedPages.push({
      route: '/',
      sourceFile: '<unresolved>',
      componentName: undefined,
      lazy: false,
      dynamicParams: [],
      declaredAt: { file: '<crawl-seed>', line: 0 },
      source: 'crawl_seed',
    });

    allSkips.push({
      route: '/',
      reason: 'crawl_seed_emitted',
      detail: reasonDetail,
    });

    if (pushStateCount > 0) {
      allSkips.push({
        route: '<unknown>',
        reason: 'tab_state_routing_suspected',
        detail: `${pushStateCount} pushState callsites found`,
      });
    }
  }

  // Merge synthetic tab-state pages from navigation extractor
  const { extractViteNavigations } = await import('./navigations.js');
  const { navigations: navs } = await extractViteNavigations(root, project, pathsMap, sortedFiles);
  const syntheticPages = synthesizeTabStatePages(navs);
  for (const sp of syntheticPages) {
    if (!dedupedPages.some(p => p.route === sp.route)) {
      dedupedPages.push(sp);
    }
  }

  // Sort by (route, componentName) for determinism
  dedupedPages.sort((a, b) => {
    const rc = a.route.localeCompare(b.route);
    if (rc !== 0) return rc;
    return (a.componentName ?? '').localeCompare(b.componentName ?? '');
  });

  return { pages: dedupedPages, skips: allSkips };
}

/**
 * Converts tab-state navigations into synthetic Page entries with query-string routes.
 * Called from extractVitePages after navigation extraction completes.
 */
export function synthesizeTabStatePages(navigations: Navigation[]): Page[] {
  const stateNavs = navigations.filter(n => n.kind === 'state' && n.stateVar);
  const result: Page[] = [];
  for (const nav of stateNavs) {
    const route = `/?${encodeURIComponent(nav.stateVar!)}=${encodeURIComponent(nav.target)}`;
    result.push({
      route,
      sourceFile: nav.sourceFile,
      componentName: undefined,
      lazy: false,
      dynamicParams: [],
      declaredAt: { file: nav.sourceFile, line: nav.sourceLine },
      source: 'static',
    });
  }
  return result;
}
