import { readdirSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { Project } from 'ts-morph';
import type { RawToolMeta } from '../../types.js';
import { tryImportZodSchema, extractManualValidationSchemaFromFile } from './schemas.js';
import type { DynamicImportPolicy } from '../dynamic-import.js';
import { resolveNextResponseSchemas, type ResponseTypeResult } from './response-type.js';
import { toolId, pathToToolName, methodToSideEffect } from '../common.js';
import { indexSourceFiles } from '../ts-type-schema.js';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
type HttpMethod = typeof HTTP_METHODS[number];

// App/Pages Router bracket params -> `:param`. Applied before toolId/pathToToolName,
// so the shared helpers receive an already-normalized path (identical output).
function normalizePath(p: string): string {
  return p.replace(/\[\.\.\.(\w+)\]/g, ':$1').replace(/\[(\w+)\]/g, ':$1');
}

/**
 * Convert a filesystem path under app/api or pages/api to an HTTP path.
 * Handles Next.js App Router and Pages Router naming conventions.
 */
function filePathToApiPath(filePath: string, apiRootRelative: string): string {
  // Remove the api root prefix and file extension
  let path = filePath
    .replace(apiRootRelative, '')
    .replace(/\\/g, '/')
    .replace(/\.(ts|tsx|js|jsx)$/, '')
    .replace(/\/route$/, '') // App Router: route.ts
    .replace(/\/index$/, ''); // Pages Router: index.ts

  if (!path.startsWith('/')) path = '/' + path;

  // Normalize dynamic segments
  path = normalizePath(path);

  // Prefix with /api if not already there
  if (!path.startsWith('/api')) {
    path = '/api' + path;
  }

  return path || '/';
}

/**
 * Response schemas for one route file. Parsing is scoped to the single file: a
 * response type imported from elsewhere won't resolve and is reported as no
 * schema rather than a wrong one. Failures degrade to `{}` — response typing
 * must never break route discovery.
 */
function responseSchemasForFile(
  project: Project,
  filePath: string
): { perMethod: Map<string, ResponseTypeResult>; fallback: ResponseTypeResult } {
  try {
    const sf = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
    const ctx = indexSourceFiles([sf], { includeShapes: true });
    return resolveNextResponseSchemas(sf, ctx);
  } catch {
    return { perMethod: new Map(), fallback: {} };
  }
}

async function extractMethodsFromFile(
  filePath: string,
  apiPath: string,
  sourceRoot: string,
  project: Project,
  zodAlias?: string,
  dynamicImport?: DynamicImportPolicy
): Promise<RawToolMeta[]> {
  const tools: RawToolMeta[] = [];

  // Detect exported HTTP method handlers by file content
  const { readFileSync } = await import('node:fs');
  let content = '';
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return tools;
  }

  const detectedMethods: HttpMethod[] = [];

  for (const method of HTTP_METHODS) {
    // App Router: `export async function GET(` or `export function GET(`
    // Pages Router: `export default function handler(req` (all methods)
    const appRouterPattern = new RegExp(
      `export\\s+(?:async\\s+)?function\\s+${method}\\s*\\(`
    );
    if (appRouterPattern.test(content)) {
      detectedMethods.push(method);
    }
  }

  // Pages Router default export handles all methods
  if (detectedMethods.length === 0 && /export\s+default\s+/.test(content)) {
    detectedMethods.push('GET', 'POST');
  }

  const zodResult = await tryImportZodSchema(filePath, zodAlias, dynamicImport);
  const { schema, confidence } =
    zodResult.confidence !== 'unknown'
      ? zodResult
      : await extractManualValidationSchemaFromFile(filePath);
  const sourceFile = relative(sourceRoot, filePath);
  const { perMethod, fallback } = responseSchemasForFile(project, filePath);

  // Find approximate source line for the handler
  const lines = content.split('\n');

  for (const method of detectedMethods) {
    const lineIdx = lines.findIndex((l) => new RegExp(`function\\s+${method}\\s*\\(`).test(l));
    const sourceLine = lineIdx >= 0 ? lineIdx + 1 : 1;
    // App Router: per-verb export. Pages Router: one handler for every verb.
    const output = perMethod.get(method) ?? fallback;

    tools.push({
      name: '', // filled in by dedup
      toolId: toolId(method, apiPath),
      method,
      path: apiPath,
      inputSchema: schema,
      inputSchemaConfidence: confidence,
      ...(output.outputSchema
        ? { outputSchema: output.outputSchema, outputSchemaConfidence: output.outputSchemaConfidence }
        : {}),
      sideEffectClass: methodToSideEffect(method),
      sourceFile,
      sourceLine,
      isServerAction: false,
    });
  }

  return tools;
}

function walkDir(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, files);
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.includes('.test.') && !entry.name.includes('.spec.')) {
      files.push(full);
    }
  }
  return files;
}

export async function extractNextjsRoutes(
  root: string,
  zodAlias?: string,
  /** #target-code-exec: `false` disables the schema-introspection dynamic import. */
  allowDynamicImport = true
): Promise<RawToolMeta[]> {
  const rawTools: RawToolMeta[] = [];
  const dynamicImport: DynamicImportPolicy = { root, enabled: allowDynamicImport };

  // One ts-morph Project shared by every route file, used only for response
  // typing; input-schema recovery keeps its own (dynamic-import) path.
  const project = new Project({
    useInMemoryFileSystem: false,
    skipFileDependencyResolution: true,
  });

  // App Router: app/api/**
  const appApiDir = resolve(root, 'app', 'api');
  const appApiFiles = walkDir(appApiDir);
  for (const file of appApiFiles) {
    // Only process route.ts files in App Router
    const posixFile = file.replace(/\\/g, '/'); // walkDir yields OS-native separators; match on posix
    if (!posixFile.endsWith('/route.ts') && !posixFile.endsWith('/route.js')) continue;
    const apiPath = filePathToApiPath(file, appApiDir);
    const tools = await extractMethodsFromFile(file, apiPath, root, project, zodAlias, dynamicImport);
    rawTools.push(...tools);
  }

  // Pages Router: pages/api/**
  const pagesApiDir = resolve(root, 'pages', 'api');
  const pagesApiFiles = walkDir(pagesApiDir);
  for (const file of pagesApiFiles) {
    const apiPath = filePathToApiPath(file, pagesApiDir);
    const tools = await extractMethodsFromFile(file, apiPath, root, project, zodAlias, dynamicImport);
    rawTools.push(...tools);
  }

  // Also check src/app/api and src/pages/api
  const srcAppApiDir = resolve(root, 'src', 'app', 'api');
  const srcAppApiFiles = walkDir(srcAppApiDir);
  for (const file of srcAppApiFiles) {
    const posixFile = file.replace(/\\/g, '/'); // walkDir yields OS-native separators; match on posix
    if (!posixFile.endsWith('/route.ts') && !posixFile.endsWith('/route.js')) continue;
    const apiPath = filePathToApiPath(file, srcAppApiDir);
    const tools = await extractMethodsFromFile(file, apiPath, root, project, zodAlias, dynamicImport);
    rawTools.push(...tools);
  }

  const srcPagesApiDir = resolve(root, 'src', 'pages', 'api');
  const srcPagesApiFiles = walkDir(srcPagesApiDir);
  for (const file of srcPagesApiFiles) {
    const apiPath = filePathToApiPath(file, srcPagesApiDir);
    const tools = await extractMethodsFromFile(file, apiPath, root, project, zodAlias, dynamicImport);
    rawTools.push(...tools);
  }

  return deduplicateTools(rawTools);
}

function deduplicateTools(tools: RawToolMeta[]): RawToolMeta[] {
  const nameCounts = new Map<string, number>();
  return tools.map((tool) => {
    const base = pathToToolName(tool.method, tool.path);
    const count = nameCounts.get(base) ?? 0;
    nameCounts.set(base, count + 1);
    const name = count === 0 ? base : `${base}_${count + 1}`;
    return { ...tool, name };
  });
}
