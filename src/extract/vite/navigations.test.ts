import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import { extractViteNavigations } from './navigations.js';
import { extractVitePages } from './router.js';
import { resolve } from 'node:path';

const FIXTURES = resolve(import.meta.dirname, '../../../fixtures');

// Helper: create an in-memory source file with given content and extract navigations
async function extractFromSource(
  code: string,
  filename = 'TestComponent.tsx'
): Promise<Awaited<ReturnType<typeof extractViteNavigations>>> {
  const project = new Project({
    compilerOptions: { jsx: 4, allowJs: true, noEmit: true },
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
  });
  project.createSourceFile(`/root/src/${filename}`, code);

  return extractViteNavigations('/root', project, {}, [`/root/src/${filename}`]);
}

describe('Pass A — <Link>/<NavLink> (router-link)', () => {
  it('link/static-href via Link', async () => {
    const { navigations } = await extractFromSource(`
      import { Link } from 'react-router-dom';
      export function Nav() {
        return <Link to="/about">About</Link>;
      }
    `);
    expect(navigations).toHaveLength(1);
    expect(navigations[0]).toMatchObject({
      method: 'router-link',
      kind: 'url',
      target: '/about',
      label: 'About',
      confidence: 'high',
    });
  });

  it('router-link/dynamic — skip with dynamic_target', async () => {
    const { navigations, skips } = await extractFromSource(`
      import { Link } from 'react-router-dom';
      export function Nav({ path }: { path: string }) {
        return <Link to={path}>Go</Link>;
      }
    `);
    expect(navigations).toHaveLength(0);
    expect(skips.some(s => s.reason === 'dynamic_target')).toBe(true);
  });

  it('router-link/wrong-import — no entry when imported from other module', async () => {
    const { navigations } = await extractFromSource(`
      import { Link } from '../components/Link';
      export function Nav() {
        return <Link to="/x">X</Link>;
      }
    `);
    expect(navigations).toHaveLength(0);
  });

  it('router-link/self-closing — label from last path segment', async () => {
    const { navigations } = await extractFromSource(`
      import { Link } from 'react-router-dom';
      export function Nav() {
        return <Link to="/about" />;
      }
    `);
    expect(navigations).toHaveLength(1);
    expect(navigations[0].target).toBe('/about');
    expect(navigations[0].label).toBe('about');
  });

  it('multiple-callsites-same-target — three Link entries, distinct sourceLines', async () => {
    const { navigations } = await extractFromSource(`
      import { Link } from 'react-router-dom';
      export function Nav() {
        return (
          <div>
            <Link to="/x">X</Link>
            <Link to="/x">X2</Link>
            <Link to="/x">X3</Link>
          </div>
        );
      }
    `);
    expect(navigations).toHaveLength(3);
    const lines = navigations.map(n => n.sourceLine);
    const uniqueLines = new Set(lines);
    expect(uniqueLines.size).toBe(3);
  });
});

describe('Pass B — <a href="..."> (link)', () => {
  it('link/static-href — /about', async () => {
    const { navigations } = await extractFromSource(`
      export function Nav() {
        return <a href="/about">About</a>;
      }
    `);
    expect(navigations).toHaveLength(1);
    expect(navigations[0]).toMatchObject({
      method: 'link',
      kind: 'url',
      target: '/about',
      label: 'About',
      confidence: 'high',
    });
  });

  it('link/external-ignored — https://x.com is not emitted', async () => {
    const { navigations } = await extractFromSource(`
      export function Nav() {
        return <a href="https://x.com">External</a>;
      }
    `);
    expect(navigations).toHaveLength(0);
  });

  it('link/mailto-ignored', async () => {
    const { navigations } = await extractFromSource(`
      export function Nav() {
        return <a href="mailto:x@y.com">Email</a>;
      }
    `);
    expect(navigations).toHaveLength(0);
  });

  it('link/hash — kind:hash', async () => {
    const { navigations } = await extractFromSource(`
      export function Nav() {
        return <a href="#section">Section</a>;
      }
    `);
    expect(navigations).toHaveLength(1);
    expect(navigations[0]).toMatchObject({ kind: 'hash', target: '#section' });
  });

  it('link/no-href — anchor without href is ignored', async () => {
    const { navigations } = await extractFromSource(`
      export function Nav() {
        return <a>No href</a>;
      }
    `);
    expect(navigations).toHaveLength(0);
  });
});

describe('Pass C — useNavigate() (router-push)', () => {
  it('router-push/useNavigate — detects navigate call inside button', async () => {
    const { navigations } = await extractFromSource(`
      import { useNavigate } from 'react-router-dom';
      export function Nav() {
        const navigate = useNavigate();
        return <button onClick={() => navigate('/x')}>X</button>;
      }
    `);
    expect(navigations).toHaveLength(1);
    expect(navigations[0]).toMatchObject({
      method: 'router-push',
      kind: 'url',
      target: '/x',
      label: 'X',
      confidence: 'medium',
    });
  });

  it('router-push/dynamic — template literal skip', async () => {
    const { navigations, skips } = await extractFromSource(`
      import { useNavigate } from 'react-router-dom';
      export function Nav({ id }: { id: string }) {
        const navigate = useNavigate();
        return <button onClick={() => navigate(\`/x/\${id}\`)}>X</button>;
      }
    `);
    expect(navigations).toHaveLength(0);
    expect(skips.some(s => s.reason === 'dynamic_target')).toBe(true);
  });

  it('router-push/aliased — const goTo = useNavigate(); goTo(/x)', async () => {
    const { navigations } = await extractFromSource(`
      import { useNavigate } from 'react-router-dom';
      export function Nav() {
        const goTo = useNavigate();
        return <button onClick={() => goTo('/x')}>X</button>;
      }
    `);
    expect(navigations).toHaveLength(1);
    expect(navigations[0].target).toBe('/x');
  });
});

describe('Pass D — tab-state setter detection (state-setter)', () => {
  it('state-setter/explicit-union — detects all 4 setTab calls', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      type Tab = 'dashboard' | 'trades' | 'settings' | 'profile';
      export function App() {
        const [tab, setTab] = useState<Tab>('dashboard');
        return (
          <div>
            <button onClick={() => setTab('dashboard')}>Dashboard</button>
            <button onClick={() => setTab('trades')}>Trades</button>
            <button data-testid="nav-settings" onClick={() => setTab('settings')}>Settings</button>
            <button aria-label="My profile" onClick={() => setTab('profile')}>Profile</button>
          </div>
        );
      }
    `);
    expect(navigations).toHaveLength(4);
    const targets = navigations.map(n => n.target).sort();
    expect(targets).toEqual(['dashboard', 'profile', 'settings', 'trades']);
    expect(navigations.every(n => n.method === 'state-setter')).toBe(true);
    expect(navigations.every(n => n.kind === 'state')).toBe(true);
    expect(navigations.every(n => n.stateVar === 'tab')).toBe(true);
    expect(navigations.every(n => n.confidence === 'high')).toBe(true);
  });

  it('trigger-label/testid — data-testid captured', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a' | 'b'>('a');
        return <button data-testid="nav-settings" onClick={() => setTab('a')}>A</button>;
      }
    `);
    expect(navigations[0].triggerSelectorHint.testId).toBe('nav-settings');
  });

  it('trigger-label/aria-label — aria-label captured', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a' | 'b'>('a');
        return <button aria-label="Open dashboard" onClick={() => setTab('a')}>A</button>;
      }
    `);
    expect(navigations[0].triggerSelectorHint.ariaLabel).toBe('Open dashboard');
  });

  it('state-setter/inferred-union — useState("home") infers union from callsites', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [view, setView] = useState('home');
        return (
          <div>
            <button onClick={() => setView('home')}>Home</button>
            <button onClick={() => setView('about')}>About</button>
          </div>
        );
      }
    `);
    expect(navigations).toHaveLength(2);
    const targets = navigations.map(n => n.target).sort();
    expect(targets).toEqual(['about', 'home']);
    expect(navigations.every(n => n.confidence === 'medium')).toBe(true);
  });

  it('state-setter/literal-not-in-union — emits confidence:low', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a' | 'b'>('a');
        return <button onClick={() => setTab('mystery')}>Mystery</button>;
      }
    `);
    expect(navigations).toHaveLength(1);
    expect(navigations[0].confidence).toBe('low');
  });

  it('state-setter/dynamic — non-literal arg skip', async () => {
    const { navigations, skips } = await extractFromSource(`
      import { useState } from 'react';
      export function App({ name }: { name: string }) {
        const [tab, setTab] = useState<'a' | 'b'>('a');
        return <button onClick={() => setTab(name as 'a' | 'b')}>Go</button>;
      }
    `);
    expect(navigations).toHaveLength(0);
    expect(skips.some(s => s.reason === 'dynamic_target')).toBe(true);
  });

  it('state-setter/no-trigger — useEffect context skip', async () => {
    const { navigations, skips } = await extractFromSource(`
      import { useState, useEffect } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a' | 'b'>('a');
        useEffect(() => { setTab('b'); }, []);
        return <div>{tab}</div>;
      }
    `);
    expect(navigations).toHaveLength(0);
    expect(skips.some(s => s.reason === 'no_trigger_label')).toBe(true);
  });

  it('state-setter/union-overflow — union with 33 members emits skip', async () => {
    const members = Array.from({ length: 33 }, (_, i) => `'v${i}'`).join(' | ');
    const { navigations, skips } = await extractFromSource(`
      import { useState } from 'react';
      type View = ${members};
      export function App() {
        const [tab, setTab] = useState<View>('v0');
        return <button onClick={() => setTab('v0')}>V0</button>;
      }
    `);
    expect(navigations).toHaveLength(0);
    expect(skips.some(s => s.reason === 'union_overflow')).toBe(true);
  });

  it('state-setter/updater-fn — arrow returning literal skip', async () => {
    const { navigations, skips } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a' | 'b'>('a');
        return <button onClick={() => setTab(prev => prev === 'a' ? 'b' : 'a')}>Toggle</button>;
      }
    `);
    expect(navigations).toHaveLength(0);
    expect(skips.some(s => s.reason === 'dynamic_target')).toBe(true);
  });

  it('trigger-label/nested-jsx — concatenates text descendants', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a' | 'b'>('a');
        return <button onClick={() => setTab('a')}>Go to <strong>Dashboard</strong></button>;
      }
    `);
    expect(navigations).toHaveLength(1);
    expect(navigations[0].label).toContain('Dashboard');
  });
});

describe('Synthetic page emission', () => {
  it('synthetic-page — tab-state produces /?tab=value pages', async () => {
    const root = resolve(FIXTURES, 'vite-tab-state-app');
    const { pages } = await extractVitePages(root);
    const routes = new Set(pages.map(p => p.route));
    expect(routes.has('/?tab=dashboard')).toBe(true);
    expect(routes.has('/?tab=trades')).toBe(true);
    expect(routes.has('/?tab=settings')).toBe(true);
    expect(routes.has('/?tab=profile')).toBe(true);
  });
});

describe('Negative regression — vite-app', () => {
  it('vite-app navigations: no false positives on Routes-based fixture', async () => {
    const root = resolve(FIXTURES, 'vite-app');
    const { navigations } = await extractViteNavigations(root);
    // vite-app uses <Routes>/<Route> — no setTab usage
    const stateSetters = navigations.filter(n => n.method === 'state-setter');
    expect(stateSetters).toEqual([]);
  });

  it('vite-app: surface_list_pages output unchanged (6 pages, no synthetic)', async () => {
    const root = resolve(FIXTURES, 'vite-app');
    const { pages } = await extractVitePages(root);
    const routes = pages.map(p => p.route).sort();
    expect(routes).toEqual(['/', '/about', '/admin', '/admin/settings', '/admin/users', '/users/:id'].sort());
    expect(pages.every(p => !p.route.startsWith('/?'))).toBe(true);
  });
});

describe('Integration — vite-tab-state-app fixture', () => {
  it('discovers all 4 must-discover navigations', async () => {
    const root = resolve(FIXTURES, 'vite-tab-state-app');
    const { navigations } = await extractViteNavigations(root);

    const mustDiscover = [
      { method: 'state-setter' as const, target: 'dashboard', label: 'Dashboard', stateVar: 'tab', confidence: 'high' as const },
      { method: 'state-setter' as const, target: 'trades', label: 'Trades', stateVar: 'tab', confidence: 'high' as const },
      { method: 'state-setter' as const, target: 'settings', label: 'Settings', stateVar: 'tab', confidence: 'high' as const },
      { method: 'state-setter' as const, target: 'profile', label: 'Profile', stateVar: 'tab', confidence: 'high' as const },
    ];

    for (const expected of mustDiscover) {
      const found = navigations.find(n => n.target === expected.target && n.method === expected.method);
      expect(found, `Missing navigation: ${expected.method}/${expected.target}`).toBeDefined();
      expect(found!.label).toBe(expected.label);
      expect(found!.stateVar).toBe(expected.stateVar);
      expect(found!.confidence).toBe(expected.confidence);
    }
  });

  it('nav-settings: data-testid captured', async () => {
    const root = resolve(FIXTURES, 'vite-tab-state-app');
    const { navigations } = await extractViteNavigations(root);
    const settings = navigations.find(n => n.target === 'settings');
    expect(settings?.triggerSelectorHint.testId).toBe('nav-settings');
  });

  it('profile: aria-label captured', async () => {
    const root = resolve(FIXTURES, 'vite-tab-state-app');
    const { navigations } = await extractViteNavigations(root);
    const profile = navigations.find(n => n.target === 'profile');
    expect(profile?.triggerSelectorHint.ariaLabel).toBe('My profile');
  });

  it('synthesizes 4 synthetic pages', async () => {
    const root = resolve(FIXTURES, 'vite-tab-state-app');
    const { pages } = await extractVitePages(root);
    const syntheticRoutes = pages.filter(p => p.route.startsWith('/?'));
    expect(syntheticRoutes).toHaveLength(4);
  });
});
