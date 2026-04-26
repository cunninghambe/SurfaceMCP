import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export type SampleInput = {
  source: string;
  input: unknown;
};

/**
 * Find co-located test files for a route handler and extract literal input fixtures.
 */
export function loadSampleInputs(sourceFile: string, root: string): SampleInput[] {
  const absSource = resolve(root, sourceFile);
  const dir = dirname(absSource);
  const samples: SampleInput[] = [];

  // Look for *.test.ts, *.spec.ts in the same directory
  let entries: string[] = [];
  try {
    entries = readdirSync(dir).filter((f) =>
      /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f)
    );
  } catch {
    return samples;
  }

  for (const entry of entries) {
    const testPath = resolve(dir, entry);
    if (!existsSync(testPath)) continue;

    let content: string;
    try {
      content = readFileSync(testPath, 'utf-8');
    } catch {
      continue;
    }

    const extracted = extractFixturesFromTestContent(content, testPath);
    samples.push(...extracted);
  }

  return samples;
}

/**
 * Extract JSON object literals from test file content.
 * Looks for patterns like:
 * - fetch('/api/...', { method: 'POST', body: JSON.stringify({...}) })
 * - { body: JSON.stringify({...}) }
 * - const input = { ... }
 */
function extractFixturesFromTestContent(content: string, testPath: string): SampleInput[] {
  const samples: SampleInput[] = [];

  // Pattern: JSON.stringify({ ... }) — capture the object literal
  const jsonStringifyPattern = /JSON\.stringify\(\s*(\{[^}]+\})\s*\)/g;
  let match: RegExpExecArray | null;

  while ((match = jsonStringifyPattern.exec(content)) !== null) {
    try {
      // Use a safe eval approximation — parse as relaxed JSON
      const objStr = match[1]
        .replace(/(\w+)\s*:/g, '"$1":')    // quote keys
        .replace(/'/g, '"')               // single to double quotes
        .replace(/,\s*}/g, '}');           // trailing commas
      const parsed = JSON.parse(objStr) as unknown;
      samples.push({ source: testPath, input: parsed });
    } catch {
      // skip malformed
    }
  }

  // Pattern: const fixture = { ... } or const input = { ... }
  const fixtureVarPattern = /const\s+(?:fixture|input|payload|body|data)\s*=\s*(\{[^}]+\})/g;
  while ((match = fixtureVarPattern.exec(content)) !== null) {
    try {
      const objStr = match[1]
        .replace(/(\w+)\s*:/g, '"$1":')
        .replace(/'/g, '"')
        .replace(/,\s*}/g, '}');
      const parsed = JSON.parse(objStr) as unknown;
      samples.push({ source: testPath, input: parsed });
    } catch {
      // skip
    }
  }

  return samples;
}
