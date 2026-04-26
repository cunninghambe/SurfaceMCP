import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

let envCache: Record<string, string> | null = null;

function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const lines = readFileSync(path, 'utf-8').split('\n');
  const result: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = val;
  }
  return result;
}

/** Load .env.local then .env from a project root, merging into process.env. */
export function loadEnvFiles(projectRoot: string): void {
  if (envCache) return;
  const local = loadEnvFile(resolve(projectRoot, '.env.local'));
  const base = loadEnvFile(resolve(projectRoot, '.env'));
  envCache = { ...base, ...local };
  Object.assign(process.env, envCache);
}

/** Replace all $env:VAR occurrences in a value string with the env value. */
export function resolveEnvVar(value: string): string {
  return value.replace(/\$env:([A-Z0-9_]+)/gi, (_, key: string) => {
    return process.env[key] ?? '';
  });
}

/** Recursively resolve $env:VAR in all string values of a credentials object. */
export function resolveCredentials(
  credentials: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(credentials)) {
    result[k] = resolveEnvVar(v);
  }
  return result;
}
