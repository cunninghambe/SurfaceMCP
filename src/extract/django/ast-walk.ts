import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import type { RawToolMeta, JsonSchema2020, OutputSchemaConfidence } from '../../types.js';
import { toolId, pathToToolName, methodToSideEffect } from '../common.js';
import {
  buildSerializerIndex,
  extractClassBlock,
  serializerSchema,
  type SerializerIndex,
} from './serializers.js';

type RouteEntry = {
  method: string;
  path: string;
  viewName: string;
  outputSchema?: JsonSchema2020;
  outputSchemaConfidence?: OutputSchemaConfidence;
  sourceFile: string;
  sourceLine: number;
};

function normalizeDjangoPath(urlPattern: string): string {
  return urlPattern
    .replace(/<(?:\w+:)?(\w+)>/g, ':$1')
    .replace(/\(\?P<(\w+)>[^)]+\)/g, ':$1');
}

/** Parse path() entries from a urls.py file, returning prefix patterns and view refs */
type ParsedEntry = {
  prefix: string;
  viewRef: string | null;   // null = include()
  includeTarget: string | null;  // module path for include()
  sourceLine: number;
};

function parseUrlsFile(content: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match path('prefix', include(...)) or path('prefix', view)
    const pathMatch = /path\s*\(\s*['"`]([^'"` ]*)['"`]\s*,\s*(.+?)[\s,)]/.exec(line);
    if (!pathMatch) continue;

    const prefix = pathMatch[1];
    const rest = pathMatch[2].trim();

    if (rest.startsWith('include(')) {
      // Extract the include target
      const includeMatch = /include\s*\(\s*['"`]([^'"` ]*)['"`]/.exec(rest);
      if (includeMatch) {
        entries.push({ prefix, viewRef: null, includeTarget: includeMatch[1], sourceLine: i + 1 });
      }
    } else {
      // Direct view reference — strip trailing call invocation (e.g. `.as_view(...)`) so we
      // keep only the dotted class/function path (e.g. `views.ItemListView`).
      const cleanedRef = rest.replace(/\.as_view\b.*$/, '').replace(/\s*\(.*$/, '').replace(/[,\s].*$/, '');
      entries.push({ prefix, viewRef: cleanedRef, includeTarget: null, sourceLine: i + 1 });
    }
  }

  return entries;
}

function methodsForClass(className: string, viewsContent: string): string[] {
  // Class block slicing is shared with the serializer walk (stops at the next
  // column-0 class or def — those terminate the class block).
  const block = extractClassBlock(className, viewsContent);
  if (!block) return [];
  const body = block.body;

  const httpMethodNames = /http_method_names\s*=\s*\[([^\]]+)\]/.exec(body);
  if (httpMethodNames) {
    return httpMethodNames[1]
      .split(',')
      .map((s) => s.trim().replace(/['"]/g, '').toUpperCase())
      .filter((s) => s);
  }

  const methods: string[] = [];
  if (/^\s+def\s+get\s*\(/m.test(body)) methods.push('GET');
  if (/^\s+def\s+post\s*\(/m.test(body)) methods.push('POST');
  if (/^\s+def\s+put\s*\(/m.test(body)) methods.push('PUT');
  if (/^\s+def\s+patch\s*\(/m.test(body)) methods.push('PATCH');
  if (/^\s+def\s+delete\s*\(/m.test(body)) methods.push('DELETE');
  return methods;
}

function guessMethodsFromViewRef(viewRef: string, viewsContent: string): string[] {
  const name = viewRef.split('.').pop() ?? viewRef;
  const nameLower = name.toLowerCase();

  // DRF ViewSet naming conventions
  if (nameLower.includes('listcreate')) return ['GET', 'POST'];
  if (nameLower.includes('retrieveupdatedestroy') || nameLower.includes('retrieveupdate')) return ['GET', 'PUT', 'PATCH', 'DELETE'];
  if (nameLower.includes('retrieve') && !nameLower.includes('update')) return ['GET'];
  if (nameLower.endsWith('list')) return ['GET', 'POST'];
  if (nameLower.includes('create')) return ['POST'];
  if (nameLower.includes('update') && !nameLower.includes('list')) return ['PUT', 'PATCH'];
  if (nameLower.includes('destroy') || nameLower.endsWith('delete')) return ['DELETE'];

  // Scan the target class body in the views file
  const classMethods = methodsForClass(name, viewsContent);
  if (classMethods.length > 0) return classMethods;

  return ['GET', 'POST'];
}

/** Find urls.py file for a given module path (e.g., 'myapp.urls') */
function findUrlsFile(root: string, modulePath: string): string | null {
  const parts = modulePath.replace(/\./g, '/');
  const candidates = [
    resolve(root, parts + '.py'),
    resolve(root, parts, 'urls.py'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Try to load a sibling module of the current urls.py directory */
function loadSiblingModule(urlsFilePath: string, moduleFile: string): string {
  const path = resolve(dirname(urlsFilePath), moduleFile);
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

/** Try to load the views file for the current urls.py directory */
function loadViewsContent(urlsFilePath: string): string {
  return loadSiblingModule(urlsFilePath, 'views.py');
}

// ─── Response typing ──────────────────────────────────────────────────────────

/** Body of one `def <name>(...)` inside a class block, up to the next sibling def. */
function methodBlock(classBody: string, methodName: string): string | null {
  const re = new RegExp(`^([ \\t]+)def\\s+${methodName}\\s*\\(`, 'm');
  const m = re.exec(classBody);
  if (!m) return null;
  const rest = classBody.slice(m.index + m[0].length);
  const end = rest.search(new RegExp(`^[ \\t]{0,${m[1].length}}def\\s+`, 'm'));
  return end === -1 ? rest : rest.slice(0, end);
}

/** True when the route addresses a single object (`/items/:pk/`) rather than a collection. */
function pathTargetsDetail(path: string): boolean {
  const segments = path.split('/').filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  return last !== undefined && last.startsWith(':');
}

/**
 * Response schema for one (view, method) pair, from the view's DRF
 * `serializer_class`. Always 'inferred': a serializer describes the *intended*
 * body, but a view can override `to_representation`, paginate, or return a bare
 * dict, none of which DRF forces to match.
 *
 * The result is wrapped in an array when the view plainly serializes a
 * collection: `Serializer(qs, many=True)` inside the handler (strongest), or a
 * generic `List*` / `*ViewSet` base handling a GET on a collection path.
 * DELETE is skipped outright — DRF's destroy returns 204 with no body.
 */
function resolveViewOutput(
  viewRef: string,
  method: string,
  path: string,
  viewsContent: string,
  serializerIndex: SerializerIndex
): { outputSchema?: JsonSchema2020; outputSchemaConfidence?: OutputSchemaConfidence } {
  if (method === 'DELETE' || method === 'HEAD' || method === 'OPTIONS') return {};
  if (!viewsContent || serializerIndex.size === 0) return {};

  const className = viewRef.split('.').pop();
  if (!className) return {};
  const block = extractClassBlock(className, viewsContent);
  if (!block) return {};

  const declared = /^\s*serializer_class\s*=\s*([A-Za-z_]\w*)/m.exec(block.body);
  if (!declared) return {};
  const serializerName = declared[1];

  const schema = serializerSchema(serializerName, serializerIndex);
  if (!schema || Object.keys(schema.properties ?? {}).length === 0) return {};

  const handlerBody = methodBlock(block.body, method.toLowerCase()) ?? '';
  const manyInHandler = new RegExp(`${serializerName}\\s*\\([^)]*\\bmany\\s*=\\s*True`).test(
    handlerBody
  );
  const listBase = /\bList[A-Za-z]*(?:APIView|View|Mixin)\b|\bViewSet\b/.test(block.header);
  const isCollection = manyInHandler || (method === 'GET' && listBase && !pathTargetsDetail(path));

  return {
    outputSchema: isCollection ? { type: 'array', items: schema } : schema,
    outputSchemaConfidence: 'inferred',
  };
}

function walkUrlsFile(
  root: string,
  filePath: string,
  prefix: string,
  visited: Set<string>
): RouteEntry[] {
  if (visited.has(filePath)) return [];
  visited.add(filePath);

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  // Also load sibling views.py to get method info, and serializers.py for
  // response typing (both optional — a missing file just yields less metadata).
  const viewsContent = loadViewsContent(filePath);
  const serializerIndex = buildSerializerIndex(loadSiblingModule(filePath, 'serializers.py'));

  const entries = parseUrlsFile(content);
  const routes: RouteEntry[] = [];

  for (const entry of entries) {
    const fullPrefix = prefix + entry.prefix;

    if (entry.includeTarget) {
      const includedFile = findUrlsFile(root, entry.includeTarget);
      if (includedFile) {
        routes.push(...walkUrlsFile(root, includedFile, fullPrefix, visited));
      }
      continue;
    }

    if (!entry.viewRef) continue;

    const methods = guessMethodsFromViewRef(entry.viewRef, viewsContent);
    for (const method of methods) {
      const path = '/' + normalizeDjangoPath(fullPrefix);
      routes.push({
        method,
        path,
        viewName: entry.viewRef,
        ...resolveViewOutput(entry.viewRef, method, path, viewsContent, serializerIndex),
        sourceFile: filePath,
        sourceLine: entry.sourceLine,
      });
    }
  }

  return routes;
}

function findRootUrlsFile(root: string): string | null {
  const candidates = [
    resolve(root, 'urls.py'),
    resolve(root, 'config', 'urls.py'),
    resolve(root, 'core', 'urls.py'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // Try to find from settings.py ROOT_URLCONF
  const settingsFiles = [
    resolve(root, 'settings.py'),
    resolve(root, 'config', 'settings.py'),
    resolve(root, 'core', 'settings.py'),
  ];
  for (const sf of settingsFiles) {
    if (!existsSync(sf)) continue;
    try {
      const settings = readFileSync(sf, 'utf-8');
      const match = /ROOT_URLCONF\s*=\s*['"`]([^'"` ]+)['"`]/.exec(settings);
      if (match) {
        const found = findUrlsFile(root, match[1]);
        if (found) return found;
      }
    } catch {
      // skip
    }
  }

  return null;
}

const EMPTY_SCHEMA: JsonSchema2020 = { type: 'object', additionalProperties: true };

export function extractDjangoRoutes(root: string): RawToolMeta[] {
  const rootUrlsFile = findRootUrlsFile(root);
  if (!rootUrlsFile) return [];

  const visited = new Set<string>();
  const rawRoutes = walkUrlsFile(root, rootUrlsFile, '', visited);

  const nameCounts = new Map<string, number>();
  const tools: RawToolMeta[] = [];

  for (const route of rawRoutes) {
    const base = pathToToolName(route.method, route.path);
    const count = nameCounts.get(base) ?? 0;
    nameCounts.set(base, count + 1);
    const name = count === 0 ? base : `${base}_${count + 1}`;

    tools.push({
      name,
      toolId: toolId(route.method, route.path),
      method: route.method,
      path: route.path,
      inputSchema: EMPTY_SCHEMA,
      inputSchemaConfidence: 'unknown',
      ...(route.outputSchema
        ? { outputSchema: route.outputSchema, outputSchemaConfidence: route.outputSchemaConfidence }
        : {}),
      sideEffectClass: methodToSideEffect(route.method),
      sourceFile: relative(root, route.sourceFile),
      sourceLine: route.sourceLine,
      isServerAction: false,
    });
  }

  return tools;
}
