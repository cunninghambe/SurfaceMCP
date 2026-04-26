import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

// Replicate toolId logic from routes.ts for testing
function toolId(method: string, path: string): string {
  return createHash('sha1').update(`${method}:${path}`).digest('hex').slice(0, 12);
}

describe('tool naming and collision', () => {
  it('toolId is stable sha1 hash', () => {
    const id1 = toolId('GET', '/api/users');
    const id2 = toolId('GET', '/api/users');
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{12}$/);
  });

  it('different method+path produces different toolId', () => {
    expect(toolId('GET', '/api/users')).not.toBe(toolId('POST', '/api/users'));
    expect(toolId('GET', '/api/users')).not.toBe(toolId('GET', '/api/products'));
  });

  it('name collision deduplication: two routes resolving to same name get distinct names', async () => {
    // Simulate two routes that would produce the same name
    // We test the extract module's dedup logic
    const { extractNextjsRoutes } = await import('../extract/nextjs/routes.js');
    const { resolve } = await import('node:path');

    const root = resolve(import.meta.dirname, '../../fixtures/nextjs-app');
    const tools = await extractNextjsRoutes(root);

    // All names must be unique
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});
