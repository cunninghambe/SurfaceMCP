import { spawnSync } from 'node:child_process';
import type { RawToolMeta } from '../../types.js';

/**
 * Fallback extractor using django-extensions' show_urls command.
 * Only runs if django-extensions is installed in the target's venv.
 */
export function extractViaDjangoExtensions(root: string): RawToolMeta[] | null {
  const result = spawnSync(
    'python3',
    ['manage.py', 'show_urls', '--format', 'json'],
    { cwd: root, timeout: 15_000, encoding: 'utf-8' }
  );

  if (result.status !== 0 || !result.stdout) return null;

  try {
    const rows = JSON.parse(result.stdout) as Array<{
      url: string;
      module: string;
      name: string;
    }>;

    return rows.map((row) => ({
      name: `get_${row.name ?? row.url.replace(/\//g, '_')}`,
      toolId: row.url,
      method: 'GET',
      path: row.url,
      inputSchema: { type: 'object', additionalProperties: true },
      inputSchemaConfidence: 'unknown' as const,
      sideEffectClass: 'safe' as const,
      sourceFile: row.module ?? '',
      sourceLine: 0,
      isServerAction: false,
    }));
  } catch {
    return null;
  }
}
