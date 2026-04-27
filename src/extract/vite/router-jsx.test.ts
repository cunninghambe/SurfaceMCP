// Pattern-isolation tests for JSX route parsing (P1, P2, P4)
// Uses real fixture files in a temp directory approach to avoid ts-morph in-memory JSX issues.

import { describe, it, expect } from 'vitest';
import { extractVitePages } from './router.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

function makeFixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vite-router-test-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  // Write a minimal package.json + vite.config.ts so detection would work
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    dependencies: { 'react-router-dom': '^6.0.0' }
  }));
  writeFileSync(join(dir, 'vite.config.ts'), 'export default {}');
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(resolve(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

describe('P1 — simple <Routes>/<Route>', () => {
  it('extracts two static routes', async () => {
    const dir = makeFixtureDir({
      'src/pages/Home.tsx': 'export function Home() { return null; }',
      'src/pages/About.tsx': 'export function About() { return null; }',
      'src/App.tsx': `
import { Routes, Route } from 'react-router-dom';
import { Home } from './pages/Home';
import { About } from './pages/About';
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/about" element={<About />} />
    </Routes>
  );
}`,
    });

    const { pages } = await extractVitePages(dir);
    const routes = pages.map(p => p.route);
    expect(routes).toContain('/');
    expect(routes).toContain('/about');
    expect(pages.find(p => p.route === '/')?.componentName).toBe('Home');
    expect(pages.find(p => p.route === '/about')?.componentName).toBe('About');
  });
});

describe('P2 — nested <Route>', () => {
  it('extracts parent and nested children with correct prefix', async () => {
    const dir = makeFixtureDir({
      'src/pages/AdminLayout.tsx': 'export function AdminLayout() { return null; }',
      'src/pages/AdminUsers.tsx': 'export function AdminUsers() { return null; }',
      'src/pages/AdminSettings.tsx': 'export function AdminSettings() { return null; }',
      'src/App.tsx': `
import { Routes, Route } from 'react-router-dom';
import { AdminLayout } from './pages/AdminLayout';
import { AdminUsers } from './pages/AdminUsers';
import { AdminSettings } from './pages/AdminSettings';
export function App() {
  return (
    <Routes>
      <Route path="/admin" element={<AdminLayout />}>
        <Route path="users" element={<AdminUsers />} />
        <Route path="settings" element={<AdminSettings />} />
      </Route>
    </Routes>
  );
}`,
    });

    const { pages } = await extractVitePages(dir);
    const routes = pages.map(p => p.route).sort();
    expect(routes).toContain('/admin');
    expect(routes).toContain('/admin/users');
    expect(routes).toContain('/admin/settings');
    // No double-slashes
    for (const r of routes) {
      expect(r.includes('//')).toBe(false);
    }
  });

  it('two-level nesting joins correctly', async () => {
    const dir = makeFixtureDir({
      'src/pages/A.tsx': 'export function A() { return null; }',
      'src/pages/B.tsx': 'export function B() { return null; }',
      'src/pages/C.tsx': 'export function C() { return null; }',
      'src/App.tsx': `
import { Routes, Route } from 'react-router-dom';
import { A } from './pages/A';
import { B } from './pages/B';
import { C } from './pages/C';
export function App() {
  return (
    <Routes>
      <Route path="/a" element={<A />}>
        <Route path="b" element={<B />}>
          <Route path="c" element={<C />} />
        </Route>
      </Route>
    </Routes>
  );
}`,
    });

    const { pages } = await extractVitePages(dir);
    const routes = pages.map(p => p.route);
    expect(routes).toContain('/a');
    expect(routes).toContain('/a/b');
    expect(routes).toContain('/a/b/c');
  });

  it('index route uses parent path', async () => {
    const dir = makeFixtureDir({
      'src/pages/AdminLayout.tsx': 'export function AdminLayout() { return null; }',
      'src/pages/AdminIndex.tsx': 'export function AdminIndex() { return null; }',
      'src/App.tsx': `
import { Routes, Route } from 'react-router-dom';
import { AdminLayout } from './pages/AdminLayout';
import { AdminIndex } from './pages/AdminIndex';
export function App() {
  return (
    <Routes>
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminIndex />} />
      </Route>
    </Routes>
  );
}`,
    });

    const { pages } = await extractVitePages(dir);
    const adminRoutes = pages.filter(p => p.route === '/admin');
    // Both parent layout and index route may emit at /admin — spec says emit both
    expect(adminRoutes.length).toBeGreaterThanOrEqual(1);
    // At least one AdminIndex entry at /admin
    expect(adminRoutes.some(p => p.componentName === 'AdminIndex')).toBe(true);
  });
});

describe('P4 — React.lazy()', () => {
  it('marks lazy component with lazy: true', async () => {
    const dir = makeFixtureDir({
      'src/pages/About.tsx': 'export function About() { return null; }',
      'src/App.tsx': `
import React, { lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
const About = lazy(() => import('./pages/About').then((m) => ({ default: m.About })));
export function App() {
  return (
    <Routes>
      <Route path="/about" element={<About />} />
    </Routes>
  );
}`,
    });

    const { pages } = await extractVitePages(dir);
    const about = pages.find(p => p.route === '/about');
    expect(about).toBeDefined();
    expect(about?.lazy).toBe(true);
  });

  it('resolves componentName from named-export .then shape', async () => {
    const dir = makeFixtureDir({
      'src/pages/Privacy.tsx': 'export function PrivacyPage() { return null; }',
      'src/App.tsx': `
import { lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
const Privacy = lazy(() => import('./pages/Privacy').then((m) => ({ default: m.PrivacyPage })));
export function App() {
  return (
    <Routes>
      <Route path="/privacy" element={<Privacy />} />
    </Routes>
  );
}`,
    });

    const { pages } = await extractVitePages(dir);
    const privacy = pages.find(p => p.route === '/privacy');
    expect(privacy).toBeDefined();
    expect(privacy?.componentName).toBe('PrivacyPage');
    expect(privacy?.lazy).toBe(true);
  });

  it('falls back to lazy variable name when no .then namedExport', async () => {
    const dir = makeFixtureDir({
      'src/pages/Home.tsx': 'export default function Home() { return null; }',
      'src/App.tsx': `
import React from 'react';
import { Routes, Route } from 'react-router-dom';
const Home = React.lazy(() => import('./pages/Home'));
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
    expect(home?.lazy).toBe(true);
    expect(home?.componentName).toBe('Home');
  });
});
