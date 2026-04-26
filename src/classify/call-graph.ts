import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { SideEffectClass } from '../types.js';

const EXTERNAL_LIBS = new Set([
  'stripe',
  '@sendgrid/mail',
  'sendgrid',
  'easypost',
  'cloudinary',
  '@aws-sdk',
  'twilio',
  'mailgun',
  'postmark',
  'pusher',
  'algoliasearch',
  'plaid',
]);

function isExternalImport(importPath: string): boolean {
  for (const lib of EXTERNAL_LIBS) {
    if (importPath.startsWith(lib)) return true;
  }
  return false;
}

function extractImports(content: string): string[] {
  const imports: string[] = [];

  // ES import: import ... from '...' / import '...'
  const esImportPattern = /\bimport\s+(?:[^'"` ]*\s+from\s+)?['"`]([^'"` ]+)['"`]/g;
  let match: RegExpExecArray | null;
  while ((match = esImportPattern.exec(content)) !== null) {
    imports.push(match[1]);
  }

  // CJS require: require('...')
  const requirePattern = /\brequire\s*\(\s*['"`]([^'"` ]+)['"`]\s*\)/g;
  while ((match = requirePattern.exec(content)) !== null) {
    imports.push(match[1]);
  }

  return imports;
}

/**
 * One-hop call-graph classification.
 * If the handler directly imports an external lib → 'external'.
 * If the handler imports a local module that imports an external lib → still 'mutating' (conservative).
 * This is intentionally conservative per spec § 3.8.
 */
export function classifyByCallGraph(
  sourceFile: string,
  root: string,
  baseMethod: string,
  confirmedExternalPaths: string[]
): SideEffectClass {
  if (['GET', 'HEAD', 'OPTIONS'].includes(baseMethod)) return 'safe';

  const absSource = resolve(root, sourceFile);
  if (!existsSync(absSource)) return 'mutating';

  // Check if file is in a confirmed external integration path
  for (const extPath of confirmedExternalPaths) {
    if (sourceFile.includes(extPath.replace(/\*\*?/, ''))) return 'external';
  }

  let content: string;
  try {
    content = readFileSync(absSource, 'utf-8');
  } catch {
    return 'mutating';
  }

  const imports = extractImports(content);

  // Direct import of external lib → external
  for (const imp of imports) {
    if (isExternalImport(imp)) return 'external';
  }

  // One-hop: check local imports for external lib imports
  const localImports = imports.filter((imp) => imp.startsWith('.'));
  for (const localImp of localImports) {
    const localPath = resolve(dirname(absSource), localImp);
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];
    for (const ext of extensions) {
      const fullPath = localPath + ext;
      if (!existsSync(fullPath)) continue;
      try {
        const localContent = readFileSync(fullPath, 'utf-8');
        const localImports2 = extractImports(localContent);
        for (const imp2 of localImports2) {
          if (isExternalImport(imp2)) return 'mutating'; // conservative: one-hop = mutating not external
        }
      } catch {
        // skip
      }
      break;
    }
  }

  return 'mutating';
}
