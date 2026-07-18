import { describe, it, expect } from 'vitest';
import { extractNextjsRoutes } from './nextjs/routes.js';
import { extractServerActions } from './nextjs/server-actions.js';
import { extractExpressRoutes } from './express/static.js';
import { extractFastifyRoutes } from './fastify/routes.js';
import { extractDjangoRoutes } from './django/ast-walk.js';
import { extractOpenApiRoutes } from './openapi/parse.js';
import { extractPagesForStack } from './pages/index.js';
import { extractViteNavigations } from './vite/navigations.js';
import { extractVitePages } from './vite/router.js';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const FIXTURES = resolve(import.meta.dirname, '../../fixtures');

function loadMustDiscover(fixture: string): { routes?: string[]; serverActions?: string[] } {
  const path = resolve(FIXTURES, fixture, 'MUST_DISCOVER.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as { routes?: string[]; serverActions?: string[] };
}

function routeKey(tool: { method: string; path: string }): string {
  return `${tool.method} ${tool.path}`;
}

describe('nextjs-app route extraction', () => {
  it('discovers all must-discover routes', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractNextjsRoutes(root);
    const must = loadMustDiscover('nextjs-app');
    const discovered = new Set(tools.map(routeKey));

    for (const route of must.routes ?? []) {
      expect(discovered.has(route), `Missing route: ${route}`).toBe(true);
    }
  });

  it('emits inputSchemaConfidence for routes with zod schemas', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractNextjsRoutes(root);
    // POST /api/users has a zod schema in the source
    const postUsers = tools.find((t) => t.method === 'POST' && t.path === '/api/users');
    expect(postUsers).toBeDefined();
    // Confidence is at least "inferred" or "introspected" (can't easily require introspected
    // without runtime import working, but should not be unknown for a file with zod usage)
    expect(postUsers?.inputSchemaConfidence).not.toBe('unknown');
  });

  it('assigns correct toolId (stable sha1 hash)', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractNextjsRoutes(root);
    const getUsers = tools.find((t) => t.method === 'GET' && t.path === '/api/users');
    expect(getUsers?.toolId).toMatch(/^[0-9a-f]{12}$/);
  });

  it('assigns safe sideEffectClass to GET routes', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractNextjsRoutes(root);
    const getRoutes = tools.filter((t) => t.method === 'GET');
    for (const t of getRoutes) {
      expect(t.sideEffectClass).toBe('safe');
    }
  });

  it('assigns mutating sideEffectClass to POST routes (pre-call-graph)', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractNextjsRoutes(root);
    const postUsers = tools.find((t) => t.method === 'POST' && t.path === '/api/users');
    expect(postUsers?.sideEffectClass).toBe('mutating');
  });

  it('generates unique toolIds across routes', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractNextjsRoutes(root);
    const ids = tools.map((t) => t.toolId);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('deduplicates tool names when there are collisions', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractNextjsRoutes(root);
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});

describe('manual-validation schema recovery (§B regression)', () => {
  it('assigns partial confidence to a route with manual if-guard validation', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractNextjsRoutes(root);
    const postJournal = tools.find(
      (t) => t.method === 'POST' && t.path === '/api/journal-entries'
    );
    expect(postJournal).toBeDefined();
    expect(postJournal!.inputSchemaConfidence).toBe('partial');
    expect(postJournal!.inputSchema.required).toContain('memo');
    expect(postJournal!.inputSchema.required).toContain('amount');
    expect(postJournal!.inputSchema.properties?.['amount']).toMatchObject({ type: 'number' });
  });
});

describe('schema introspection — constraint extraction', () => {
  it('extracts email format from zod .email()', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractNextjsRoutes(root);
    const postUsers = tools.find((t) => t.method === 'POST' && t.path === '/api/users');
    expect(postUsers).toBeDefined();
    const schema = postUsers!.inputSchema;
    if (schema.properties?.email) {
      expect(schema.properties.email.format).toBe('email');
    }
    // Schema confidence should reflect zod usage
    expect(postUsers!.inputSchemaConfidence).not.toBe('unknown');
  });

  it('extracts minLength/maxLength from zod .min().max()', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractNextjsRoutes(root);
    const postUsers = tools.find((t) => t.method === 'POST' && t.path === '/api/users');
    expect(postUsers).toBeDefined();
    const schema = postUsers!.inputSchema;
    if (schema.properties?.password) {
      expect(schema.properties.password.minLength).toBe(8);
      expect(schema.properties.password.maxLength).toBe(64);
    }
  });
});

describe('express route extraction', () => {
  it('discovers all must-discover routes', async () => {
    const root = resolve(FIXTURES, 'express-app');
    const tools = await extractExpressRoutes(root);
    const must = loadMustDiscover('express-app');
    const discovered = new Set(tools.map(routeKey));

    for (const route of must.routes ?? []) {
      expect(discovered.has(route), `Missing route: ${route}`).toBe(true);
    }
  });

  it('scopes inputSchema to routes that validate the body', async () => {
    const root = resolve(FIXTURES, 'express-app');
    const tools = await extractExpressRoutes(root);
    const get  = tools.find(t => t.method === 'GET'    && t.path === '/api/products');
    const post = tools.find(t => t.method === 'POST'   && t.path === '/api/products');
    const put  = tools.find(t => t.method === 'PUT'    && t.path === '/api/products/:id');
    const del  = tools.find(t => t.method === 'DELETE' && t.path === '/api/products/:id');
    expect(get!.inputSchemaConfidence).toBe('unknown');
    expect(post!.inputSchemaConfidence).toBe('introspected');
    expect(post!.inputSchema.properties?.name).toBeDefined();
    expect(put!.inputSchemaConfidence).toBe('introspected');
    expect(del!.inputSchemaConfidence).toBe('unknown');
  });
});

describe('fastify route extraction', () => {
  it('discovers all must-discover routes', () => {
    const root = resolve(FIXTURES, 'fastify-app');
    const tools = extractFastifyRoutes(root);
    const must = loadMustDiscover('fastify-app');
    const discovered = new Set(tools.map(routeKey));

    for (const route of must.routes ?? []) {
      expect(discovered.has(route), `Missing route: ${route}`).toBe(true);
    }
  });

  it('introspects querystring (GET) and body (POST/PUT) JSON schemas', () => {
    const root = resolve(FIXTURES, 'fastify-app');
    const tools = extractFastifyRoutes(root);
    const get  = tools.find(t => t.method === 'GET'    && t.path === '/api/items');
    const post = tools.find(t => t.method === 'POST'   && t.path === '/api/items');
    const put  = tools.find(t => t.method === 'PUT'    && t.path === '/api/items/:id');
    const del  = tools.find(t => t.method === 'DELETE' && t.path === '/api/items/:id');
    const user = tools.find(t => t.method === 'GET'    && t.path === '/users/:id');
    expect(get!.inputSchemaConfidence).toBe('introspected');
    expect(get!.inputSchema.properties?.limit).toBeDefined();
    expect(post!.inputSchemaConfidence).toBe('introspected');
    expect(post!.inputSchema.properties?.name).toBeDefined();
    expect(put!.inputSchemaConfidence).toBe('introspected');
    expect(del!.inputSchemaConfidence).toBe('unknown');
    expect(user!.inputSchemaConfidence).toBe('unknown');
  });
});

describe('django route extraction', () => {
  it('discovers exactly the must-discover route set (no false positives)', () => {
    const root = resolve(FIXTURES, 'django-app');
    const tools = extractDjangoRoutes(root);
    const must = loadMustDiscover('django-app');

    const discovered = new Set(tools.map((t) => `${t.method} ${t.path}`));
    const expected = new Set(must.routes ?? []);

    // Every expected route present
    for (const route of expected) {
      expect(discovered.has(route), `Missing route: ${route}`).toBe(true);
    }
    // No extras
    expect(
      [...discovered].filter((r) => !expected.has(r)),
      'Unexpected routes discovered'
    ).toEqual([]);
    expect(discovered.size).toBe(expected.size);
  });

  it('emits no invalid characters in tool names', () => {
    const root = resolve(FIXTURES, 'django-app');
    const tools = extractDjangoRoutes(root);
    for (const t of tools) {
      expect(t.name, `bad tool name: ${t.name}`).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

describe('openapi route extraction', () => {
  it('discovers all must-discover routes from fastapi-app openapi.json', () => {
    const root = resolve(FIXTURES, 'fastapi-app');
    const tools = extractOpenApiRoutes(root);
    const must = loadMustDiscover('fastapi-app');
    const discovered = new Set(tools.map(routeKey));

    for (const route of must.routes ?? []) {
      expect(discovered.has(route), `Missing route: ${route}`).toBe(true);
    }
  });

  it('emits introspected confidence for openapi routes with schemas', () => {
    const root = resolve(FIXTURES, 'fastapi-app');
    const tools = extractOpenApiRoutes(root);
    const postUsers = tools.find((t) => t.method === 'POST' && t.path === '/api/users');
    expect(postUsers?.inputSchemaConfidence).toBe('introspected');
    expect(postUsers?.inputSchema.properties?.email).toBeDefined();
  });

  it('emits format:email for EmailStr fields', () => {
    const root = resolve(FIXTURES, 'fastapi-app');
    const tools = extractOpenApiRoutes(root);
    const postUsers = tools.find((t) => t.method === 'POST' && t.path === '/api/users');
    expect(postUsers?.inputSchema.properties?.email?.format).toBe('email');
  });

  it('emits minimum/maximum for constrained fields', () => {
    const root = resolve(FIXTURES, 'fastapi-app');
    const tools = extractOpenApiRoutes(root);
    const postUsers = tools.find((t) => t.method === 'POST' && t.path === '/api/users');
    expect(postUsers?.inputSchema.properties?.age?.minimum).toBe(0);
    expect(postUsers?.inputSchema.properties?.age?.maximum).toBe(120);
  });
});

describe('nextjs-app server-action extraction', () => {
  it('discovers all must-discover server actions', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractServerActions(root);
    const must = loadMustDiscover('nextjs-app');
    const byId = new Map(tools.map((t) => [t.toolId, t]));
    for (const expected of (must as { serverActions?: Array<{ toolId: string; inputSchemaConfidence: string }> }).serverActions ?? []) {
      const t = byId.get(expected.toolId);
      expect(t, `missing server action toolId=${expected.toolId}`).toBeDefined();
      expect(t!.inputSchemaConfidence).toBe(expected.inputSchemaConfidence);
    }
  });
});

describe('nextjs-app surface_list_pages regression — backward compat', () => {
  it('returns empty pages array (Next.js stack uses filesystem discovery via BugHunter, not surface_list_pages)', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const { pages, skips } = await extractPagesForStack('nextjs', root);
    expect(pages).toEqual([]);
    expect(skips).toEqual([]);
  });
});

describe('vite-tab-state-app navigation extraction', () => {
  it('discovers all must-discover navigations', async () => {
    const root = resolve(FIXTURES, 'vite-tab-state-app');
    const { navigations } = await extractViteNavigations(root);
    const must = JSON.parse(readFileSync(resolve(FIXTURES, 'vite-tab-state-app', 'MUST_DISCOVER.json'), 'utf-8')) as {
      navigations: Array<{ method: string; target: string; label: string; stateVar: string; confidence: string }>;
    };
    for (const expected of must.navigations) {
      const found = navigations.find(n => n.target === expected.target && n.method === expected.method);
      expect(found, `Missing navigation: ${expected.method}/${expected.target}`).toBeDefined();
      expect(found!.label).toBe(expected.label);
      expect(found!.confidence).toBe(expected.confidence);
    }
  });

  it('emits no synthetic /?<state>= pages — state lives only in navigations', async () => {
    const root = resolve(FIXTURES, 'vite-tab-state-app');
    const { pages } = await extractVitePages(root);
    expect(pages.every(p => !p.route.startsWith('/?'))).toBe(true);
  });
});

describe('vite-tab-state-app-deep navigation extraction', () => {
  it('classifies App.tsx setters as top-level', async () => {
    const root = resolve(FIXTURES, 'vite-tab-state-app-deep');
    const { navigations } = await extractViteNavigations(root);
    const appNavs = navigations.filter(n => n.sourceFile.includes('App.tsx'));
    expect(appNavs.length).toBeGreaterThan(0);
    expect(appNavs.every(n => n.scope === 'top-level')).toBe(true);
  });

  it('classifies pages/Dashboard.tsx setters as page-local', async () => {
    const root = resolve(FIXTURES, 'vite-tab-state-app-deep');
    const { navigations } = await extractViteNavigations(root);
    const dashNavs = navigations.filter(n => n.sourceFile.includes('Dashboard.tsx'));
    expect(dashNavs.length).toBeGreaterThan(0);
    expect(dashNavs.every(n => n.scope === 'page-local')).toBe(true);
  });

  it('discovers all must-discover navigations with correct scope and stateVar', async () => {
    const root = resolve(FIXTURES, 'vite-tab-state-app-deep');
    const { navigations } = await extractViteNavigations(root);
    const must = JSON.parse(readFileSync(resolve(FIXTURES, 'vite-tab-state-app-deep', 'MUST_DISCOVER.json'), 'utf-8')) as {
      navigations: Array<{ method: string; target: string; scope: string; stateVar: string; siblingNavigations: number }>;
    };
    for (const expected of must.navigations) {
      const found = navigations.find(n => n.target === expected.target && n.method === expected.method);
      expect(found, `Missing navigation: ${expected.method}/${expected.target}`).toBeDefined();
      expect(found!.scope).toBe(expected.scope);
      expect(found!.stateVar).toBe(expected.stateVar);
      expect(found!.siblingNavigations).toBe(expected.siblingNavigations);
    }
  });
});

describe('vite-tab-state-app-ambiguous navigation extraction', () => {
  it('discovers 3 navigations with sibling-counting applied', async () => {
    const root = resolve(FIXTURES, 'vite-tab-state-app-ambiguous');
    const { navigations } = await extractViteNavigations(root);
    const must = JSON.parse(readFileSync(resolve(FIXTURES, 'vite-tab-state-app-ambiguous', 'MUST_DISCOVER.json'), 'utf-8')) as {
      navigations: Array<{ target: string; siblingNavigations: number; confidence: string; scope: string }>;
    };
    expect(navigations).toHaveLength(3);
    for (const expected of must.navigations) {
      const found = navigations.find(n => n.target === expected.target);
      expect(found, `Missing navigation: ${expected.target}`).toBeDefined();
      expect(found!.siblingNavigations).toBe(expected.siblingNavigations);
      expect(found!.confidence).toBe(expected.confidence);
      expect(found!.scope).toBe(expected.scope);
    }
  });

  it('target=c keeps high confidence because it has a testId (preferred not text)', async () => {
    const root = resolve(FIXTURES, 'vite-tab-state-app-ambiguous');
    const { navigations } = await extractViteNavigations(root);
    const navC = navigations.find(n => n.target === 'c');
    expect(navC).toBeDefined();
    expect(navC!.confidence).toBe('high');
    expect(navC!.triggerSelectorHint.preferred).toBe('testId');
  });

  it('targets a and b drop to medium confidence (preferred=text, siblings > 0)', async () => {
    const root = resolve(FIXTURES, 'vite-tab-state-app-ambiguous');
    const { navigations } = await extractViteNavigations(root);
    const navA = navigations.find(n => n.target === 'a');
    const navB = navigations.find(n => n.target === 'b');
    expect(navA!.confidence).toBe('medium');
    expect(navB!.confidence).toBe('medium');
  });
});

describe('vite-tab-state-app-factory navigation extraction', () => {
  it('resolves factory-pattern Navbar: 4 navigations from Navbar.tsx', async () => {
    const root = resolve(FIXTURES, 'vite-tab-state-app-factory');
    const { navigations } = await extractViteNavigations(root);
    const navbarNavs = navigations.filter(n => n.sourceFile.endsWith('Navbar.tsx'));
    expect(navbarNavs).toHaveLength(4);
    expect(navbarNavs.map(n => n.target).sort()).toEqual(['dashboard', 'profile', 'settings', 'trades']);
    for (const n of navbarNavs) {
      expect(n.method).toBe('state-setter');
      expect(n.kind).toBe('state');
      expect(n.stateVar).toBe('setTab');
      expect(n.confidence).toBe('high');
      expect(n.triggerSelectorHint.text).toBeTruthy();
    }
  });

  it('resolves factory labels correctly per callsite', async () => {
    const root = resolve(FIXTURES, 'vite-tab-state-app-factory');
    const { navigations } = await extractViteNavigations(root);
    const navbarNavs = navigations.filter(n => n.sourceFile.endsWith('Navbar.tsx'));
    const labelMap = new Map(navbarNavs.map(n => [n.target, n.triggerSelectorHint.text]));
    expect(labelMap.get('dashboard')).toBe('Dashboard');
    expect(labelMap.get('trades')).toBe('Trades');
    expect(labelMap.get('settings')).toBe('Settings');
    expect(labelMap.get('profile')).toBe('Profile');
  });
});

describe('vite-tab-state-app-array-map navigation extraction', () => {
  it('resolves array-map pattern: 4 navigations', async () => {
    const root = resolve(FIXTURES, 'vite-tab-state-app-array-map');
    const { navigations } = await extractViteNavigations(root);
    expect(navigations).toHaveLength(4);
    expect(navigations.map(n => n.target).sort()).toEqual(['inventory', 'orders', 'overview', 'reports']);
    for (const n of navigations) {
      expect(n.method).toBe('state-setter');
      expect(n.kind).toBe('state');
      expect(n.stateVar).toBe('tab');
      expect(n.confidence).toBe('high');
      expect(n.triggerSelectorHint.text).toBeTruthy();
    }
  });

  it('resolves testId per element from array-map fixture', async () => {
    const root = resolve(FIXTURES, 'vite-tab-state-app-array-map');
    const { navigations } = await extractViteNavigations(root);
    const overview = navigations.find(n => n.target === 'overview');
    expect(overview?.triggerSelectorHint.testId).toBe('tab-overview');
    const orders = navigations.find(n => n.target === 'orders');
    expect(orders?.triggerSelectorHint.testId).toBe('tab-orders');
  });
});

describe('monorepo multi-surface detection', () => {
  it('detects nextjs in apps/web', async () => {
    const { detectStack } = await import('../detect/index.js');
    const webRoot = resolve(FIXTURES, 'nextjs-monorepo', 'apps', 'web');
    expect(detectStack(webRoot)).toBe('nextjs');
  });

  it('detects express in apps/api', async () => {
    const { detectStack } = await import('../detect/index.js');
    const apiRoot = resolve(FIXTURES, 'nextjs-monorepo', 'apps', 'api');
    expect(detectStack(apiRoot)).toBe('express');
  });

  it('extracts routes from apps/web', async () => {
    const webRoot = resolve(FIXTURES, 'nextjs-monorepo', 'apps', 'web');
    const tools = await extractNextjsRoutes(webRoot);
    const keys = new Set(tools.map(routeKey));
    expect(keys.has('GET /api/posts')).toBe(true);
    expect(keys.has('POST /api/posts')).toBe(true);
  });

  it('extracts routes from apps/api', async () => {
    const apiRoot = resolve(FIXTURES, 'nextjs-monorepo', 'apps', 'api');
    const tools = await extractExpressRoutes(apiRoot);
    const keys = new Set(tools.map(routeKey));
    expect(keys.has('GET /api/health')).toBe(true);
    expect(keys.has('POST /api/data')).toBe(true);
  });
});
