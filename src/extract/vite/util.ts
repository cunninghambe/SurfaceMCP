// Shared helpers for Vite extractor modules.
// Extracted from router.ts to avoid circular imports between router.ts and navigations.ts.

import { type SourceFile, SyntaxKind } from 'ts-morph';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative, dirname, join } from 'node:path';

export type ImportMap = Map<string, string>;   // localName → module specifier
export type PathsMap = Record<string, string[]>; // tsconfig paths

// ─── tsconfig path resolution ─────────────────────────────────────────────────

export function loadPathsMap(root: string): PathsMap {
  const tsconfigPath = resolve(root, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(tsconfigPath, 'utf-8')) as {
      compilerOptions?: { paths?: Record<string, string[]> };
    };
    return raw.compilerOptions?.paths ?? {};
  } catch {
    return {};
  }
}

export function resolveImportSpecifier(
  spec: string,
  fromFile: string,
  root: string,
  pathsMap: PathsMap
): string {
  const exts = ['.tsx', '.ts', '.jsx', '.js'];

  for (const [alias, targets] of Object.entries(pathsMap)) {
    const prefix = alias.replace(/\*$/, '');
    if (spec.startsWith(prefix)) {
      const suffix = spec.slice(prefix.length);
      for (const target of targets) {
        const targetDir = target.replace(/\*$/, '');
        const candidate = resolve(root, targetDir + suffix);
        const found = tryResolveFile(candidate, exts);
        if (found) return relative(root, found).replace(/\\/g, '/');
      }
    }
  }

  if (spec.startsWith('@/')) {
    const suffix = spec.slice(2);
    const candidate = resolve(root, 'src', suffix);
    const found = tryResolveFile(candidate, exts);
    if (found) return relative(root, found).replace(/\\/g, '/');
  }

  if (spec.startsWith('.')) {
    const candidate = resolve(dirname(fromFile), spec);
    const found = tryResolveFile(candidate, exts);
    if (found) return relative(root, found).replace(/\\/g, '/');
  }

  return '<unresolved>';
}

export function tryResolveFile(base: string, exts: string[]): string | undefined {
  for (const ext of exts) {
    if (base.endsWith(ext) && existsSync(base)) return base;
  }
  for (const ext of exts) {
    const candidate = base + ext;
    if (existsSync(candidate)) return candidate;
  }
  for (const ext of exts) {
    const candidate = join(base, `index${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

// ─── per-file: collect static import map ─────────────────────────────────────

export function buildImportMap(sf: SourceFile): ImportMap {
  const map: ImportMap = new Map();
  for (const imp of sf.getImportDeclarations()) {
    if (imp.isTypeOnly()) continue;
    const modSpec = imp.getModuleSpecifierValue();
    const defaultImport = imp.getDefaultImport();
    if (defaultImport) map.set(defaultImport.getText(), modSpec);
    for (const named of imp.getNamedImports()) {
      if (named.isTypeOnly()) continue;
      const alias = named.getAliasNode()?.getText() ?? named.getName();
      map.set(alias, modSpec);
    }
  }
  return map;
}

// ─── JSX attribute string literal helper ─────────────────────────────────────

export function getJsxStringAttr(
  node: { getKind(): number; asKindOrThrow: (k: number) => unknown },
  attrs: Array<{ getKind(): number; asKindOrThrow: (k: number) => unknown }>,
  name: string
): string | undefined {
  for (const attr of attrs) {
    if (attr.getKind() !== SyntaxKind.JsxAttribute) continue;
    const jsxAttr = attr.asKindOrThrow(SyntaxKind.JsxAttribute) as {
      getNameNode(): { getText(): string };
      getInitializer(): { getKind(): number; asKindOrThrow: (k: number) => unknown } | undefined;
    };
    if (jsxAttr.getNameNode().getText() !== name) continue;
    const init = jsxAttr.getInitializer();
    if (!init) return undefined;
    if (init.getKind() === SyntaxKind.StringLiteral) {
      return (init.asKindOrThrow(SyntaxKind.StringLiteral) as { getLiteralText(): string }).getLiteralText();
    }
    if (init.getKind() === SyntaxKind.JsxExpression) {
      const expr = (init.asKindOrThrow(SyntaxKind.JsxExpression) as {
        getExpression(): { getKind(): number; asKindOrThrow: (k: number) => unknown } | undefined;
      }).getExpression();
      if (expr?.getKind() === SyntaxKind.StringLiteral) {
        return (expr.asKindOrThrow(SyntaxKind.StringLiteral) as { getLiteralText(): string }).getLiteralText();
      }
    }
    return undefined;
  }
  return undefined;
}
