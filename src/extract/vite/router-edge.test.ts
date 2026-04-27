// Edge case tests for the Vite route extractor

import { describe, it, expect } from 'vitest';
import { extractVitePages } from './router.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeFixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vite-edge-test-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    dependencies: { 'react-router-dom': '^6.0.0' }
  }));
  writeFileSync(join(dir, 'vite.config.ts'), 'export default {}');
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

describe('edge cases', () => {
  it('dynamic path attribute emits dynamic_path skip', async () => {
    const dir = makeFixtureDir({
      'src/pages/X.tsx': 'export function X() { return null; }',
      'src/App.tsx': `
import { Routes, Route } from 'react-router-dom';
import { X } from './pages/X';
const DYNAMIC_PATH = '/dynamic';
export function App() {
  return (
    <Routes>
      <Route path={DYNAMIC_PATH} element={<X />} />
    </Routes>
  );
}`,
    });

    const { skips } = await extractVitePages(dir);
    expect(skips.some(s => s.reason === 'dynamic_path')).toBe(true);
  });

  it('splat route has dynamicParams: ["*"]', async () => {
    const dir = makeFixtureDir({
      'src/pages/NotFound.tsx': 'export function NotFound() { return null; }',
      'src/App.tsx': `
import { Routes, Route } from 'react-router-dom';
import { NotFound } from './pages/NotFound';
export function App() {
  return (
    <Routes>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}`,
    });

    const { pages } = await extractVitePages(dir);
    const splat = pages.find(p => p.route === '*');
    expect(splat).toBeDefined();
    expect(splat?.dynamicParams).toContain('*');
  });

  it('optional segment /foo? is preserved as authored', async () => {
    const dir = makeFixtureDir({
      'src/pages/Foo.tsx': 'export function Foo() { return null; }',
      'src/App.tsx': `
import { Routes, Route } from 'react-router-dom';
import { Foo } from './pages/Foo';
export function App() {
  return (
    <Routes>
      <Route path="/foo?" element={<Foo />} />
    </Routes>
  );
}`,
    });

    const { pages } = await extractVitePages(dir);
    const foo = pages.find(p => p.route === '/foo?');
    expect(foo).toBeDefined();
  });

  it('duplicate route emits duplicate_route skip for second occurrence', async () => {
    const dir = makeFixtureDir({
      'src/pages/Home.tsx': 'export function Home() { return null; }',
      'src/pages/HomeAlt.tsx': 'export function HomeAlt() { return null; }',
      'src/App.tsx': `
import { Routes, Route } from 'react-router-dom';
import { Home } from './pages/Home';
import { HomeAlt } from './pages/HomeAlt';
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/" element={<HomeAlt />} />
    </Routes>
  );
}`,
    });

    const { pages, skips } = await extractVitePages(dir);
    // Only one page for '/'
    expect(pages.filter(p => p.route === '/').length).toBe(1);
    // First is kept
    expect(pages.find(p => p.route === '/')?.componentName).toBe('Home');
    // Skip emitted for second
    expect(skips.some(s => s.reason === 'duplicate_route')).toBe(true);
  });
});
