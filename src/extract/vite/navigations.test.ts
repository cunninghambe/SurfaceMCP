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
  it('emits no synthetic /?<state>= pages — state lives only in navigations', async () => {
    const root = resolve(FIXTURES, 'vite-tab-state-app');
    const { pages } = await extractVitePages(root);
    expect(pages.every(p => !p.route.startsWith('/?'))).toBe(true);
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

});

// ─── Hint quality: preferred selector ────────────────────────────────────────

describe('hint quality — preferred selector', () => {
  it('preferred = testId when testId present', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a'|'b'>('a');
        return <button data-testid="nav-a" onClick={() => setTab('a')}>A</button>;
      }
    `);
    expect(navigations[0].triggerSelectorHint.preferred).toBe('testId');
  });

  it('preferred = ariaLabel when only ariaLabel present', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a'|'b'>('a');
        return <button aria-label="Navigate A" onClick={() => setTab('a')}></button>;
      }
    `);
    expect(navigations[0].triggerSelectorHint.preferred).toBe('ariaLabel');
  });

  it('preferred = text when only text present', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a'|'b'>('a');
        return <button onClick={() => setTab('a')}>Go A</button>;
      }
    `);
    expect(navigations[0].triggerSelectorHint.preferred).toBe('text');
  });

  it('preferred = title when only title present', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a'|'b'>('a');
        return <button title="Switch to A" onClick={() => setTab('a')}></button>;
      }
    `);
    expect(navigations[0].triggerSelectorHint.preferred).toBe('title');
  });

  it('preferred = testId beats all when all present', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a'|'b'>('a');
        return (
          <button
            data-testid="nav-a"
            aria-label="Navigate A"
            title="Switch to A"
            onClick={() => setTab('a')}
          >
            Go A
          </button>
        );
      }
    `);
    expect(navigations[0].triggerSelectorHint.preferred).toBe('testId');
    expect(navigations[0].triggerSelectorHint.testId).toBe('nav-a');
    expect(navigations[0].triggerSelectorHint.ariaLabel).toBe('Navigate A');
    expect(navigations[0].triggerSelectorHint.title).toBe('Switch to A');
    expect(navigations[0].triggerSelectorHint.text).toBe('Go A');
  });

  it('preferred = undefined when no hint present', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a'|'b'>('a');
        return <button onClick={() => setTab('a')}></button>;
      }
    `);
    expect(navigations[0].triggerSelectorHint.preferred).toBeUndefined();
  });
});

// ─── Hint quality: title attribute fallback ───────────────────────────────────

describe('hint quality — title attribute fallback', () => {
  it('extracts title="..." as a hint when textContent is empty', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a'|'b'>('a');
        return (
          <button title="Switch to B" onClick={() => setTab('b')}></button>
        );
      }
    `);
    expect(navigations).toHaveLength(1);
    expect(navigations[0].triggerSelectorHint.title).toBe('Switch to B');
    expect(navigations[0].triggerSelectorHint.preferred).toBe('title');
  });
});

// ─── Scope classification ─────────────────────────────────────────────────────

describe('scope classification', () => {
  async function extractMultiFile(files: Record<string, string>) {
    const project = new Project({
      compilerOptions: { jsx: 4, allowJs: true, noEmit: true },
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
    });
    const fileList: string[] = [];
    for (const [name, code] of Object.entries(files)) {
      const path = `/root/src/${name}`;
      project.createSourceFile(path, code);
      fileList.push(path);
    }
    return extractViteNavigations('/root', project, {}, fileList);
  }

  it('classifies state-setter in App.tsx as top-level', async () => {
    const { navigations } = await extractMultiFile({
      'App.tsx': `
        import { useState } from 'react';
        type Tab = 'a' | 'b';
        export function App() {
          const [tab, setTab] = useState<Tab>('a');
          return (
            <div>
              <button onClick={() => setTab('a')}>A</button>
              <button onClick={() => setTab('b')}>B</button>
            </div>
          );
        }
      `,
    });
    expect(navigations.every(n => n.scope === 'top-level')).toBe(true);
  });

  it('classifies state-setter in pages/Dashboard.tsx as page-local', async () => {
    const { navigations } = await extractMultiFile({
      'App.tsx': `
        import { useState } from 'react';
        type Tab = 'dashboard' | 'settings';
        export function App() {
          const [tab, setTab] = useState<Tab>('dashboard');
          return (
            <div>
              <button onClick={() => setTab('dashboard')}>Dashboard</button>
              <button onClick={() => setTab('settings')}>Settings</button>
            </div>
          );
        }
      `,
      'pages/Dashboard.tsx': `
        import { useState } from 'react';
        type Range = 'monthly' | 'hour';
        export function Dashboard() {
          const [range, setRange] = useState<Range>('monthly');
          return (
            <div>
              <button onClick={() => setRange('monthly')}>monthly</button>
              <button onClick={() => setRange('hour')}>hour</button>
            </div>
          );
        }
      `,
    });
    const appNavs = navigations.filter(n => n.sourceFile.includes('App.tsx'));
    const dashNavs = navigations.filter(n => n.sourceFile.includes('Dashboard.tsx'));
    expect(appNavs.every(n => n.scope === 'top-level')).toBe(true);
    expect(dashNavs.every(n => n.scope === 'page-local')).toBe(true);
  });

  it('classifies <Link> in pages/Dashboard.tsx as top-level (URL navs are always top-level)', async () => {
    const { navigations } = await extractMultiFile({
      'App.tsx': `
        import { useState } from 'react';
        type Tab = 'a' | 'b';
        export function App() {
          const [tab, setTab] = useState<Tab>('a');
          return <div><button onClick={() => setTab('a')}>A</button><button onClick={() => setTab('b')}>B</button></div>;
        }
      `,
      'pages/Dashboard.tsx': `
        import { Link } from 'react-router-dom';
        export function Dashboard() {
          return <Link to="/about">About</Link>;
        }
      `,
    });
    const linkNav = navigations.find(n => n.method === 'router-link');
    expect(linkNav?.scope).toBe('top-level');
  });

  it('classifies <a href="#x"> as top-level (hash navs)', async () => {
    const { navigations } = await extractFromSource(`
      export function Nav() {
        return <a href="#section">Section</a>;
      }
    `);
    expect(navigations[0].scope).toBe('top-level');
  });

  it('falls back to top-level when neither App.tsx nor pages/ convention found', async () => {
    const { navigations } = await extractMultiFile({
      'Foo.tsx': `
        import { useState } from 'react';
        export function Foo() {
          const [x, setX] = useState<'a'|'b'>('a');
          return <button onClick={() => setX('a')}>A</button>;
        }
      `,
    });
    expect(navigations[0].scope).toBe('top-level');
  });
});

// ─── Sibling-navigation counting ─────────────────────────────────────────────

describe('siblingNavigations counting', () => {
  it('siblingNavigations = 0 when text is unique in scope', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a'|'b'>('a');
        return (
          <div>
            <button onClick={() => setTab('a')}>UniqueA</button>
            <button onClick={() => setTab('b')}>UniqueB</button>
          </div>
        );
      }
    `);
    expect(navigations.every(n => n.siblingNavigations === 0)).toBe(true);
  });

  it('siblingNavigations = 2 when 3 navs share text in same scope', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      type R = 'a' | 'b' | 'c';
      export function App() {
        const [r, setR] = useState<R>('a');
        return (
          <div>
            <button onClick={() => setR('a')}>Save</button>
            <button onClick={() => setR('b')}>Save</button>
            <button onClick={() => setR('c')}>Save</button>
          </div>
        );
      }
    `);
    expect(navigations.every(n => n.siblingNavigations === 2)).toBe(true);
  });

  it('siblingNavigations counts case-insensitively after trim', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a'|'b'>('a');
        return (
          <div>
            <button onClick={() => setTab('a')}>Save</button>
            <button onClick={() => setTab('b')}>  save  </button>
          </div>
        );
      }
    `);
    expect(navigations.every(n => n.siblingNavigations === 1)).toBe(true);
  });

  it('siblingNavigations is per-scope, not global', async () => {
    const project = new Project({
      compilerOptions: { jsx: 4, allowJs: true, noEmit: true },
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
    });
    project.createSourceFile('/root/src/App.tsx', `
      import { useState } from 'react';
      type Tab = 'a' | 'b';
      export function App() {
        const [tab, setTab] = useState<Tab>('a');
        return (
          <div>
            <button onClick={() => setTab('a')}>About</button>
            <button onClick={() => setTab('b')}>About</button>
          </div>
        );
      }
    `);
    project.createSourceFile('/root/src/pages/Sub.tsx', `
      import { useState } from 'react';
      export function Sub() {
        const [x, setX] = useState<'a'|'b'>('a');
        return <button onClick={() => setX('a')}>About</button>;
      }
    `);
    const { navigations } = await extractViteNavigations('/root', project, {}, [
      '/root/src/App.tsx',
      '/root/src/pages/Sub.tsx',
    ]);
    const topLevel = navigations.filter(n => n.scope === 'top-level');
    const pageLocal = navigations.filter(n => n.scope === 'page-local');
    expect(topLevel.every(n => n.siblingNavigations === 1)).toBe(true);
    expect(pageLocal.every(n => n.siblingNavigations === 0)).toBe(true);
  });

  it('confidence drops high→medium when siblings exist AND preferred = text', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a'|'b'>('a');
        return (
          <div>
            <button onClick={() => setTab('a')}>Save</button>
            <button onClick={() => setTab('b')}>Save</button>
          </div>
        );
      }
    `);
    expect(navigations.every(n => n.confidence === 'medium')).toBe(true);
  });

  it('confidence stays high when siblings exist BUT preferred = testId', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a'|'b'>('a');
        return (
          <div>
            <button data-testid="btn-a" onClick={() => setTab('a')}>Save</button>
            <button data-testid="btn-b" onClick={() => setTab('b')}>Save</button>
          </div>
        );
      }
    `);
    expect(navigations.every(n => n.confidence === 'high')).toBe(true);
  });
});

// ─── Cross-file duplicate count ───────────────────────────────────────────────

describe('duplicateCount', () => {
  it('duplicateCount = 0 when (method, target, kind, scope) is unique', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a'|'b'>('a');
        return (
          <div>
            <button onClick={() => setTab('a')}>A</button>
            <button onClick={() => setTab('b')}>B</button>
          </div>
        );
      }
    `);
    expect(navigations.every(n => n.duplicateCount === 0)).toBe(true);
  });

  it('duplicateCount = N-1 when N entries share the quadruple', async () => {
    const project = new Project({
      compilerOptions: { jsx: 4, allowJs: true, noEmit: true },
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
    });
    project.createSourceFile('/root/src/Nav1.tsx', `
      import { Link } from 'react-router-dom';
      export function Nav1() { return <Link to="/about">About</Link>; }
    `);
    project.createSourceFile('/root/src/Nav2.tsx', `
      import { Link } from 'react-router-dom';
      export function Nav2() { return <Link to="/about">About 2</Link>; }
    `);
    project.createSourceFile('/root/src/Nav3.tsx', `
      import { Link } from 'react-router-dom';
      export function Nav3() { return <Link to="/about">About 3</Link>; }
    `);
    const { navigations } = await extractViteNavigations('/root', project, {}, [
      '/root/src/Nav1.tsx', '/root/src/Nav2.tsx', '/root/src/Nav3.tsx',
    ]);
    const aboutNavs = navigations.filter(n => n.target === '/about');
    expect(aboutNavs).toHaveLength(3);
    expect(aboutNavs.every(n => n.duplicateCount === 2)).toBe(true);
  });

  it('duplicateCount considers all 4 fields — different scopes do not collide', async () => {
    const project = new Project({
      compilerOptions: { jsx: 4, allowJs: true, noEmit: true },
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
    });
    // App.tsx: top-level tab with target 'dashboard'
    project.createSourceFile('/root/src/App.tsx', `
      import { useState } from 'react';
      type Tab = 'dashboard' | 'settings';
      export function App() {
        const [tab, setTab] = useState<Tab>('dashboard');
        return (
          <div>
            <button onClick={() => setTab('dashboard')}>Dashboard</button>
            <button onClick={() => setTab('settings')}>Settings</button>
          </div>
        );
      }
    `);
    // pages/Sub.tsx: page-local tab also with target 'dashboard'
    project.createSourceFile('/root/src/pages/Sub.tsx', `
      import { useState } from 'react';
      export function Sub() {
        const [x, setX] = useState<'dashboard'|'b'>('dashboard');
        return <button onClick={() => setX('dashboard')}>Dashboard</button>;
      }
    `);
    const { navigations } = await extractViteNavigations('/root', project, {}, [
      '/root/src/App.tsx', '/root/src/pages/Sub.tsx',
    ]);
    // Top-level 'dashboard' and page-local 'dashboard' should NOT collide
    const topDash = navigations.find(n => n.target === 'dashboard' && n.scope === 'top-level');
    const localDash = navigations.find(n => n.target === 'dashboard' && n.scope === 'page-local');
    expect(topDash?.duplicateCount).toBe(0);
    expect(localDash?.duplicateCount).toBe(0);
  });
});

// ─── Closure-arg resolution tests ────────────────────────────────────────────

describe('Pass D — closure-arg resolution: factory call (E1)', () => {
  it('factory/inline: 4 callsites → 4 navigations', async () => {
    const { navigations, skips } = await extractFromSource(`
      import { useState } from 'react';
      type Tab = 'a' | 'b' | 'c' | 'd';
      export function App() {
        const [tab, setTab] = useState<Tab>('a');
        const item = (id: Tab, label: string) => (
          <button onClick={() => setTab(id)}>{label}</button>
        );
        return <nav>{item('a', 'A')}{item('b', 'B')}{item('c', 'C')}{item('d', 'D')}</nav>;
      }
    `);
    expect(skips.filter(s => s.reason === 'dynamic_target')).toHaveLength(0);
    expect(navigations).toHaveLength(4);
    const targets = navigations.map(n => n.target).sort();
    expect(targets).toEqual(['a', 'b', 'c', 'd']);
    expect(navigations[0]).toMatchObject({
      method: 'state-setter',
      kind: 'state',
      stateVar: 'tab',
      confidence: 'high',
      triggerSelectorHint: expect.objectContaining({ text: expect.any(String) }),
    });
  });

  it('factory/label-resolution: triggerSelectorHint.text differs per callsite', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      type Tab = 'x' | 'y' | 'z';
      export function App() {
        const [tab, setTab] = useState<Tab>('x');
        const item = (id: Tab, label: string) => (
          <button onClick={() => setTab(id)}>{label}</button>
        );
        return <nav>{item('x', 'Alpha')}{item('y', 'Beta')}{item('z', 'Gamma')}</nav>;
      }
    `);
    expect(navigations).toHaveLength(3);
    const labels = navigations.map(n => n.triggerSelectorHint.text).sort();
    expect(labels).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('factory/aria-label-resolution: aria-label attribute resolves per callsite', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      type Tab = 'a' | 'b';
      export function App() {
        const [tab, setTab] = useState<Tab>('a');
        const item = (id: Tab, ariaLabel: string) => (
          <button aria-label={ariaLabel} onClick={() => setTab(id)} />
        );
        return <nav>{item('a', 'First')}{item('b', 'Second')}</nav>;
      }
    `);
    expect(navigations).toHaveLength(2);
    const ariaLabels = navigations.map(n => n.triggerSelectorHint.ariaLabel).sort();
    expect(ariaLabels).toEqual(['First', 'Second']);
  });

  it('factory/single-callsite: 1 callsite → 1 navigation', async () => {
    const { navigations, skips } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a'>('a');
        const item = (id: 'a', label: string) => (
          <button onClick={() => setTab(id)}>{label}</button>
        );
        return <nav>{item('a', 'Only')}</nav>;
      }
    `);
    expect(skips.filter(s => s.reason === 'dynamic_target')).toHaveLength(0);
    expect(navigations).toHaveLength(1);
    expect(navigations[0].target).toBe('a');
    expect(navigations[0].confidence).toBe('high');
  });

  it('factory/mixed callsites: one non-literal arg → entire factory skipped', async () => {
    const { navigations, skips } = await extractFromSource(`
      import { useState } from 'react';
      export function App({ getId }: { getId: () => string }) {
        const [tab, setTab] = useState<'a'|'b'>('a');
        const item = (id: string, label: string) => (
          <button onClick={() => setTab(id)}>{label}</button>
        );
        return <>{item('a', 'A')}{item(getId(), 'B')}</>;
      }
    `);
    expect(navigations).toHaveLength(0);
    expect(skips.some(s => s.reason === 'dynamic_target')).toBe(true);
  });

  it('factory/captured-identifier: id is outer scope const → dynamic_target', async () => {
    const { navigations, skips } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a'|'b'>('a');
        const id: 'a' = 'a';
        return <button onClick={() => setTab(id)}>A</button>;
      }
    `);
    expect(navigations).toHaveLength(0);
    expect(skips.some(s => s.reason === 'dynamic_target')).toBe(true);
  });
});

describe('Pass D — closure-arg resolution: array map (E2)', () => {
  it('map/inline-array: literal array → N navigations', async () => {
    const { navigations, skips } = await extractFromSource(`
      import { useState } from 'react';
      type Tab = 'a' | 'b';
      export function App() {
        const [tab, setTab] = useState<Tab>('a');
        const tabs = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] as const;
        return <>{tabs.map(({ id, label }) => (
          <button key={id} onClick={() => setTab(id)}>{label}</button>
        ))}</>;
      }
    `);
    expect(skips.filter(s => s.reason === 'dynamic_target')).toHaveLength(0);
    expect(navigations).toHaveLength(2);
    expect(navigations.map(n => n.target).sort()).toEqual(['a', 'b']);
  });

  it('map/testId-resolution: data-testid resolves per element', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      type Tab = 'a' | 'b';
      export function App() {
        const [tab, setTab] = useState<Tab>('a');
        const tabs = [
          { id: 'a', label: 'A', tid: 'btn-a' },
          { id: 'b', label: 'B', tid: 'btn-b' },
        ];
        return <>{tabs.map(({ id, label, tid }) => (
          <button data-testid={tid} onClick={() => setTab(id)}>{label}</button>
        ))}</>;
      }
    `);
    expect(navigations).toHaveLength(2);
    const tids = navigations.map(n => n.triggerSelectorHint.testId).sort();
    expect(tids).toEqual(['btn-a', 'btn-b']);
  });

  it('map/destructure-rename: ({id: tabId, label}) → setTab(tabId)', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      type Tab = 'x' | 'y';
      export function App() {
        const [tab, setTab] = useState<Tab>('x');
        const tabs = [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }];
        return <>{tabs.map(({ id: tabId, label }) => (
          <button onClick={() => setTab(tabId)}>{label}</button>
        ))}</>;
      }
    `);
    expect(navigations).toHaveLength(2);
    expect(navigations.map(n => n.target).sort()).toEqual(['x', 'y']);
  });

  it('map/iteree-non-literal: tabs from useState → runtime_iterable skip', async () => {
    const { navigations, skips } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a'|'b'>('a');
        const [tabs] = useState([{ id: 'a' as const, label: 'A' }]);
        return <>{tabs.map(({ id, label }) => (
          <button onClick={() => setTab(id)}>{label}</button>
        ))}</>;
      }
    `);
    expect(navigations).toHaveLength(0);
    expect(skips.some(s => s.reason === 'runtime_iterable')).toBe(true);
  });

  it('map/spread-element: [...other] → runtime_iterable skip', async () => {
    const { navigations, skips } = await extractFromSource(`
      import { useState } from 'react';
      const other = [{ id: 'x', label: 'X' }];
      export function App() {
        const [tab, setTab] = useState<'x'>('x');
        const tabs = [...other, { id: 'y', label: 'Y' }];
        return <>{tabs.map(({ id, label }) => (
          <button onClick={() => setTab(id)}>{label}</button>
        ))}</>;
      }
    `);
    expect(navigations).toHaveLength(0);
    expect(skips.some(s => s.reason === 'runtime_iterable')).toBe(true);
  });

  it('map/flatMap: tabs.flatMap(...) treated like map', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      type Tab = 'p' | 'q';
      export function App() {
        const [tab, setTab] = useState<Tab>('p');
        const tabs = [{ id: 'p', label: 'P' }, { id: 'q', label: 'Q' }];
        return <>{tabs.flatMap(({ id, label }) => [
          <button key={id} onClick={() => setTab(id)}>{label}</button>
        ])}</>;
      }
    `);
    expect(navigations).toHaveLength(2);
    expect(navigations.map(n => n.target).sort()).toEqual(['p', 'q']);
  });

  it('map/forEach: tabs.forEach(...) accepted', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      type Tab = 'r' | 's';
      export function App() {
        const [tab, setTab] = useState<Tab>('r');
        const tabs = [{ id: 'r', label: 'R' }, { id: 's', label: 'S' }];
        return <>{tabs.forEach(({ id, label }) => (
          <button onClick={() => setTab(id)}>{label}</button>
        ))}</>;
      }
    `);
    expect(navigations).toHaveLength(2);
  });

  it('map/binding-1-hop: const tabs = ARRAY then map', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      type Tab = 'u' | 'v';
      const TABS = [{ id: 'u', label: 'U' }, { id: 'v', label: 'V' }];
      export function App() {
        const [tab, setTab] = useState<Tab>('u');
        const tabs = TABS;
        return <>{tabs.map(({ id, label }) => (
          <button onClick={() => setTab(id)}>{label}</button>
        ))}</>;
      }
    `);
    expect(navigations).toHaveLength(2);
    expect(navigations.map(n => n.target).sort()).toEqual(['u', 'v']);
  });

  it('map/binding-2-hops: const tabs = other; const other = ARRAY', async () => {
    const { navigations } = await extractFromSource(`
      import { useState } from 'react';
      type Tab = 'm' | 'n';
      const BASE = [{ id: 'm', label: 'M' }, { id: 'n', label: 'N' }];
      const ALIAS = BASE;
      export function App() {
        const [tab, setTab] = useState<Tab>('m');
        return <>{ALIAS.map(({ id, label }) => (
          <button onClick={() => setTab(id)}>{label}</button>
        ))}</>;
      }
    `);
    expect(navigations).toHaveLength(2);
  });

  it('map/binding-3-hops: depth exceeded → runtime_iterable skip', async () => {
    // 3 Identifier hops: A→B→C→D→array. Only 2 hops allowed (depth=2).
    const { navigations, skips } = await extractFromSource(`
      import { useState } from 'react';
      type Tab = 'e' | 'f';
      const D = [{ id: 'e', label: 'E' }, { id: 'f', label: 'F' }];
      const C = D;
      const B = C;
      const A = B;
      export function App() {
        const [tab, setTab] = useState<Tab>('e');
        return <>{A.map(({ id, label }) => (
          <button onClick={() => setTab(id)}>{label}</button>
        ))}</>;
      }
    `);
    expect(navigations).toHaveLength(0);
    expect(skips.some(s => s.reason === 'runtime_iterable')).toBe(true);
  });

  it('map/empty-array: [] → 0 navigations, no skip', async () => {
    const { navigations, skips } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState<'a'>('a');
        const tabs: Array<{ id: 'a'; label: string }> = [];
        return <>{tabs.map(({ id, label }) => (
          <button onClick={() => setTab(id)}>{label}</button>
        ))}</>;
      }
    `);
    expect(navigations).toHaveLength(0);
    expect(skips.filter(s => s.reason !== 'no_trigger_label')).toHaveLength(0);
  });
});

describe('Pass D — closure-arg resolution: bounded', () => {
  it('iterable_overflow: array of 33 elements → iterable_overflow skip', async () => {
    const elements = Array.from({ length: 33 }, (_, i) => `{ id: 't${i}', label: 'T${i}' }`).join(', ');
    const { navigations, skips } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState('t0');
        const tabs = [${elements}];
        return <>{tabs.map(({ id, label }) => (
          <button onClick={() => setTab(id)}>{label}</button>
        ))}</>;
      }
    `);
    expect(navigations).toHaveLength(0);
    expect(skips.some(s => s.reason === 'iterable_overflow')).toBe(true);
  });

  it('runtime_index: setTab(tabs[i].id) → runtime_index skip', async () => {
    const { navigations, skips } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState('a');
        const tabs = ['a', 'b'];
        return <button onClick={() => setTab(tabs[0])}>Tab</button>;
      }
    `);
    expect(navigations).toHaveLength(0);
    expect(skips.some(s => s.reason === 'runtime_index')).toBe(true);
  });

  it('template-literal: setTab(`tab-${id}`) → dynamic_target skip', async () => {
    const { navigations, skips } = await extractFromSource(`
      import { useState } from 'react';
      export function App() {
        const [tab, setTab] = useState('tab-a');
        const id = 'a';
        return <button onClick={() => setTab(\`tab-\${id}\`)}>A</button>;
      }
    `);
    expect(navigations).toHaveLength(0);
    expect(skips.some(s => s.reason === 'dynamic_target')).toBe(true);
  });

  it('ternary: setTab(cond ? "a" : "b") → dynamic_target skip', async () => {
    const { navigations, skips } = await extractFromSource(`
      import { useState } from 'react';
      export function App({ cond }: { cond: boolean }) {
        const [tab, setTab] = useState<'a'|'b'>('a');
        return <button onClick={() => setTab(cond ? 'a' : 'b')}>X</button>;
      }
    `);
    expect(navigations).toHaveLength(0);
    expect(skips.some(s => s.reason === 'dynamic_target')).toBe(true);
  });
});

describe('Pass D — prop-setter recognition', () => {
  it('prop-setter/factory: props.setTab + factory pattern → navigations emitted', async () => {
    const { navigations, skips } = await extractFromSource(`
      type Props = { setTab: (t: string) => void };
      export function Navbar({ setTab }: Props) {
        const item = (id: string, label: string) => (
          <button onClick={() => setTab(id)}>{label}</button>
        );
        return <>{item('dashboard', 'Dashboard')}{item('trades', 'Trades')}</>;
      }
    `);
    expect(navigations).toHaveLength(2);
    expect(navigations[0]).toMatchObject({
      method: 'state-setter',
      target: 'dashboard',
      stateVar: 'setTab',
      confidence: 'high',
      triggerSelectorHint: expect.objectContaining({ text: 'Dashboard' }),
    });
    expect(skips.filter(s => s.reason === 'dynamic_target')).toHaveLength(0);
  });

  it('prop-setter/literal: props.setTab + literal-arg onClick → 1 navigation', async () => {
    const { navigations } = await extractFromSource(`
      type Props = { setTab: (t: string) => void };
      export function Nav({ setTab }: Props) {
        return <button onClick={() => setTab('home')}>Home</button>;
      }
    `);
    expect(navigations).toHaveLength(1);
    expect(navigations[0].target).toBe('home');
    expect(navigations[0].method).toBe('state-setter');
  });

  it('prop-setter/non-string-type: props.setVisible (boolean) → not detected as nav setter', async () => {
    const { navigations } = await extractFromSource(`
      type Props = { setVisible: (b: boolean) => void };
      export function Panel({ setVisible }: Props) {
        return <button onClick={() => setVisible(true)}>Toggle</button>;
      }
    `);
    expect(navigations).toHaveLength(0);
  });
});

describe('Pass C — closure-arg resolution', () => {
  it('useNavigate/factory: navigate(path) inside factory → navigations emitted', async () => {
    const { navigations } = await extractFromSource(`
      import { useNavigate } from 'react-router-dom';
      export function Nav() {
        const nav = useNavigate();
        const item = (path: string, label: string) => (
          <button onClick={() => nav(path)}>{label}</button>
        );
        return <>{item('/a', 'A')}{item('/b', 'B')}</>;
      }
    `);
    expect(navigations).toHaveLength(2);
    expect(navigations.map(n => n.target).sort()).toEqual(['/a', '/b']);
    expect(navigations[0].method).toBe('router-push');
    expect(navigations[0].kind).toBe('url');
    expect(navigations[0].confidence).toBe('medium');
  });

  it('useNavigate/array-map: nav(t.path) inside .map → navigations emitted', async () => {
    const { navigations } = await extractFromSource(`
      import { useNavigate } from 'react-router-dom';
      const routes = [{ path: '/x', label: 'X' }, { path: '/y', label: 'Y' }];
      export function Nav() {
        const nav = useNavigate();
        return <>{routes.map(({ path, label }) => (
          <button onClick={() => nav(path)}>{label}</button>
        ))}</>;
      }
    `);
    expect(navigations).toHaveLength(2);
    expect(navigations.map(n => n.target).sort()).toEqual(['/x', '/y']);
    expect(navigations[0].method).toBe('router-push');
  });
});
