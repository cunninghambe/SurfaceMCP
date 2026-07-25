import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  isDynamicImportEnabled,
  resolveContainedRealPath,
  importTargetModule,
  resetDynamicImportLogState,
} from './dynamic-import.js';

let dir: string;
let root: string;
let outside: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'surfacemcp-dynimport-'));
  root = join(dir, 'project');
  outside = join(dir, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  resetDynamicImportLogState();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('isDynamicImportEnabled', () => {
  it('is enabled by default and when explicitly true', () => {
    expect(isDynamicImportEnabled({ root: '/p' })).toBe(true);
    expect(isDynamicImportEnabled({ root: '/p', enabled: true })).toBe(true);
  });

  it('is disabled when opted out or when no policy is supplied', () => {
    expect(isDynamicImportEnabled({ root: '/p', enabled: false })).toBe(false);
    expect(isDynamicImportEnabled(undefined)).toBe(false);
  });
});

describe('resolveContainedRealPath', () => {
  it('accepts a file inside the root', () => {
    const f = join(root, 'schema.js');
    writeFileSync(f, 'export const a = 1;');
    expect(resolveContainedRealPath(root, f)).not.toBeNull();
  });

  it('accepts the root itself', () => {
    expect(resolveContainedRealPath(root, root)).not.toBeNull();
  });

  it('rejects a sibling directory reached by ..', () => {
    const f = join(outside, 'evil.js');
    writeFileSync(f, 'export const a = 1;');
    // The kind of specifier an `import * as s from '../../outside/evil'` produces.
    expect(resolveContainedRealPath(root, resolve(root, '..', 'outside', 'evil.js'))).toBeNull();
  });

  it('rejects an absolute path outside the root', () => {
    // Leading-slash form so the case is absolute on POSIX and Windows CI alike.
    expect(resolveContainedRealPath(root, '/etc/passwd')).toBeNull();
  });

  it('rejects a nonexistent path', () => {
    expect(resolveContainedRealPath(root, join(root, 'nope.js'))).toBeNull();
  });

  it('rejects a symlink inside the root that points outside it', () => {
    const target = join(outside, 'evil.js');
    writeFileSync(target, 'export const a = 1;');
    const link = join(root, 'linked.js');
    try {
      symlinkSync(target, link, 'file');
    } catch {
      return; // Windows without developer mode: no symlink privilege, skip.
    }
    expect(resolveContainedRealPath(root, link)).toBeNull();
  });
});

describe('importTargetModule', () => {
  it('returns null when the policy is absent or opted out, without importing', () => {
    const f = join(root, 'boom.js');
    // If this were imported the throw would surface as a rejected promise.
    writeFileSync(f, 'throw new Error("executed");');
    return Promise.all([
      expect(importTargetModule(f, undefined, 't')).resolves.toBeNull(),
      expect(importTargetModule(f, { root, enabled: false }, 't')).resolves.toBeNull(),
    ]);
  });

  it('refuses a module that escapes the surface root', async () => {
    const f = join(outside, 'evil.js');
    writeFileSync(f, 'export const marker = 1;');
    await expect(importTargetModule(f, { root }, 't')).resolves.toBeNull();
  });

  it('swallows an import failure rather than throwing', async () => {
    const f = join(root, 'broken.js');
    writeFileSync(f, 'this is not valid javascript(((');
    await expect(importTargetModule(f, { root }, 't')).resolves.toBeNull();
  });
});
