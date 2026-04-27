import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

describe('Fixture next build', () => {
  it('compiles cleanly', () => {
    const fixtureRoot = path.resolve(import.meta.dirname, '../../fixtures/nextjs-app');
    const result = spawnSync('npm', ['run', 'build'], {
      cwd: fixtureRoot,
      encoding: 'utf-8',
      timeout: 180_000,
      env: { ...process.env, CI: '1', NEXT_TELEMETRY_DISABLED: '1' },
    });
    if (result.status !== 0) {
      console.error('next build STDOUT:', result.stdout);
      console.error('next build STDERR:', result.stderr);
    }
    expect(result.status).toBe(0);
  }, 200_000);
});
