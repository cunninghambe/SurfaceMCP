import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import type { ToolMeta, JsonSchema2020, SideEffectClass } from '../../types.js';

type RouteEntry = {
  method: string;
  path: string;
  viewName: string;
  sourceFile: string;
  sourceLine: number;
};

function toolId(method: string, path: string): string {
  return createHash('sha1').update(`${method}:${path}`).digest('hex').slice(0, 12);
}

function pathToToolName(method: string, path: string): string {
  const normalized = path
    .replace(/^\//, '')
    .replace(/[/<>:]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `${method.toLowerCase()}_${normalized || 'root'}`;
}

function methodToSideEffect(method: string): SideEffectClass {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return 'safe';
  return 'mutating';
}

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
  const re = new RegExp(`class\\s+${className}\\b[^:]*:`, 'm');
  const m = re.exec(viewsContent);
  if (!m) return [];
  const after = viewsContent.slice(m.index + m[0].length);
  // Stop at the next top-level (column-0) class or def — those terminate the class block.
  const end = after.search(/^(?:class|def)\s+/m);
  const body = end === -1 ? after : after.slice(0, end);

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

/** Try to load the views file for the current urls.py directory */
function loadViewsContent(urlsFilePath: string): string {
  const dir = dirname(urlsFilePath);
  const viewsPath = resolve(dir, 'views.py');
  if (!existsSync(viewsPath)) return '';
  try {
    return readFileSync(viewsPath, 'utf-8');
  } catch {
    return '';
  }
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

  // Also load sibling views.py to get method info
  const viewsContent = loadViewsContent(filePath);

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

export function extractDjangoRoutes(root: string): ToolMeta[] {
  const rootUrlsFile = findRootUrlsFile(root);
  if (!rootUrlsFile) return [];

  const visited = new Set<string>();
  const rawRoutes = walkUrlsFile(root, rootUrlsFile, '', visited);

  const nameCounts = new Map<string, number>();
  const tools: ToolMeta[] = [];

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
      sideEffectClass: methodToSideEffect(route.method),
      sourceFile: relative(root, route.sourceFile),
      sourceLine: route.sourceLine,
      isServerAction: false,
    });
  }

  return tools;
}
