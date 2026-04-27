import { describe, it, expect } from 'vitest';
import { joinPath, resolvePath } from './mounts.js';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// ─── joinPath ─────────────────────────────────────────────────────────────────

describe('joinPath', () => {
  it('joins prefix and sub-path', () => {
    expect(joinPath('/api/v1', '/health')).toBe('/api/v1/health');
  });

  it('strips trailing slash from prefix', () => {
    expect(joinPath('/a/', '/b')).toBe('/a/b');
  });

  it('collapses double slashes', () => {
    expect(joinPath('/a', '//b')).toBe('/a/b');
  });

  it('returns prefix when sub is "/" and prefix is non-empty', () => {
    expect(joinPath('/mcp', '/')).toBe('/mcp');
  });

  it('returns "/" when both prefix and sub are empty/slash', () => {
    expect(joinPath('', '/')).toBe('/');
  });

  it('returns sub when prefix is empty', () => {
    expect(joinPath('', '/x')).toBe('/x');
  });

  it('returns prefix when sub is empty string', () => {
    expect(joinPath('/a', '')).toBe('/a');
  });

  it('handles nested paths', () => {
    expect(joinPath('/api/v1', '/items/list')).toBe('/api/v1/items/list');
  });
});

// ─── resolvePath ──────────────────────────────────────────────────────────────

describe('resolvePath', () => {
  const tmp = resolve(tmpdir(), `surfacemcp-mounts-test-${Date.now()}`);

  function setup(): void {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(resolve(tmp, 'routes.ts'), '// stub', 'utf-8');
    writeFileSync(resolve(tmp, 'routes.js'), '// stub js', 'utf-8');
    mkdirSync(resolve(tmp, 'sub'), { recursive: true });
    writeFileSync(resolve(tmp, 'sub', 'index.ts'), '// index', 'utf-8');
  }

  function cleanup(): void {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  }

  it('resolves .ts extension', () => {
    setup();
    const result = resolvePath(resolve(tmp, 'app.ts'), './routes');
    expect(result).toBe(resolve(tmp, 'routes.ts'));
    cleanup();
  });

  it('resolves literal .js extension when .ts does not exist', () => {
    setup();
    // routes.js exists; routes.ts also exists — literal wins (tried first is base, then .ts)
    // Since we try literal first, and base=routes (no ext) → not found, then .ts → found
    const result = resolvePath(resolve(tmp, 'app.ts'), './routes.js');
    expect(result).toBe(resolve(tmp, 'routes.js'));
    cleanup();
  });

  it('resolves directory index', () => {
    setup();
    const result = resolvePath(resolve(tmp, 'app.ts'), './sub');
    expect(result).toBe(resolve(tmp, 'sub', 'index.ts'));
    cleanup();
  });

  it('returns null for bare imports', () => {
    expect(resolvePath('/any/file.ts', 'express')).toBeNull();
    expect(resolvePath('/any/file.ts', 'some-lib/util')).toBeNull();
  });

  it('returns null when file does not exist', () => {
    setup();
    const result = resolvePath(resolve(tmp, 'app.ts'), './nonexistent');
    expect(result).toBeNull();
    cleanup();
  });
});
