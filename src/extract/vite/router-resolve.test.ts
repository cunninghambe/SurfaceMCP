// Component import resolution tests

import { describe, it, expect } from 'vitest';
import { extractVitePages } from './router.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeFixtureDir(files: Record<string, string>, tsconfig?: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'vite-resolve-test-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    dependencies: { 'react-router-dom': '^6.0.0' }
  }));
  writeFileSync(join(dir, 'vite.config.ts'), 'export default {}');
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig ?? { compilerOptions: {} }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

describe('component resolution', () => {
  it('resolves component via tsconfig paths @/', async () => {
    const dir = makeFixtureDir(
      {
        'src/pages/Home.tsx': 'export function Home() { return null; }',
        'src/App.tsx': `
import { Routes, Route } from 'react-router-dom';
import { Home } from '@/pages/Home';
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
    </Routes>
  );
}`,
      },
      {
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['src/*'] },
        },
      }
    );

    const { pages } = await extractVitePages(dir);
    const home = pages.find(p => p.route === '/');
    expect(home).toBeDefined();
    expect(home?.sourceFile).toBe('src/pages/Home.tsx');
  });

  it('resolves component via directory index.tsx', async () => {
    const dir = makeFixtureDir({
      'src/pages/Home/index.tsx': 'export function Home() { return null; }',
      'src/App.tsx': `
import { Routes, Route } from 'react-router-dom';
import { Home } from './pages/Home';
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
    </Routes>
  );
}`,
    });

    const { pages } = await extractVitePages(dir);
    const home = pages.find(p => p.route === '/');
    expect(home).toBeDefined();
    expect(home?.sourceFile).toContain('index.tsx');
  });

  it('unresolvable component gets sourceFile: "<unresolved>" and emits skip', async () => {
    const dir = makeFixtureDir({
      'src/App.tsx': `
import { Routes, Route } from 'react-router-dom';
import { Ghost } from './pages/Ghost';
export function App() {
  return (
    <Routes>
      <Route path="/ghost" element={<Ghost />} />
    </Routes>
  );
}`,
    });

    const { pages, skips } = await extractVitePages(dir);
    const ghost = pages.find(p => p.route === '/ghost');
    expect(ghost).toBeDefined();
    expect(ghost?.sourceFile).toBe('<unresolved>');
    expect(skips.some(s => s.reason === 'unresolved_component')).toBe(true);
  });
});
