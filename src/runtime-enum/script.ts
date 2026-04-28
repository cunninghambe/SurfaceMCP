import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_ENUM_VERSION = 1;

let cachedScript: string | null = null;

export function getRuntimeEnumScript(): string {
  if (cachedScript !== null) return cachedScript;

  // Load the plain-JS script file; it must not be transpiled.
  // __dirname equivalent for ESM:
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = resolve(scriptDir, 'script.runtime.js');
  cachedScript = readFileSync(scriptPath, 'utf-8');
  return cachedScript;
}
