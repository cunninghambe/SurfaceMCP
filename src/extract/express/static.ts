import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { Project, SyntaxKind, type CallExpression, type SourceFile } from 'ts-morph';
import type { ToolMeta, SideEffectClass } from '../../types.js';
import { resolveRouteSchema } from './schema-scope.js';

function toolId(method: string, path: string): string {
  return createHash('sha1')
    .update(`${method}:${normalizePath(path)}`)
    .digest('hex')
    .slice(0, 12);
}

function normalizePath(p: string): string {
  return p.replace(/:(\w+)/g, ':$1');
}

function pathToToolName(method: string, path: string): string {
  const normalized = normalizePath(path)
    .replace(/^\//, '')
    .replace(/[/:]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `${method.toLowerCase()}_${normalized || 'root'}`;
}

function methodToSideEffect(method: string): SideEffectClass {
  if (['get', 'head', 'options'].includes(method.toLowerCase())) return 'safe';
  return 'mutating';
}

type RouteCall = {
  method: string;
  path: string;
  sourceFile: string;
  sourceLine: number;
  callNode?: CallExpression;
  sf?: SourceFile;
};

function extractRoutesFromFile(filePath: string): RouteCall[] {
  const routes: RouteCall[] = [];
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return routes;
  }

  try {
    const project = new Project({ useInMemoryFileSystem: false });
    const sf = project.addSourceFileAtPath(filePath);
    const calls: CallExpression[] = sf.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const call of calls) {
      const expr = call.getExpression();
      const text = expr.getText();
      const methodMatch = /\.(get|post|put|patch|delete|head|options)\s*$/.exec(text);
      if (!methodMatch) continue;

      const args = call.getArguments();
      if (args.length === 0) continue;

      const firstArg = args[0];
      const pathText = firstArg.getText().replace(/^['"`]|['"`]$/g, '');
      if (!pathText.startsWith('/')) continue;

      const pos = call.getStartLineNumber();
      routes.push({
        method: methodMatch[1].toUpperCase(),
        path: pathText,
        sourceFile: filePath,
        sourceLine: pos,
        callNode: call,
        sf,
      });
    }
  } catch {
    // Fall back to regex — no AST nodes available
    const routePattern = /\.(get|post|put|patch|delete)\s*\(['"`]([^'"` ]+)['"`]/gi;
    let match: RegExpExecArray | null;
    const lines = content.split('\n');
    while ((match = routePattern.exec(content)) !== null) {
      const lineIdx = content.slice(0, match.index).split('\n').length;
      if (!match[2].startsWith('/')) continue;
      routes.push({
        method: match[1].toUpperCase(),
        path: match[2],
        sourceFile: filePath,
        sourceLine: lineIdx,
      });
    }
    void lines;
  }

  return routes;
}

function walkDir(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
      walkDir(full, files);
    } else if (/\.(ts|js)$/.test(entry.name) && !entry.name.includes('.test.') && !entry.name.includes('.spec.')) {
      files.push(full);
    }
  }
  return files;
}

export async function extractExpressRoutes(
  root: string,
  zodAlias?: string,
  bodyValidatorNames?: string[]
): Promise<ToolMeta[]> {
  const schemaConfig = bodyValidatorNames ? { bodyValidatorNames } : undefined;
  const allFiles = walkDir(root);
  const rawRoutes: RouteCall[] = [];

  for (const file of allFiles) {
    rawRoutes.push(...extractRoutesFromFile(file));
  }

  const nameCounts = new Map<string, number>();
  const tools: ToolMeta[] = [];

  for (const route of rawRoutes) {
    const { schema, confidence } =
      route.callNode && route.sf
        ? await resolveRouteSchema(route.callNode, route.sf, route.method, schemaConfig)
        : { schema: { type: 'object', additionalProperties: true } as const, confidence: 'unknown' as const };

    const base = pathToToolName(route.method, route.path);
    const count = nameCounts.get(base) ?? 0;
    nameCounts.set(base, count + 1);
    const name = count === 0 ? base : `${base}_${count + 1}`;

    tools.push({
      name,
      toolId: toolId(route.method, route.path),
      method: route.method,
      path: route.path,
      inputSchema: schema,
      inputSchemaConfidence: confidence,
      sideEffectClass: methodToSideEffect(route.method),
      sourceFile: relative(root, route.sourceFile),
      sourceLine: route.sourceLine,
      isServerAction: false,
    });
  }

  return tools;
}
