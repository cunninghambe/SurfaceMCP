# SPEC: SurfaceMCP — `surface_enumerate_routes_runtime` (browser-injected route enumeration)

Status: draft, ready for implementation
Owner: @architect
Companion specs: `/root/SurfaceMCP/SPEC_NAV_EXTRACT.md`, `/root/BugHunter/SPEC_SPA_DEEP_CRAWL.md`

---

## 1. Problem

Static analysis (`SPEC_NAV_EXTRACT.md`) covers `<Link>`, `<a href>`, `useNavigate`, and tab-state setters. It does NOT cover:

1. **TanStack Router** — route tree built via `createRouter()` with code-generated route trees. Lives in `window.__TSR_ROUTER__` at runtime.
2. **wouter** — minimalist route table built via `<Route path={...}>` JSX, but inside a `<Router>` provider; some apps use config arrays.
3. **react-router-dom v6 with non-trivial config** — when the route tree is constructed dynamically (`if (user.role === 'admin') routes.push(...)`), the static extractor sees unresolvable cases. The route table is in the React tree at runtime.
4. **Vue Router / Solid Router / SvelteKit** — different ASTs, different idioms; per-stack extractors are expensive and slow to ship.
5. **Imported route arrays from third-party packages** — `routes: [...standardRoutes, ...adminRoutes]` where the spread items live in another package's source.

The unifying observation: **after the SPA boots, the live JavaScript runtime knows its own routes**. SurfaceMCP can emit a script string that BugHunter injects via `browser.evaluate(...)` after login succeeds. The script introspects whatever router is present and returns a normalised route list.

This spec is the **producer half** of that pipeline. SurfaceMCP supplies the script + an output schema. BugHunter executes it in the live page (per `SPEC_SPA_DEEP_CRAWL.md`) and merges the results into its crawl queue.

### 1.1 Why SurfaceMCP owns the script (not BugHunter)

- The script is *knowledge of the app*: what routers exist in the JS ecosystem, how each exposes its tree. That knowledge belongs in SurfaceMCP, the system that already encapsulates "what does this stack look like."
- BugHunter remains stack-agnostic — it just executes opaque scripts and consumes the result.
- Updating router-detection logic is a SurfaceMCP version bump; BugHunter doesn't change.

### 1.2 Live target

- TanStack Router app: returns the full route table from `window.__TSR_ROUTER__.routesByPath`.
- TraiderJo (tab-state, no router lib): no router detected → empty `routes: []` → reason `'no_router_detected'`. The static navigations from `surface_list_navigations` carry the load.
- React Router with `BrowserRouter` + `<Routes>`: returns the static-discoverable subset (already in `surface_list_pages`); runtime adds dynamically-mounted routes if any. Confirmed via the Pass-C "router-config probe" in § 3.4.

### 1.3 Out of scope

- Brute-force path probing (`/dashboard`, `/settings`, etc.) — initially deferred. **Critical safety reason:** GET `/admin/delete-everything` could be destructive. If included later, it must be opt-in with an allowlist, and limited to read-only-by-convention paths. **This spec returns `routes: []` when no router is detected**, leaving probing as a future capability behind a feature flag.
- Mutating side-effects in the script (clicking, state changes). The script is read-only.
- Polling for slow-mounting routers. The script runs once with a 5-second timeout; it does not retry.

---

## 2. Root cause / motivation

Building per-router static extractors is O(N) work per stack. The runtime introspection script is O(1) work that scales across routers via discovery: each router gets a small detector function, and we ship them as a single bundled script.

Browser injection is already wired in BugHunter via `browser.evaluate(scriptString)`. The injected script must be a self-contained string (no imports), wrapped in an IIFE, with try/catch around each detector so a failing detector doesn't kill the others.

---

## 3. Design

### 3.1 New tool: `surface_enumerate_routes_runtime`

Returns the script string + post-processing config. BugHunter executes the script via its `BrowserMcpAdapter.evaluate(...)`, then passes the raw result back through `surface_postprocess_runtime_routes` (companion tool, § 3.5).

The split is deliberate: the script must be a string the client embeds in `evaluate(...)`, but parsing/validating its result on the SurfaceMCP side keeps the schema in one place.

```jsonc
// MCP request
{ "name": "surface_enumerate_routes_runtime", "arguments": {} }

// MCP response
{
  "version": 1,
  "script": "(function(){ /* ~3KB IIFE — see § 3.4 */ })()",
  "timeoutMs": 5000,
  "expectedSchema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "routers": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": { "enum": ["tanstack-router", "react-router-v6", "react-router-v5", "wouter", "vue-router", "next-router", "none"] },
            "version": { "type": "string" },
            "routes": { "type": "array", "items": { "type": "object", "properties": { "path": { "type": "string" }, "params": { "type": "array", "items": { "type": "string" } } } } }
          },
          "required": ["name", "routes"]
        }
      },
      "errors": { "type": "array", "items": { "type": "object", "properties": { "detector": { "type": "string" }, "message": { "type": "string" } } } },
      "elapsedMs": { "type": "number" }
    },
    "required": ["routers", "errors", "elapsedMs"]
  }
}
```

### 3.2 New tool: `surface_postprocess_runtime_routes`

Takes the raw browser-evaluate output and returns a normalised, deduplicated route list ready for the crawler.

```jsonc
// MCP request
{ "name": "surface_postprocess_runtime_routes", "arguments": { "raw": { /* what the script returned */ } } }

// MCP response
{
  "routes": [
    { "path": "/dashboard", "params": [], "source": "tanstack-router" },
    { "path": "/users/:userId", "params": ["userId"], "source": "react-router-v6" }
  ],
  "summary": {
    "detectedRouters": ["tanstack-router"],
    "errorCount": 0,
    "totalRoutes": 17,
    "dedupedRoutes": 14,
    "fellBackToNone": false
  }
}
```

Why a second tool? The raw browser output may be malformed (unexpected serialisation, exceptions), and the postprocessor:
- Validates against the schema in § 3.1 (Zod on the SurfaceMCP side).
- Dedups across routers (a route appearing in both TanStack and react-router-v6 — possible during a migration — is emitted once).
- Normalises path syntax (TanStack uses `$param`, react-router uses `:param`; postprocessor returns react-router-v6 syntax).
- Strips routes that match `excludedRoutes` from the surface config (already a SurfaceMCP feature).

### 3.3 Discriminated union — `RuntimeRouteEnumeration`

Add to `src/types.ts`:

```ts
export type DetectedRouterName =
  | 'tanstack-router'
  | 'react-router-v6'
  | 'react-router-v5'
  | 'wouter'
  | 'vue-router'
  | 'next-router'
  | 'none';

export type RuntimeRoute = {
  /** Route path in react-router-v6 syntax: '/users/:id', '/admin/*'. */
  path: string;
  /** Param names extracted from path. */
  params: string[];
};

export type DetectedRouter = {
  name: DetectedRouterName;
  version?: string;
  routes: RuntimeRoute[];
};

export type RuntimeEnumerationError = {
  detector: DetectedRouterName;
  message: string;
};

export type RuntimeEnumerationRaw = {
  routers: DetectedRouter[];
  errors: RuntimeEnumerationError[];
  elapsedMs: number;
};

export type PostprocessedRoute = RuntimeRoute & {
  source: DetectedRouterName;
};

export type PostprocessedResult = {
  routes: PostprocessedRoute[];
  summary: {
    detectedRouters: DetectedRouterName[];
    errorCount: number;
    totalRoutes: number;
    dedupedRoutes: number;
    fellBackToNone: boolean;
  };
};
```

### 3.4 The injected script — design

Must be a single string, no imports, no top-level `await`. Wrapped in `(function(){...})()` to avoid leaking globals. Returns a JSON-serialisable object matching `RuntimeEnumerationRaw`.

```ts
// Pseudocode — the actual implementation lives in src/runtime-enum/script.ts
// and is loaded as a string via fs.readFileSync at startup. See § 3.6.

(function () {
  const errors = [];
  const routers = [];
  const start = Date.now();

  function safe(name, fn) {
    try {
      const result = fn();
      if (result) routers.push(result);
    } catch (err) {
      errors.push({ detector: name, message: String(err && err.message || err).slice(0, 500) });
    }
  }

  // ── Detector 1: TanStack Router ──────────────────────────────────────────
  safe('tanstack-router', () => {
    const r = window.__TSR_ROUTER__;
    if (!r || !r.routesByPath) return null;
    const routes = Object.keys(r.routesByPath).map(path => ({
      path: path.replace(/\$([A-Za-z_][\w]*)/g, ':$1'),  // $param → :param
      params: (path.match(/\$[A-Za-z_][\w]*/g) || []).map(s => s.slice(1)),
    }));
    return { name: 'tanstack-router', version: r.version, routes };
  });

  // ── Detector 2: react-router-v6 (BrowserRouter via DataRouter) ───────────
  safe('react-router-v6', () => {
    // v6.4+ exposes router context on the data-router root;
    // detection: walk fiber tree from <body> looking for a node whose memoizedState contains 'routes'.
    const root = document.querySelector('#root, #app, body > div');
    if (!root) return null;
    const fiberKey = Object.keys(root).find(k => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$'));
    if (!fiberKey) return null;
    let fiber = root[fiberKey];
    if (!fiber) return null;
    if (fiber.stateNode && fiber.stateNode.current) fiber = fiber.stateNode.current;

    const seen = new WeakSet();
    let routerState = null;
    const queue = [fiber];
    let hops = 0;
    while (queue.length && hops < 5000) {
      const node = queue.shift();
      hops++;
      if (!node || seen.has(node)) continue;
      seen.add(node);
      const props = node.memoizedProps || node.pendingProps;
      if (props && props.router && props.router.routes) {
        routerState = props.router;
        break;
      }
      if (node.child) queue.push(node.child);
      if (node.sibling) queue.push(node.sibling);
    }
    if (!routerState) return null;

    const out = [];
    function walk(routes, prefix) {
      for (const r of routes || []) {
        const segment = (r.path || '').replace(/^\//, '');
        const full = (prefix + (segment ? '/' + segment : '')).replace(/\/+/g, '/') || '/';
        if (r.path !== undefined && !r.index) out.push({
          path: full,
          params: (full.match(/:[A-Za-z_][\w]*/g) || []).map(s => s.slice(1)),
        });
        if (r.children) walk(r.children, full);
      }
    }
    walk(routerState.routes, '');
    return { name: 'react-router-v6', routes: out };
  });

  // ── Detector 3: react-router-v5 (history-based) ──────────────────────────
  safe('react-router-v5', () => {
    // v5 exposes `__reactInternalMemoizedUnmaskedChildContext` with router on root nodes.
    // Detection is fragile; emit only if we find an unambiguous match.
    // [implementation: walk fibers looking for a 'staticContext' + 'history' shape]
    return null;  // initially: not implemented (rare in greenfield Vite apps); document as future work
  });

  // ── Detector 4: wouter ────────────────────────────────────────────────────
  safe('wouter', () => {
    // wouter routes are in JSX (<Route path="..."/>) — same shape as react-router but no central registry.
    // Detection at runtime: scan all <Route> elements in the React tree.
    // For v0 of this spec, return null. (Falls back to static analysis.)
    return null;
  });

  // ── Detector 5: vue-router ───────────────────────────────────────────────
  safe('vue-router', () => {
    const app = window.__VUE_APP__ || window.__VUE__;
    if (!app || !app.config || !app.config.globalProperties) return null;
    const router = app.config.globalProperties.$router;
    if (!router || !router.options || !router.options.routes) return null;
    const routes = [];
    function walk(rs, prefix) {
      for (const r of rs || []) {
        const seg = (r.path || '').replace(/^\//, '');
        const full = (prefix + (seg ? '/' + seg : '')).replace(/\/+/g, '/') || '/';
        routes.push({
          path: full,
          params: (full.match(/:[A-Za-z_][\w]*/g) || []).map(s => s.slice(1)),
        });
        if (r.children) walk(r.children, full);
      }
    }
    walk(router.options.routes, '');
    return { name: 'vue-router', version: router.version, routes };
  });

  // ── Detector 6: next-router (Pages router runtime) ───────────────────────
  safe('next-router', () => {
    const next = window.__NEXT_DATA__;
    if (!next || !next.page) return null;
    // We can't enumerate ALL pages at runtime in Next, only the current one;
    // SurfaceMCP already does filesystem-based extraction for Next.
    // This detector returns the current page only, as a sanity check.
    return { name: 'next-router', routes: [{ path: next.page, params: [] }] };
  });

  return { routers, errors, elapsedMs: Date.now() - start };
})()
```

Notes:
- Each detector wrapped in `safe(...)` — exception in one detector does not kill others.
- The script is **read-only**: no DOM mutation, no event dispatch, no fetches.
- Soft hop-limit (`hops < 5000`) on fiber walks prevents infinite loops on cyclic structures.
- `version` is best-effort; absent for routers that don't expose version at runtime.

### 3.5 Tool registration

Register both tools in `src/server/http.ts`:

```ts
import { getRuntimeEnumScript, RUNTIME_ENUM_VERSION } from '../runtime-enum/script.js';
import { postprocessRuntimeRoutes } from '../runtime-enum/postprocess.js';

server.tool(
  'surface_enumerate_routes_runtime',
  'Returns a self-contained JS script (string) that, when injected into the SPA via browser.evaluate(...), enumerates the live router\'s route table. Returns { script, timeoutMs, expectedSchema, version }.',
  {},
  async () => {
    return toolOk({
      version: RUNTIME_ENUM_VERSION,
      script: getRuntimeEnumScript(),
      timeoutMs: 5000,
      expectedSchema: RUNTIME_ENUM_SCHEMA,
    });
  }
);

server.tool(
  'surface_postprocess_runtime_routes',
  'Validate, normalise, and dedup the raw output of the runtime-enum script.',
  {
    raw: z.unknown().describe('Output of evaluating the script returned by surface_enumerate_routes_runtime.'),
  },
  async (args) => {
    const result = postprocessRuntimeRoutes(args.raw, {
      excludedRoutes: surface.excludedRoutes ?? [],
    });
    return toolOk(result);
  }
);
```

Update `surface_describe_self.capabilities`:
```ts
capabilities: {
  listPages: surface.stack === 'vite',
  listNavigations: surface.stack === 'vite',
  enumerateRoutesRuntime: true,  // NEW — works for any stack with a browser; the script is stack-agnostic
  crawlSeed: surface.stack === 'vite',
}
```

### 3.6 Script storage

Store the script as a `.js` file (NOT `.ts`) in `src/runtime-enum/script.runtime.js`, loaded at server startup via `readFileSync(import.meta.dirname + '/script.runtime.js', 'utf-8')`. This:
- Keeps the source readable (`.js` viewable, no transpilation).
- Avoids accidentally importing TypeScript helpers (the script must be self-contained).
- Lets us run a separate Vitest suite that loads the script file as a string and `eval`s it under jsdom (see § 4.1).

Build step: copy `script.runtime.js` to `dist/runtime-enum/` (configure in `tsconfig.json` or `package.json` build script). The script is NOT bundled, NOT transpiled.

### 3.7 Versioning

`RUNTIME_ENUM_VERSION` is an integer; bump when the script's output schema changes. BugHunter's adapter records the version it received; if SurfaceMCP later emits a higher version, BugHunter logs a warning and continues (forward-compat).

### 3.8 Postprocess — dedup logic

```ts
export function postprocessRuntimeRoutes(
  raw: unknown,
  opts: { excludedRoutes?: string[] }
): PostprocessedResult {
  // 1. Zod-validate raw against RuntimeEnumerationRaw schema.
  const parsed = RuntimeEnumerationRawSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      routes: [],
      summary: {
        detectedRouters: [],
        errorCount: 1,
        totalRoutes: 0,
        dedupedRoutes: 0,
        fellBackToNone: true,
      },
    };
  }

  const { routers, errors } = parsed.data;
  const seen = new Map<string, PostprocessedRoute>();

  for (const router of routers) {
    for (const route of router.routes) {
      const normalised = normaliseRoutePath(route.path);
      if (opts.excludedRoutes?.some(p => micromatch([normalised], [p]).length > 0)) continue;
      if (!seen.has(normalised)) {
        seen.set(normalised, { path: normalised, params: route.params, source: router.name });
      }
      // First-router-wins on conflict; deterministic order: tanstack > rrv6 > rrv5 > wouter > vue > next > none.
    }
  }

  return {
    routes: [...seen.values()].sort((a, b) => a.path.localeCompare(b.path)),
    summary: {
      detectedRouters: routers.map(r => r.name),
      errorCount: errors.length,
      totalRoutes: routers.reduce((acc, r) => acc + r.routes.length, 0),
      dedupedRoutes: seen.size,
      fellBackToNone: routers.length === 0 || routers.every(r => r.name === 'none'),
    },
  };
}
```

### 3.9 What the postprocessor does NOT do

- It does not assert a specific router was detected. Empty result is valid.
- It does not call `browser.evaluate` itself. SurfaceMCP has no browser; that's BugHunter's responsibility.
- It does not merge with `surface_list_pages` output. The crawler does the cross-source merge.

---

## 4. Files

### Files you MUST read before writing any code

- `src/server/http.ts` — register pattern; especially `surface_list_pages` for tool shape.
- `src/server/tools-meta.ts` — catalog regeneration; this spec does NOT add to the cached catalog because the script content is static across all surfaces (single literal). No regeneration on file changes needed.
- `src/types.ts` — add the new types here.
- `src/extract/vite/router.ts` — for `dynamicParams` helper which can be reused for params extraction (export from `vite/util.ts` per `SPEC_NAV_EXTRACT.md`).
- `package.json` — confirm `micromatch` is a runtime dep (already used in BugHunter; add to SurfaceMCP only if not present — it's a tiny dep).

### Files to create

- `src/runtime-enum/script.runtime.js` — the injected script (≤ 4KB, ≤ 200 lines).
- `src/runtime-enum/script.ts` — exports `getRuntimeEnumScript()` and `RUNTIME_ENUM_VERSION`.
- `src/runtime-enum/postprocess.ts` — `postprocessRuntimeRoutes()` + zod schema.
- `src/runtime-enum/postprocess.test.ts` — unit tests for postprocess (≤ 300 lines).
- `src/runtime-enum/script.test.ts` — runs the script in jsdom against synthetic router fixtures (≤ 400 lines).
- `src/runtime-enum/normalise.ts` — `normaliseRoutePath()` helper.
- `src/runtime-enum/normalise.test.ts`.

### Files to modify

- `src/types.ts` — add `RuntimeRoute`, `DetectedRouter`, `DetectedRouterName`, `RuntimeEnumerationRaw`, `RuntimeEnumerationError`, `PostprocessedRoute`, `PostprocessedResult`.
- `src/server/http.ts` — register two tools; add `enumerateRoutesRuntime: true` to capabilities.
- `package.json` — add `micromatch` if not present; add a build step copying `script.runtime.js` to `dist/runtime-enum/`.
- `tsconfig.json` — ensure `.js` files are not consumed by tsc (they're already not by default; verify `allowJs` is false or that the runtime-enum dir is excluded from compile graph).
- `src/cli/regenerate.ts` / wherever the build is triggered — add a `cp src/runtime-enum/*.runtime.js dist/runtime-enum/` step.

### Files NOT to touch

- `src/extract/**` (any extractor) — runtime enum is orthogonal.
- `src/auth/**` — orthogonal.
- BugHunter repo — coordination spec lives there.

---

## 5. Edge cases

| # | Case | Expected |
|---|------|----------|
| 1 | TanStack Router present, no routes registered | Detector returns `{ name:'tanstack-router', routes: [] }`; postprocess: empty route list |
| 2 | Multiple routers in same app (rare migration scenario) | All detected; dedup keeps first by priority order |
| 3 | Router not yet mounted (script runs too early) | Returns `routers: []`; postprocess: `fellBackToNone: true`. BugHunter retries by re-injecting after a 2-second wait (per crawler spec). |
| 4 | Detector throws | Recorded in `errors[]`; other detectors continue |
| 5 | Window has `__TSR_ROUTER__` but no `routesByPath` (older TanStack) | Skipped; no error (the detector returned null) |
| 6 | Script timeout (5s) | BugHunter aborts; postprocess receives no input → `fellBackToNone: true` |
| 7 | Fiber walk hits cycle | Hop limit (5000) prevents infinite loop |
| 8 | Route path with regex (`/users/:id(\\d+)`) | Param extraction strips parenthesised constraint: regex `/:[A-Za-z_][\w]*/g` ignores constraint group |
| 9 | TanStack `$splat` route | Mapped to `*` (path normalisation step) |
| 10 | Vue Router with named routes (`{ name: 'home', path: '/' }`) | Name ignored; path used |
| 11 | Vue Router with redirect (`{ path: '/old', redirect: '/new' }`) | Both `/old` and `/new` may end up emitted; postprocess emits as-declared (let crawler discover redirect at runtime) |
| 12 | Next.js Pages Router runtime detection | Returns only current page (not full route table); postprocess emits just that |
| 13 | App with no router and no React (vanilla JS) | All detectors return null; `fellBackToNone: true` |
| 14 | Path contains query/hash (`/users?role=admin`) | Postprocess strips query/hash before deduping (paths only) |
| 15 | Postprocess receives malformed input (string, null, array) | Zod reject → empty result with errorCount: 1 |
| 16 | Script returns extra fields not in schema | Zod with `.passthrough()` accepts; extras are ignored |
| 17 | Two routes that normalise to the same string (`/users/:id` and `/users/$id` from different routers) | Deduped to one entry; source = first router seen |
| 18 | TanStack route path is empty string | Skipped during dedup walk (filter `path !== ''`) |
| 19 | Fiber walk starts from `<body>` but app mounts in a sibling | Detector tries multiple roots: `#root`, `#app`, `#__next`, `body > div`. First match wins. |
| 20 | App uses Shadow DOM | Fiber walk does not pierce shadow roots; documented as a known limitation |

---

## 6. Tests

### 6.1 Unit tests — `src/runtime-enum/script.test.ts`

Run the script against synthetic globals in jsdom:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT = readFileSync(resolve(import.meta.dirname, 'script.runtime.js'), 'utf-8');

function runInJsdom(setup: (window: Window) => void): unknown {
  const dom = new JSDOM('<div id="root"></div>');
  setup(dom.window as unknown as Window);
  // eslint-disable-next-line no-eval
  return dom.window.eval(SCRIPT);
}

it('detects TanStack Router', () => {
  const result = runInJsdom(w => {
    (w as any).__TSR_ROUTER__ = {
      version: '1.50.0',
      routesByPath: {
        '/': true,
        '/dashboard': true,
        '/users/$userId': true,
      },
    };
  }) as RuntimeEnumerationRaw;

  const tsr = result.routers.find(r => r.name === 'tanstack-router');
  expect(tsr).toBeDefined();
  expect(tsr!.version).toBe('1.50.0');
  expect(tsr!.routes.map(r => r.path).sort()).toEqual(['/', '/dashboard', '/users/:userId']);
  expect(result.errors).toEqual([]);
});

it('returns empty routers when no router is present', () => {
  const result = runInJsdom(() => {}) as RuntimeEnumerationRaw;
  expect(result.routers).toEqual([]);
  expect(result.errors).toEqual([]);
});

it('isolates detector exceptions', () => {
  const result = runInJsdom(w => {
    Object.defineProperty(w, '__TSR_ROUTER__', {
      get() { throw new Error('boom'); },
    });
  }) as RuntimeEnumerationRaw;
  expect(result.errors.find(e => e.detector === 'tanstack-router')).toBeDefined();
  expect(result.routers).toEqual([]);  // no other detectors fired
});

it('detects Vue Router from window.__VUE_APP__', () => {
  const result = runInJsdom(w => {
    (w as any).__VUE_APP__ = {
      config: {
        globalProperties: {
          $router: {
            version: '4.2.0',
            options: {
              routes: [
                { path: '/' },
                { path: '/about' },
                { path: '/users/:id', children: [{ path: 'edit' }] },
              ],
            },
          },
        },
      },
    };
  }) as RuntimeEnumerationRaw;
  const vue = result.routers.find(r => r.name === 'vue-router');
  expect(vue).toBeDefined();
  expect(vue!.routes.map(r => r.path).sort()).toEqual(['/', '/about', '/users/:id', '/users/:id/edit']);
});

it('reports elapsedMs as a number', () => {
  const result = runInJsdom(() => {}) as RuntimeEnumerationRaw;
  expect(typeof result.elapsedMs).toBe('number');
  expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
});
```

Required cases — at least 12 in this file:
1. TanStack: present, with routes
2. TanStack: present, no routes
3. TanStack: present, throws on access
4. react-router-v6: present (mock fiber tree)
5. react-router-v6: not present
6. react-router-v6: throws during walk
7. Vue Router: present
8. Vue Router: not present
9. Multiple routers present
10. No router (vanilla JS)
11. Hop-limit triggered (synthetic cycle in fiber tree)
12. Empty document body

### 6.2 Unit tests — `src/runtime-enum/postprocess.test.ts`

```ts
it('validates input via zod', () => {
  expect(postprocessRuntimeRoutes(null, {}).summary.fellBackToNone).toBe(true);
  expect(postprocessRuntimeRoutes("string", {}).summary.fellBackToNone).toBe(true);
  expect(postprocessRuntimeRoutes({ routers: 'not an array' }, {}).summary.fellBackToNone).toBe(true);
});

it('dedups across routers', () => {
  const raw: RuntimeEnumerationRaw = {
    routers: [
      { name: 'tanstack-router', routes: [{ path: '/x', params: [] }] },
      { name: 'react-router-v6', routes: [{ path: '/x', params: [] }] },
    ],
    errors: [],
    elapsedMs: 0,
  };
  const r = postprocessRuntimeRoutes(raw, {});
  expect(r.routes).toHaveLength(1);
  expect(r.routes[0].source).toBe('tanstack-router');  // priority order
});

it('respects excludedRoutes glob', () => {
  const raw: RuntimeEnumerationRaw = {
    routers: [{ name: 'tanstack-router', routes: [{ path: '/admin/users', params: [] }, { path: '/dashboard', params: [] }] }],
    errors: [],
    elapsedMs: 0,
  };
  const r = postprocessRuntimeRoutes(raw, { excludedRoutes: ['/admin/**'] });
  expect(r.routes.map(x => x.path)).toEqual(['/dashboard']);
});

it('emits fellBackToNone when no routers', () => {
  const r = postprocessRuntimeRoutes({ routers: [], errors: [], elapsedMs: 5 }, {});
  expect(r.summary.fellBackToNone).toBe(true);
});
```

Required cases — at least 8.

### 6.3 Unit tests — `src/runtime-enum/normalise.test.ts`

Path normalisation rules:
- `$param` → `:param` (TanStack)
- `*` and `$splat` → `*`
- `//` → `/`
- Trailing `/` stripped except root
- Empty string → `/`
- Query string stripped
- Hash stripped

≥ 6 cases.

### 6.4 Tool-level tests

Add to existing `src/server/streaming.test.ts` or new file:

```ts
it('surface_enumerate_routes_runtime returns a non-empty script', async () => {
  const result = await callTool('surface_enumerate_routes_runtime', {});
  expect(typeof result.script).toBe('string');
  expect(result.script.length).toBeGreaterThan(500);
  expect(result.script).toMatch(/^\(function/);  // IIFE
  expect(result.timeoutMs).toBe(5000);
  expect(result.version).toBe(1);
});

it('surface_postprocess_runtime_routes accepts the raw shape from script', async () => {
  const raw = { routers: [{ name: 'tanstack-router', routes: [{ path: '/x', params: [] }] }], errors: [], elapsedMs: 1 };
  const result = await callTool('surface_postprocess_runtime_routes', { raw });
  expect(result.routes).toHaveLength(1);
});
```

### 6.5 End-to-end via fixture (deferred — not blocking)

A real Vite + TanStack Router fixture would let us run the script in a real browser. Out of scope for v1; the jsdom + synthetic-globals approach gives 90% of the coverage at 10% of the cost. Document this as future work.

---

## 7. Acceptance criteria

- [ ] `surface_enumerate_routes_runtime` returns `{ version, script, timeoutMs, expectedSchema }`.
- [ ] Script is a self-contained IIFE, ≤ 4KB, no top-level imports.
- [ ] Script runs in jsdom and returns the expected shape for each detector fixture (§ 6.1).
- [ ] Detector exceptions never propagate; they land in `errors[]`.
- [ ] `surface_postprocess_runtime_routes` Zod-validates input and dedups deterministically.
- [ ] `surface_describe_self.capabilities.enumerateRoutesRuntime === true`.
- [ ] All unit tests pass.
- [ ] `npm run typecheck`, `npm run lint`, `npm run test` clean.
- [ ] Build copies `script.runtime.js` to `dist/`.
- [ ] No new heavy deps (only zod and micromatch — already used elsewhere or trivial).

---

## 8. Risks

| Risk | Mitigation |
|------|-----------|
| Fiber-walk detection brittle across React versions | Detector returns null on any structural mismatch; documented; users with non-standard mounts still get static analysis. |
| Script grows unbounded as more routers are added | Hard ceiling 4KB; if exceeded, ship as a separate `runtime-enum-extra.runtime.js` and concatenate at serve time. |
| App's CSP blocks inline `eval`/script-injection | Documented as a known limitation; the script is delivered to BugHunter, which uses `browser.evaluate` (CDP-style, not page-injected); CSP doesn't apply. |
| Detector returns sensitive data (path with token) | Detectors only read route *patterns*, never URL params. Document in script comments. |
| Script timeout 5s too low for slow apps | Make it configurable per surface via `surface.runtimeEnumTimeoutMs`; default 5000. |
| Brute-force probing enabled by mistake | Not implemented in v1. When added later, gated behind `surface.runtimeEnumBruteForce: { enabled: true, allowlist: ['/dashboard', '/profile', ...] }`. |
| TanStack and react-router both detected, dedup picks the wrong one | Priority order documented; in practice an app uses one or the other. Misordering only mislabels `source`, doesn't drop routes. |

---

## 9. Open questions

None blocking. Future-work items:
- Add brute-force probing as opt-in (separate spec).
- Add detectors for SvelteKit (`window.__sveltekit_*`), Solid Router, react-router-v5 fully.
- Cache the script string at startup vs. read on every tool call (current spec: cache; verify ≤ 1ms cold load).

---

## 10. Negative requirements

- Do NOT mutate the live page. Script is read-only; no DOM writes, no event dispatch, no fetch, no console.log to noisy levels.
- Do NOT use `eval` inside the script. The script itself is `eval`'d by `browser.evaluate`; nesting eval inside is forbidden.
- Do NOT ship TypeScript in `script.runtime.js`. The file must be runnable in any modern browser as plain JS.
- Do NOT implement brute-force path probing in v1. Gate behind a flag in a follow-up.
- Do NOT take dependencies on `browser-mcp` or `BrowserMcpAdapter` types in SurfaceMCP. The tool returns a string; BugHunter is responsible for execution.
- Do NOT add the runtime-enum tools to the in-memory tool catalog (`tools-meta.ts`); they're meta-tools, registered directly in `http.ts`.
- Do NOT use `as any`. Where ts-morph or zod typing is awkward, use proper Zod inference (`z.infer<typeof schema>`).

---

## 11. Task breakdown

### Task 1 — Type additions
**Files to modify:** `src/types.ts`
**Test:** `npm run typecheck`
**Done when:** all new types compile.

### Task 2 — Path normalisation helper
**Files to create:** `src/runtime-enum/normalise.ts`, `src/runtime-enum/normalise.test.ts`
**Test:** `npm run test src/runtime-enum/normalise`
**Done when:** all 6 cases in § 6.3 pass.

### Task 3 — Postprocess + Zod schema
**Files to create:** `src/runtime-enum/postprocess.ts`, `src/runtime-enum/postprocess.test.ts`
**Test:** § 6.2 cases pass.

### Task 4 — Inject script (TanStack + Vue + Next + scaffolding)
**Files to create:** `src/runtime-enum/script.runtime.js`, `src/runtime-enum/script.ts`
**Test:** § 6.1 cases for TanStack, Vue, Next, and the throw-isolation case pass.

### Task 5 — Inject script (react-router-v6 fiber walk)
**Files to modify:** `src/runtime-enum/script.runtime.js`
**Test:** § 6.1 cases for react-router-v6 (with synthetic fiber tree fixture) pass.

### Task 6 — Tool registration
**Files to modify:** `src/server/http.ts`
**Test:** § 6.4 cases pass.

### Task 7 — Build step (copy `.runtime.js` to dist)
**Files to modify:** `package.json` (or build script). Verify `dist/runtime-enum/script.runtime.js` exists after `npm run build`.
**Test:** Manual.

### Task 8 — Capabilities update
**Files to modify:** `src/server/http.ts` (`surface_describe_self`).
**Test:** Existing capabilities tests still pass.

---

## 12. Estimated effort

≈ 1.5 senior engineer-days. Most of the time is on the fiber-walk implementation; budget cautiously.
