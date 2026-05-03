import { readdirSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { Project, SyntaxKind, type CallExpression, type SourceFile } from 'ts-morph';
import type { RawToolMeta, SideEffectClass } from '../../types.js';
import { resolveRouteSchema } from './schema-scope.js';
import { buildMountIndex, joinPath } from './mounts.js';

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

const HTTP_METHOD_RE = /\.(get|post|put|patch|delete|head|options)\s*$/;

/**
 * Extracts route calls from a single SourceFile using an existing ts-morph Project.
 * Returns raw RouteCall objects; path prefixes are applied by the caller.
 */
function extractRouteCalls(sf: SourceFile, filePath: string): RouteCall[] {
  const routes: RouteCall[] = [];

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const text = expr.getText();
    const methodMatch = HTTP_METHOD_RE.exec(text);
    if (!methodMatch) continue;

    const args = call.getArguments();
    if (args.length === 0) continue;

    const firstArg = args[0];
    const pathText = firstArg.getText().replace(/^['"`]|['"`]$/g, '');
    if (!pathText.startsWith('/')) continue;

    routes.push({
      method: methodMatch[1].toUpperCase(),
      path: pathText,
      sourceFile: filePath,
      sourceLine: call.getStartLineNumber(),
      callNode: call,
      sf,
    });
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
): Promise<RawToolMeta[]> {
  const schemaConfig = bodyValidatorNames ? { bodyValidatorNames } : undefined;
  const allFiles = walkDir(root);

  // One Project for the entire extraction — shared by mount index + schema scope
  const project = new Project({
    useInMemoryFileSystem: false,
    skipFileDependencyResolution: true,
  });
  for (const file of allFiles) {
    project.addSourceFileAtPath(file);
  }

  // Build mount prefix map: CallExpression -> string[] of absolute prefixes
  const mountIndex = buildMountIndex(project);

  // Collect all raw route calls across all files
  const rawRoutes: RouteCall[] = [];
  for (const sf of project.getSourceFiles()) {
    rawRoutes.push(...extractRouteCalls(sf, sf.getFilePath()));
  }

  const nameCounts = new Map<string, number>();
  const tools: RawToolMeta[] = [];

  for (const route of rawRoutes) {
    const { callNode, sf } = route;

    // Determine the prefixes for this call node
    const prefixes = callNode ? (mountIndex.get(callNode) ?? null) : null;

    // Build the list of (method, path) pairs to emit
    const emissions: { method: string; path: string }[] =
      prefixes !== null
        ? prefixes.map((p) => ({ method: route.method, path: joinPath(p, route.path) }))
        : [{ method: route.method, path: route.path }];

    for (const { method, path } of emissions) {
      const { schema, confidence } =
        callNode && sf
          ? await resolveRouteSchema(callNode, sf, method, schemaConfig)
          : { schema: { type: 'object', additionalProperties: true } as const, confidence: 'unknown' as const };

      const base = pathToToolName(method, path);
      const count = nameCounts.get(base) ?? 0;
      nameCounts.set(base, count + 1);
      const name = count === 0 ? base : `${base}_${count + 1}`;

      tools.push({
        name,
        toolId: toolId(method, path),
        method,
        path,
        inputSchema: schema,
        inputSchemaConfidence: confidence,
        sideEffectClass: methodToSideEffect(method),
        sourceFile: relative(root, route.sourceFile),
        sourceLine: route.sourceLine,
        isServerAction: false,
      });
    }
  }

  void zodAlias; // reserved for future zod alias config
  return tools;
}
