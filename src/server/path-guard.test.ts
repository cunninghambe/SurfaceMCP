import { describe, it, expect } from 'vitest';
import { resolve, sep } from 'node:path';
import { resolveContainedPath } from './path-guard.js';

const ROOT = resolve('/project/app');

describe('resolveContainedPath', () => {
  it('accepts a simple relative path inside root', () => {
    const r = resolveContainedPath(ROOT, 'app/journal/page.tsx');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.absPath).toBe(resolve(ROOT, 'app/journal/page.tsx'));
  });

  it('accepts a nested relative path', () => {
    const r = resolveContainedPath(ROOT, 'src/pages/Home.tsx');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.absPath.startsWith(ROOT + sep)).toBe(true);
  });

  it('rejects an absolute path', () => {
    const abs = resolve('/etc/passwd');
    const r = resolveContainedPath(ROOT, abs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_path');
  });

  it('rejects a parent-traversal escape', () => {
    const r = resolveContainedPath(ROOT, '../../etc/passwd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_path');
  });

  it('rejects a sneaky traversal that climbs then re-descends out of root', () => {
    const r = resolveContainedPath(ROOT, 'sub/../../sibling/secret.txt');
    expect(r.ok).toBe(false);
  });

  it('allows a traversal that stays within root', () => {
    const r = resolveContainedPath(ROOT, 'sub/../keep/file.tsx');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.absPath).toBe(resolve(ROOT, 'keep/file.tsx'));
  });

  it('rejects an empty or non-string path', () => {
    expect(resolveContainedPath(ROOT, '').ok).toBe(false);
    expect(resolveContainedPath(ROOT, undefined).ok).toBe(false);
    expect(resolveContainedPath(ROOT, 123).ok).toBe(false);
  });

  it('rejects a path containing a NUL byte', () => {
    const r = resolveContainedPath(ROOT, 'good\0/../../evil');
    expect(r.ok).toBe(false);
  });

  it('does not treat a sibling directory with a shared prefix as contained', () => {
    // '/project/app-secrets' shares the '/project/app' string prefix but is not inside it.
    const r = resolveContainedPath(ROOT, '../app-secrets/file.tsx');
    expect(r.ok).toBe(false);
  });
});
