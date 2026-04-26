import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Project, SyntaxKind } from 'ts-morph';

function hasExpressInDeps(root: string): boolean {
  const pkgPath = resolve(root, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as unknown;
    if (pkg === null || typeof pkg !== 'object') return false;
    const p = pkg as Record<string, unknown>;
    const deps = {
      ...(p.dependencies as Record<string, unknown> | undefined ?? {}),
      ...(p.devDependencies as Record<string, unknown> | undefined ?? {}),
    };
    return 'express' in deps;
  } catch {
    return false;
  }
}

function hasExpressRoutes(root: string): boolean {
  // Look for app.get/post/put/delete patterns in common entry files
  const candidates = [
    resolve(root, 'src/app.ts'),
    resolve(root, 'src/app.js'),
    resolve(root, 'src/index.ts'),
    resolve(root, 'src/index.js'),
    resolve(root, 'app.ts'),
    resolve(root, 'app.js'),
    resolve(root, 'index.ts'),
    resolve(root, 'index.js'),
    resolve(root, 'server.ts'),
    resolve(root, 'server.js'),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const project = new Project({ useInMemoryFileSystem: false });
      const sf = project.addSourceFileAtPath(candidate);
      const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
      for (const call of calls) {
        const expr = call.getExpression().getText();
        if (/app\.(get|post|put|delete|patch|use)\b/.test(expr)) return true;
      }
    } catch {
      // fall back to text search
      try {
        const text = readFileSync(candidate, 'utf-8');
        if (/app\.(get|post|put|delete|patch|use)\s*\(/.test(text)) return true;
      } catch {
        // skip
      }
    }
  }
  return false;
}

export function isExpress(root: string): boolean {
  return hasExpressInDeps(root) && hasExpressRoutes(root);
}
