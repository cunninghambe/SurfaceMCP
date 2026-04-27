import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { detectNextjsDevPort } from './init.js';

function makeTmpProject(devScript: string): string {
  const dir = resolve(tmpdir(), `surfacemcp-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, 'package.json'),
    JSON.stringify({ scripts: { dev: devScript } })
  );
  return dir;
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
  }
});

describe('detectNextjsDevPort', () => {
  it('detects port from -p flag', () => {
    const dir = makeTmpProject('next dev -p 3456');
    tmpDirs.push(dir);
    expect(detectNextjsDevPort(dir)).toBe(3456);
  });

  it('detects port from --port flag', () => {
    const dir = makeTmpProject('next dev --port 4000');
    tmpDirs.push(dir);
    expect(detectNextjsDevPort(dir)).toBe(4000);
  });

  it('detects port from --port= form', () => {
    const dir = makeTmpProject('next dev --port=5000');
    tmpDirs.push(dir);
    expect(detectNextjsDevPort(dir)).toBe(5000);
  });

  it('detects port from PORT=<n> env-var prefix', () => {
    const dir = makeTmpProject('PORT=3456 next dev');
    tmpDirs.push(dir);
    expect(detectNextjsDevPort(dir)).toBe(3456);
  });

  it('returns undefined when next dev has no port flag', () => {
    const dir = makeTmpProject('next dev');
    tmpDirs.push(dir);
    expect(detectNextjsDevPort(dir)).toBeUndefined();
  });

  it('returns undefined when package.json is missing', () => {
    expect(detectNextjsDevPort('/nonexistent-path-xyz')).toBeUndefined();
  });

  it('returns undefined when scripts.dev is not a string', () => {
    const dir = resolve(tmpdir(), `surfacemcp-init-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    tmpDirs.push(dir);
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ scripts: {} }));
    expect(detectNextjsDevPort(dir)).toBeUndefined();
  });
});
