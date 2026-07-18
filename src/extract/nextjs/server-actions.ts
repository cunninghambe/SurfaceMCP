import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { Project, type SourceFile } from 'ts-morph';
import type { RawToolMeta } from '../../types.js';
import {
  classifyFileDirective,
  collectPatternA,
  collectPatternB,
  collectPatternC,
} from './server-actions-collect.js';

export type { ServerActionKind, ServerActionParam, ServerAction } from './server-actions-collect.js';
import type { ServerAction, ServerActionKind } from './server-actions-collect.js';

// ─── Utility ─────────────────────────────────────────────────────────────────

function computeToolId(name: string, definitionFile: string): string {
  return createHash('sha1')
    .update(`serveraction:${name}:${definitionFile}`)
    .digest('hex')
    .slice(0, 12);
}

function sanitizePath(p: string): string {
  return p
    .replace(/\//g, '_')
    .replace(/[^a-z0-9_]/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function walkDir(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, files);
    } else if (
      /\.(ts|tsx|js|jsx)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.includes('.test.') &&
      !entry.name.includes('.spec.')
    ) {
      files.push(full);
    }
  }
  return files;
}

function isApiPath(relFile: string): boolean {
  return (
    relFile.startsWith('app/api/') ||
    relFile.startsWith('src/app/api/') ||
    relFile.startsWith('pages/api/') ||
    relFile.startsWith('src/pages/api/')
  );
}

function readFileSafe(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ─── Merge logic ──────────────────────────────────────────────────────────────

const KIND_PRIORITY: Record<ServerActionKind, number> = {
  'file-level': 2,
  'function-level': 1,
  'form-bound': 0,
};

function mergeInto(byKey: Map<string, ServerAction>, action: ServerAction): void {
  const key = `${action.definitionFile}:${action.name}`;
  const existing = byKey.get(key);
  if (!existing || KIND_PRIORITY[action.kind] > KIND_PRIORITY[existing.kind]) {
    byKey.set(key, action);
  }
}

// ─── Per-file processing ──────────────────────────────────────────────────────

function processFileForAB(
  filePath: string,
  root: string,
  project: Project,
  byKey: Map<string, ServerAction>,
): void {
  const relFile = relative(root, filePath).replace(/\\/g, '/'); // posix form: stable toolIds + sourceFile across OSes
  if (isApiPath(relFile)) return;
  const sf = project.getSourceFile(filePath);
  if (!sf) return;
  const content = readFileSafe(filePath);
  if (content === null) return;

  const fileDirective = classifyFileDirective(sf);
  if (fileDirective === 'use-server') {
    for (const action of collectPatternA(sf, relFile, content)) mergeInto(byKey, action);
  } else if (fileDirective === 'none') {
    for (const action of collectPatternB(sf, relFile, content)) mergeInto(byKey, action);
  }
}

function processFileForC(
  filePath: string,
  root: string,
  project: Project,
  byKey: Map<string, ServerAction>,
): void {
  const relFile = relative(root, filePath).replace(/\\/g, '/'); // posix form: stable toolIds + sourceFile across OSes
  if (isApiPath(relFile)) return;
  if (!/(?:page|layout)\.(ts|tsx|js|jsx)$/.test(relFile)) return;
  const sf = project.getSourceFile(filePath) as SourceFile | undefined;
  if (!sf) return;
  const content = readFileSafe(filePath);
  if (content === null) return;
  for (const action of collectPatternC(sf, relFile, content, byKey)) mergeInto(byKey, action);
}

// ─── Discovery entry point ────────────────────────────────────────────────────

async function findServerActionDefinitions(root: string): Promise<ServerAction[]> {
  const sourceRoots = ['app', 'src/app', 'pages', 'src/pages'].map((r) => resolve(root, r));
  const allFiles: string[] = [];
  for (const dir of sourceRoots) walkDir(dir, allFiles);

  const project = new Project({ useInMemoryFileSystem: false });
  for (const f of allFiles) project.addSourceFileAtPath(f);

  const byKey = new Map<string, ServerAction>();
  for (const f of allFiles) processFileForAB(f, root, project, byKey);
  for (const f of allFiles) processFileForC(f, root, project, byKey);

  return [...byKey.values()];
}

// ─── ToolMeta mapping ─────────────────────────────────────────────────────────

function deriveServerActionPath(action: ServerAction): string {
  if (action.kind === 'form-bound') {
    return `/${action.definitionFile.replace(/\\/g, '/').replace(/\/page\.(ts|tsx|js|jsx)$/, '')}`;
  }
  return `/__action__/${action.definitionFile.replace(/\.(t|j)sx?$/, '')}/${action.name}`;
}

function mapServerActionsToToolMeta(actions: ServerAction[]): RawToolMeta[] {
  return actions.map((action) => ({
    name: `serveraction_${action.name}__${sanitizePath(action.definitionFile)}`,
    toolId: computeToolId(action.name, action.definitionFile),
    method: 'POST',
    path: deriveServerActionPath(action),
    inputSchema: action.schema,
    inputSchemaConfidence: action.schemaConfidence,
    sideEffectClass: 'mutating',
    sourceFile: action.definitionFile,
    sourceLine: action.definitionLine,
    sourceFunctionName: action.name,
    isServerAction: true,
  }));
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function extractServerActions(root: string): Promise<RawToolMeta[]> {
  const actions = await findServerActionDefinitions(root);
  return mapServerActionsToToolMeta(actions);
}
