import { describe, it, expect } from 'vitest';
import { loadSampleInputs } from './fixture-loader.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

describe('surface_sample_inputs', () => {
  it('reads JSON fixtures from co-located test file', () => {
    const tmp = resolve(tmpdir(), `surface-samples-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });

    const routeFile = resolve(tmp, 'route.ts');
    const testFile = resolve(tmp, 'route.test.ts');

    writeFileSync(routeFile, 'export async function POST() {}');
    writeFileSync(
      testFile,
      `
      it('creates a user', async () => {
        const res = await fetch('/api/users', {
          method: 'POST',
          body: JSON.stringify({ name: 'Alice', email: 'alice@test.local' }),
        });
        expect(res.ok).toBe(true);
      });
      `
    );

    try {
      const samples = loadSampleInputs('route.ts', tmp);
      expect(samples.length).toBeGreaterThan(0);
      expect(samples[0]?.input).toMatchObject({ name: 'Alice', email: 'alice@test.local' });
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('returns empty array when no test files exist', () => {
    const samples = loadSampleInputs('nonexistent/route.ts', '/tmp');
    expect(samples).toEqual([]);
  });
});
