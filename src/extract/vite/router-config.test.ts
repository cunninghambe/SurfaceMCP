// Pattern P3 — createBrowserRouter config form tests

import { describe, it, expect } from 'vitest';
import { extractVitePages } from './router.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeFixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vite-config-test-'));
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

describe('P3 — createBrowserRouter array literal', () => {
  it('extracts routes from array literal', async () => {
    const dir = makeFixtureDir({
      'src/pages/Home.tsx': 'export function Home() { return null; }',
      'src/pages/About.tsx': 'export function About() { return null; }',
      'src/router.tsx': `
import { createBrowserRouter } from 'react-router-dom';
import { Home } from './pages/Home';
import { About } from './pages/About';
export const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  { path: '/about', element: <About /> },
]);`,
    });

    const { pages } = await extractVitePages(dir);
    const routes = pages.map(p => p.route);
    expect(routes).toContain('/');
    expect(routes).toContain('/about');
  });

  it('extracts nested children with correct prefix', async () => {
    const dir = makeFixtureDir({
      'src/pages/AdminLayout.tsx': 'export function AdminLayout() { return null; }',
      'src/pages/AdminUsers.tsx': 'export function AdminUsers() { return null; }',
      'src/router.tsx': `
import { createBrowserRouter } from 'react-router-dom';
import { AdminLayout } from './pages/AdminLayout';
import { AdminUsers } from './pages/AdminUsers';
export const router = createBrowserRouter([
  {
    path: '/admin',
    element: <AdminLayout />,
    children: [
      { path: 'users', element: <AdminUsers /> },
    ],
  },
]);`,
    });

    const { pages } = await extractVitePages(dir);
    const routes = pages.map(p => p.route);
    expect(routes).toContain('/admin');
    expect(routes).toContain('/admin/users');
  });

  it('emits route_unresolved/unsupported_router_arg for non-array arg', async () => {
    const dir = makeFixtureDir({
      'src/router.tsx': `
import { createBrowserRouter } from 'react-router-dom';
function buildRoutes() { return []; }
export const router = createBrowserRouter(buildRoutes());`,
    });

    const { skips } = await extractVitePages(dir);
    const skip = skips.find(s =>
      s.reason === 'unsupported_router_arg' || s.reason === 'dynamic_route_array'
    );
    expect(skip).toBeDefined();
  });
});
