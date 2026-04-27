# SPEC: SurfaceMCP v0.2 — Vite SPA Route Discovery

Status: draft, ready for implementation
Owner: @architect
Target version: SurfaceMCP v0.2.0
Companion spec: `/root/BugHunter/SPEC_SPA_PAGES.md`

---

## 1. Problem

A live BugHunter smoke against `/tmp/TraiderJo` (Express server + Vite/React SPA frontend) discovered 252 API tools across two roles and planned **952 API tests / 0 UI tests**. UI coverage was zero because BugHunter's `discoverFilesystemPages` walks Next.js conventions (`app/**/page.tsx`, `pages/**/*.tsx`). A Vite SPA has no filesystem-routed pages: routes are declared in code (typically via `react-router-dom`).

Until SurfaceMCP can enumerate SPA pages, BugHunter cannot test SPA UI surfaces. Today SurfaceMCP supports five stacks: `nextjs`, `express`, `fastapi`, `django`, `openapi`. This spec adds a sixth — `vite` — and a new MCP tool `surface_list_pages` so any SPA stack can plug in.

### 1.1 Live target validation
TraiderJo's router-table (URL-routable pages, found by reading `/tmp/TraiderJo/src/ui/App.tsx`):

| Route | Source | Lazy | Notes |
|---|---|---|---|
| `/` | `LandingPage` from `./pages/Landing` | no | static import |
| `/privacy` | `PrivacyPage` from `./pages/Privacy` | yes | `React.lazy` |
| `/terms` | `TermsPage` from `./pages/Terms` | yes | `React.lazy` |
| `/features` | `FeaturesPage` from `./pages/Features` | yes | `React.lazy` |
| `/admin` | `AdminPage` from `./pages/Admin` | yes | `React.lazy` |
| `/admin/ai-usage` | `AdminAiUsagePage` from `./pages/AdminAiUsage` | yes | dynamic prefix (`startsWith`) |
| `/admin/alerts` | `AdminAlertsPage` from `./pages/AdminAlerts` | yes | `React.lazy` |
| `/trader/:identifier` | `PublicProfilePage` from `@/features/profile/pages/PublicProfileView` | yes | dynamic param |

**Important:** TraiderJo does NOT use `react-router-dom`. It uses imperative `window.location.pathname` matching with a `tab` state. This pattern (tab-state routing) is **explicitly out of scope** for v0.2 and is deferred to v0.3 — see § 8.5. The TraiderJo re-smoke acceptance criterion (§ 9) therefore asserts a **non-zero** number of UI tests are planned (we expect zero pages discovered for TraiderJo until v0.3 because TraiderJo has no `react-router-dom`). The fixture in this spec uses `react-router-dom` v6, the in-scope pattern.

To make the TraiderJo re-smoke meaningful in v0.2, we add a stretch goal in § 9.3: a TODO-tracked migration of TraiderJo to `react-router-dom` is **not** part of this spec, but BugHunter's e2e harness includes a Vite fixture that exercises the same SPA codepath end-to-end, and the SurfaceMCP fixture is the source of truth for `surface_list_pages` correctness.

---

## 2. Pattern catalog

This section is the source of truth for which patterns the v0.2 extractor must support. The implementer SHOULD write the extractor as a list of pattern matchers, each with its own unit test against a fixture file.

### 2.1 IN SCOPE

#### Pattern P1 — `react-router-dom` v6 JSX `<Routes>` / `<Route>`

```tsx
// fixtures/vite-app/src/App.tsx
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
}
```

Extracted entries:
- `{ route: '/', sourceFile: 'src/pages/Home.tsx', componentName: 'Home', lazy: false }`
- `{ route: '/about', sourceFile: 'src/pages/About.tsx', componentName: 'About', lazy: false }`

#### Pattern P2 — `react-router-dom` v6 JSX **nested** `<Route>` with `<Outlet>`

```tsx
<Routes>
  <Route path="/admin" element={<AdminLayout />}>
    <Route path="users" element={<AdminUsers />} />
    <Route path="settings" element={<AdminSettings />} />
  </Route>
</Routes>
```

Extracted entries (nested children get the parent prefix; the layout itself is also emitted with its own path because the index route may render at `/admin`):
- `{ route: '/admin', sourceFile: 'src/pages/AdminLayout.tsx', componentName: 'AdminLayout', lazy: false }`
- `{ route: '/admin/users', sourceFile: 'src/pages/AdminUsers.tsx', componentName: 'AdminUsers', lazy: false }`
- `{ route: '/admin/settings', sourceFile: 'src/pages/AdminSettings.tsx', componentName: 'AdminSettings', lazy: false }`

If a `<Route index element={...}/>` is present inside `<Route path="/admin">`, emit it as the parent's path (`/admin`) and **omit** the layout-only entry — see edge case § 8.2.

#### Pattern P3 — `react-router-dom` v6 config `createBrowserRouter([...])`

```ts
// src/router.ts
import { createBrowserRouter } from 'react-router-dom';
import { Home } from './pages/Home';
import { About } from './pages/About';

export const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  { path: '/about', element: <About /> },
  {
    path: '/admin',
    element: <AdminLayout />,
    children: [
      { path: 'users', element: <AdminUsers /> },
    ],
  },
]);
```

Same output as P1+P2.

The first argument may be:
- a literal array (handle directly)
- an identifier referencing a const exported from another file (resolve via import map; if unresolvable, emit a single `route_unresolved` skip entry — see § 8.4)

#### Pattern P4 — `React.lazy()` element components

```tsx
const About = React.lazy(() => import('./pages/About'));
const Privacy = React.lazy(() => import('./pages/Privacy').then((m) => ({ default: m.PrivacyPage })));
// ...
<Route path="/about" element={<About />} />
```

Set `lazy: true`. Resolve `sourceFile` from the `import()` argument. Resolve `componentName`:
- For `import('x')` (default re-export shape): use the lazy variable name (`About`).
- For `.then((m) => ({ default: m.NamedExport }))`: use `NamedExport`.
- Fallback: lazy variable name.

#### Pattern P5 — `<Route element={<Lazy />}>`-style with `Suspense` already wrapped at parent

The extractor does not care about `<Suspense>` placement — it only mines `path` + `element` pairs. `Suspense` is presentation, not routing.

### 2.2 DEFERRED to v0.3+

| Pattern | Notes |
|---|---|
| Tab-state routing (TraiderJo pattern) | Requires escape-analysis or runtime probe of `window.history.pushState` calls. Distinct architecture; deserves its own spec. |
| TanStack Router (`@tanstack/react-router`) | Different config shape (`createRoute` builder pattern, file-based routes via vite plugin). Plug into the extractor registry the same way `vite` plugs in here — see § 4.5. |
| Vue Router (`createRouter`, `routes: [...]`) | Same registry extension point. Vue parsing requires Vue SFC handling, not just `ts-morph`. |
| Wouter / Reach Router | Out of scope, no plans. |
| Routes computed dynamically (e.g. `routes.map(r => <Route {...r} />)`, routes fetched from API) | Documented as `route_unresolved`; emit one skip entry. |
| Route-config arrays imported from a file but **mutated at runtime** before being passed to `createBrowserRouter` | Treated as `route_unresolved`. |

---

## 3. Discovery algorithm

The extractor produces `Page[]` entries (§ 4.1) from a Vite project root. It is invoked by the catalog regenerator (§ 5).

### 3.1 Entry points

1. Walk all `.{tsx,jsx,ts,js}` files under `<root>/src/**` and `<root>/app/**` (Vite projects rarely use `app/`, but support both). Exclusions: `node_modules`, `dist`, `build`, `.next`, `**/*.test.*`, `**/*.spec.*`, `**/*.d.ts`. Implement via `glob` (already a dep) — same pattern as `extract/express/static.ts`.

### 3.2 Per-file passes

For each candidate file, parse with `ts-morph` (`Project.addSourceFileAtPath(file)`):

#### Pass A — JSX `<Routes>/<Route>` (P1, P2)

Walk `JsxElement` and `JsxSelfClosingElement` nodes. For each `<Route>`:
1. Read `path` attribute literal value. If absent or non-literal, skip with `route_unresolved` reason `dynamic_path`.
2. Read `element={<Foo />}` attribute:
   - Find the JSX expression.
   - Inspect the inner element (must be `JsxSelfClosingElement` or `JsxElement`).
   - Read the tag name as `componentName`.
3. Recurse into children for nested `<Route>`s (P2). The nested route's effective path is `joinPath(parentPath, childPath)` where `joinPath` collapses double slashes and treats `/` parent + child `users` as `/admin/users`.
4. Detect `<Route index element={<Foo />}/>`: route path is the parent path (no suffix). Mark it as the parent's "index" entry; do **not** emit a separate parent-only entry alongside it.

#### Pass B — `createBrowserRouter([...])` (P3)

Walk `CallExpression` nodes whose expression text matches `^createBrowserRouter$|\.createBrowserRouter$`. For the first argument:
- If `ArrayLiteralExpression`: walk each `ObjectLiteralExpression` and recurse on `children`.
- If `Identifier`: look up the symbol's value declaration via `ts-morph` (`getSymbol().getValueDeclaration()`), unwrap `as` casts. If the resolved value is an array literal, walk it. Otherwise: emit one `route_unresolved` entry (`reason: 'dynamic_route_array'`) and continue.
- Other forms: `route_unresolved` (`reason: 'unsupported_router_arg'`).

Each object contributes:
- `path`: literal string (or skip with `dynamic_path`)
- `element`: as in Pass A
- `children`: recurse with `joinPath(parent.path, child.path)`
- `index: true` + `element`: emit at parent path; suppress parent-only entry

#### Pass C — `React.lazy()` lazy resolution (P4)

Build an in-file map of `lazyVarName -> { importPath, namedExport? }` by walking variable declarations whose initializer is a CallExpression like `React.lazy(...)` or `lazy(...)` (where `lazy` is an `import { lazy } from 'react'` binding).

For each tag name resolved in Pass A/B:
1. If the identifier resolves to a value declaration in `lazyMap`, mark `lazy: true` and use `importPath` as the unresolved import.
2. Otherwise, it should resolve to a normal `import { Foo } from './pages/Foo'` — use the static import map for the file. `lazy: false`.

### 3.3 Component-to-source resolution

For each emitted page entry, resolve `sourceFile` (relative to project root) from the import specifier:
1. Read the file's import declarations via `ts-morph` `SourceFile.getImportDeclarations()`.
2. For static imports: find the declaration that imports `componentName`. The module specifier is the import path.
3. For lazy imports: the path is the `import('...')` argument string literal.
4. Resolve the module specifier to a real file with this preference order:
   - `<dir>/<spec>` + `.tsx`, `.ts`, `.jsx`, `.js`
   - `<dir>/<spec>/index.{tsx,ts,jsx,js}`
   - If the spec begins with `@/`, resolve via `tsconfig.json` `compilerOptions.paths` (read once, cached). If `paths` is absent, default `@/` to `<root>/src/`.
5. If unresolved: emit the page with `sourceFile: '<unresolved>'` and add a skip entry. Don't drop the page — BugHunter still uses `route` to navigate.

### 3.4 Path normalization

- Strip a single trailing `/` (except for the root `/`).
- Lowercase the path? **No.** Routes are case-sensitive in `react-router-dom` v6 by default. Preserve as authored.
- Collapse leading `//` to `/`.
- Param syntax stays as authored: `/users/:id` remains `/users/:id`. Splat (`*`) stays as `*`.
- Optional segments (`?`) and segments with regex (`(\\d+)`) stay as authored — BugHunter applies its own dynamic-route handling via `discoveryFixtures`.

### 3.5 Deduplication

After all files are processed, the extractor deduplicates by `route` string. If two `<Route path="/foo">` declarations point at different components, **keep the first encountered** and emit a skip entry with `reason: 'duplicate_route'` for the second. The "first encountered" order is the file-walk order (sorted alphabetically by relative path) plus AST traversal order — deterministic.

### 3.6 Determinism

The output of `extractVitePages(root)` MUST be deterministic across runs. Sort the final `Page[]` array by `(route, componentName)` ascending before returning. This is required for the e2e exact-match test (§ 6).

---

## 4. Interface contract

### 4.1 New types in `src/types.ts`

Add to `src/types.ts`:

```ts
export type Stack =
  | 'nextjs'
  | 'express'
  | 'fastapi'
  | 'django'
  | 'openapi'
  | 'vite';

export type Page = {
  /**
   * URL path as authored (e.g. '/', '/admin/users', '/users/:id').
   * Case-preserved; param tokens use `:name` syntax (react-router style).
   */
  route: string;
  /**
   * Project-root-relative path to the source file declaring the component.
   * Posix separators. Example: 'src/pages/Home.tsx'.
   * Set to '<unresolved>' if the import could not be resolved (rare; logged as skip).
   */
  sourceFile: string;
  /**
   * The component identifier as it appeared in the JSX `element={...}` slot,
   * or the lazy-binding name. Optional because future stacks may not have a name.
   */
  componentName?: string;
  /**
   * True when the component was loaded via `React.lazy(() => import(...))`.
   */
  lazy: boolean;
  /**
   * Names of dynamic params extracted from the route, in order.
   * '/users/:id' → ['id']. '/posts/:postId/comments/:commentId' → ['postId','commentId'].
   * Splat ('*') becomes the synthetic name '*'.
   */
  dynamicParams: string[];
  /**
   * Source file + line where the `<Route>` (or createBrowserRouter object) was declared,
   * for debugging. Project-root-relative.
   */
  declaredAt: { file: string; line: number };
};

export type PageCatalog = {
  revision: number;
  pages: Page[];
};

export type PageSkip = {
  /** Best-effort route or component name; '<unknown>' when neither is known. */
  route: string;
  reason:
    | 'dynamic_path'
    | 'dynamic_route_array'
    | 'unsupported_router_arg'
    | 'duplicate_route'
    | 'unresolved_component'
    | 'unresolved_lazy_import';
  detail?: string;
  declaredAt?: { file: string; line: number };
};
```

`Page[]` is a separate axis from `ToolMeta[]`. They live side-by-side in the in-memory catalog but are returned by different MCP tools — see § 4.3.

### 4.2 SurfaceConfig — no breaking change

`SurfaceConfig.stack` accepts `'vite'` as an additional value. All existing fields remain untouched.

The zod schema in `src/config.ts` (line 56) updates to:

```ts
stack: z.enum(['nextjs', 'express', 'fastapi', 'django', 'openapi', 'vite']),
```

### 4.3 New MCP tool: `surface_list_pages`

This is the **chosen interface** — Option A2 from the architectural decision matrix (see § 5.0). Pages are NOT mixed into `surface_list_tools`; they live on a parallel tool.

Register in `src/server/http.ts` `registerMetaTools`:

```ts
server.tool(
  'surface_list_pages',
  'List discovered SPA pages for this surface. Returns empty for stacks without UI route discovery (express, fastapi, django, openapi when used standalone).',
  {
    filter: z
      .object({
        pathPrefix: z.string().optional(),
        lazy: z.boolean().optional(),
      })
      .optional(),
  },
  async (args) => {
    const catalog = getPageCatalog();
    let pages = catalog.pages;
    if (args.filter?.pathPrefix) {
      const prefix = args.filter.pathPrefix;
      pages = pages.filter((p) => p.route.startsWith(prefix));
    }
    if (typeof args.filter?.lazy === 'boolean') {
      pages = pages.filter((p) => p.lazy === args.filter!.lazy);
    }
    return toolOk({ revision: catalog.revision, pages });
  }
);
```

Response shape (JSON, after MCP envelope unwrap):

```json
{
  "revision": 3,
  "pages": [
    {
      "route": "/",
      "sourceFile": "src/pages/Home.tsx",
      "componentName": "Home",
      "lazy": false,
      "dynamicParams": [],
      "declaredAt": { "file": "src/App.tsx", "line": 12 }
    }
  ]
}
```

For non-vite stacks, `pages` is `[]` and `revision` mirrors the tool catalog's revision.

### 4.4 New MCP tool: `surface_describe_self`

Required so BugHunter can branch on stack without parsing config files. Lightweight — single object response.

```ts
server.tool(
  'surface_describe_self',
  'Return non-secret metadata about this SurfaceMCP instance (stack, name, revision, capabilities).',
  {},
  async () => {
    const catalog = getCatalog();
    const pageCatalog = getPageCatalog();
    return toolOk({
      name: surface.name,
      stack: surface.stack,
      baseUrl: surface.baseUrl,
      toolRevision: catalog.revision,
      pageRevision: pageCatalog.revision,
      capabilities: {
        listPages: surface.stack === 'vite',
      },
    });
  }
);
```

### 4.5 Page extractor registry (extension point)

Add `src/extract/pages/index.ts`:

```ts
import type { Page, PageSkip, Stack } from '../../types.js';
import { extractVitePages } from '../vite/router.js';

export type PageExtractor = (root: string) => Promise<{ pages: Page[]; skips: PageSkip[] }>;

const REGISTRY: Partial<Record<Stack, PageExtractor>> = {
  vite: extractVitePages,
};

export async function extractPagesForStack(
  stack: Stack,
  root: string
): Promise<{ pages: Page[]; skips: PageSkip[] }> {
  const fn = REGISTRY[stack];
  if (!fn) return { pages: [], skips: [] };
  return fn(root);
}
```

This is the extension point: TanStack Router and Vue Router slot in by adding their own extractor and registering it under a new stack value (e.g. `'tanstack-router'` or `'vue'`). No re-architecture required.

---

## 5. Cross-repo coupling — producer / consumer pairs

| Producer | Consumer | Contract |
|---|---|---|
| SurfaceMCP `extractVitePages(root)` | SurfaceMCP `regeneratePageCatalog` | `Promise<{ pages: Page[]; skips: PageSkip[] }>` |
| SurfaceMCP `regeneratePageCatalog` | `getPageCatalog()` (in-memory) | mutates `pageCatalog: PageCatalog` |
| MCP tool `surface_list_pages` | BugHunter `discoverPages('vite', root, surface)` | JSON envelope: `{ revision: number; pages: Page[] }` |
| MCP tool `surface_describe_self` | BugHunter `discoverPages` dispatcher | JSON envelope: `{ stack: Stack; capabilities: { listPages: boolean }; ... }` |
| SurfaceMCP `init` (vite branch) | TraiderJo-style multi-stack repos | writes a multi-surface `surfacemcp.config.json` with one `vite` surface and one backend surface |

### 5.0 Architectural decision: Option A2 (separate tool, not mixed)

We chose Option A2 (`surface_list_pages` as a new tool) over Option A1 (mixing pages into `surface_list_tools` as `kind: 'page'`). Rationale:

1. **Semantic clarity.** `ToolMeta` carries fields like `method`, `inputSchema`, `inputSchemaConfidence`, `sideEffectClass` — none of which are meaningful for a page. Forcing pages into `ToolMeta` requires either nullable fields everywhere or a discriminated union, both of which leak SPA concerns into every tool consumer (probe, sample-inputs, call, classify-by-call-graph). All five existing extractors would need updates.
2. **Stable revision semantics.** `surface_list_tools` revision currently advances when **any** API tool changes. Mixing pages would mean editing a JSX file bumps the API revision, breaking BugHunter's `pinRevision` semantics for API calls.
3. **Future stacks plug in cleanly.** TanStack/Vue add a new extractor without touching the API surface.
4. **One MCP tool per concept** matches the existing pattern (`surface_list_tools`, `surface_describe_tool`, `surface_call`, `surface_probe`, `surface_sample_inputs`, `surface_login_status`, `surface_relogin`, `surface_routes_for_page`).

The cost of A2 is one new MCP tool — minor, given the alternative cost.

### 5.1 Plumbing for `discoverPages` dispatch (BugHunter side)

Recommended: option (a) — BugHunter calls `surface_describe_self()` and branches on `stack`. Decision rationale lives in `/root/BugHunter/SPEC_SPA_PAGES.md` § 4.

---

## 6. Fixture + test plan

### 6.1 Fixture: `/root/SurfaceMCP/fixtures/vite-app/`

Mirror the `nextjs-app` shape. Files:

```
fixtures/vite-app/
  package.json                # name "vite-app-fixture", deps: react, react-dom, react-router-dom v6, vite
  vite.config.ts              # minimal ({ plugins: [react()] })
  tsconfig.json
  index.html                  # SPA entry referencing /src/main.tsx
  src/
    main.tsx                  # ReactDOM.createRoot(...).render(<BrowserRouter><App/></BrowserRouter>)
    App.tsx                   # Pattern P1 + P2 + P4 (mixed JSX + lazy + nested)
    router.ts                 # Pattern P3 — exports a createBrowserRouter([...]) const used by an alternate entry (NOT mounted; included to verify the extractor finds both shapes; see test § 6.3)
    pages/
      Home.tsx                # default export `Home`, NOT lazy
      About.tsx               # named export `About`, lazy via `.then((m) => ({ default: m.About }))`
      AdminLayout.tsx         # used as parent of nested routes
      AdminUsers.tsx          # nested: /admin/users
      AdminSettings.tsx       # nested: /admin/settings
      UserDetail.tsx          # dynamic: /users/:id
  surfacemcp.config.json      # surfaces[0]: stack=vite, root=., port allocated dynamically
  MUST_DISCOVER.json
  ecosystem.config.cjs        # mirrors nextjs-app
```

`MUST_DISCOVER.json` (exact set, used for both presence AND absence assertions like the django regression):

```json
{
  "pages": [
    { "route": "/",                  "sourceFile": "src/pages/Home.tsx",          "componentName": "Home",          "lazy": false, "dynamicParams": [] },
    { "route": "/about",             "sourceFile": "src/pages/About.tsx",         "componentName": "About",         "lazy": true,  "dynamicParams": [] },
    { "route": "/admin",             "sourceFile": "src/pages/AdminLayout.tsx",   "componentName": "AdminLayout",   "lazy": false, "dynamicParams": [] },
    { "route": "/admin/users",       "sourceFile": "src/pages/AdminUsers.tsx",    "componentName": "AdminUsers",    "lazy": false, "dynamicParams": [] },
    { "route": "/admin/settings",    "sourceFile": "src/pages/AdminSettings.tsx", "componentName": "AdminSettings", "lazy": false, "dynamicParams": [] },
    { "route": "/users/:id",         "sourceFile": "src/pages/UserDetail.tsx",    "componentName": "UserDetail",    "lazy": false, "dynamicParams": ["id"] }
  ],
  "skipsExpected": []
}
```

Why six entries even though both `App.tsx` (JSX) and `router.ts` (config) declare a `/about` route? Because we use **different** routes between the two shapes to test both without running into the dedup path. Concretely:
- `App.tsx` declares `/`, `/admin`, `/admin/users`, `/admin/settings`, `/users/:id`
- `router.ts` declares `/about` only

This makes the test assert both shapes are scanned without engaging dedup logic. A separate dedup test (§ 6.3.5) covers the dedup case in isolation.

### 6.2 Unit tests: `/root/SurfaceMCP/src/extract/vite/router.test.ts`

Co-located with the implementation. Cases (mirror django regression discipline):

1. `extracts all six fixture pages — exact-match`: `extractVitePages(fixtureRoot)` returns exactly the six entries above. Assert `pages.length === 6`. Assert each expected entry is present. Assert no extras (`expect([...discovered].filter(p => !expected.has(p.route))).toEqual([])`).
2. `marks About lazy: true and Home lazy: false`.
3. `dynamicParams === ['id']` for `/users/:id` and `[]` for static routes.
4. `nested routes are joined correctly` (no double slashes, no missing prefix).
5. `componentName preserved as authored`.

### 6.3 Pattern-isolation tests (separate `*.test.ts` files, each with a tiny inline fixture)

To avoid coupling pattern coverage to one big fixture, write isolated tests using `Project.createSourceFile` (in-memory, no filesystem):

#### `router-jsx.test.ts`
- P1: simple `<Routes>/<Route>`
- P2: nested `<Route>` (one and two levels deep)
- P2-index: `<Route index element={<X/>}/>` — emits parent path, suppresses layout-only entry
- P4: `React.lazy(() => import('./Foo'))` and `.then((m) => ({ default: m.NamedFoo }))`

#### `router-config.test.ts`
- P3: array literal `createBrowserRouter([{ path: '/', element: <H/> }])`
- P3: array imported by identifier from another in-memory file (resolution via ts-morph)
- P3: identifier that points at a non-array → emits `route_unresolved` `unsupported_router_arg`

#### `router-edge.test.ts`
- Dynamic path `path={someVar}` → skip with `dynamic_path`
- Splat `path="*"` → `dynamicParams: ['*']`, route `'*'`
- Optional segment `/foo?` → preserved as authored
- Duplicate route `<Route path="/" />` declared twice → first kept, second emits `duplicate_route` skip

#### `router-resolve.test.ts`
- Component import resolution via tsconfig `paths` `@/`
- Component with `index.tsx` directory layout
- Unresolvable component → `sourceFile: '<unresolved>'` + `unresolved_component` skip

### 6.4 e2e test: extends `/root/SurfaceMCP/src/e2e/surfacemcp-e2e.test.ts`

Add a new top-level `describe('SurfaceMCP e2e against fixtures/vite-app')` block (mirror the nextjs-app block). The vite fixture's dev script runs Vite, but we don't actually need Vite running for `surface_list_pages` — extraction is static. Spawn SurfaceMCP only.

Cases:
1. `surface_describe_self` returns `stack: 'vite'`, `capabilities.listPages: true`.
2. `surface_list_pages` returns exactly the six pages from MUST_DISCOVER, exact-match (presence + absence).
3. `surface_list_pages({ filter: { lazy: true } })` returns exactly the lazy entries (`/about` only in this fixture).
4. `surface_list_pages({ filter: { pathPrefix: '/admin' } })` returns exactly `/admin`, `/admin/users`, `/admin/settings`.
5. `surface_list_tools` returns `[]` (no API tools in this fixture).

### 6.5 Regression test: nextjs-app remains identical

Add to `/root/SurfaceMCP/src/extract/extract.test.ts`:

```ts
describe('nextjs-app surface_list_pages regression — backward compat', () => {
  it('returns empty pages array (Next.js stack uses filesystem discovery via BugHunter, not surface_list_pages)', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const { pages, skips } = await extractPagesForStack('nextjs', root);
    expect(pages).toEqual([]);
    expect(skips).toEqual([]);
  });
});
```

The Next.js page surface is owned by BugHunter (via `discoverFilesystemPages`), not SurfaceMCP. Cross-validated in the BugHunter spec § 5.

---

## 7. Backward compat & sequencing

### 7.1 Compat guarantees

| Behavior | Pre-v0.2 | Post-v0.2 |
|---|---|---|
| `surface_list_tools` response | unchanged | unchanged (pages NOT mixed in) |
| `surface_call`, `surface_probe`, etc. | unchanged | unchanged |
| Existing fixtures (`nextjs-app`, `express-app`, `django-app`, `fastapi-app`) | green | green (regression-pinned in test § 6.5) |
| `init` for a Next.js project | writes `nextjs` surface | unchanged |
| `init` for a Vite project | error: "Could not detect stack" | writes `vite` surface (multi-surface aware) |
| `SurfaceConfig.stack` validation | rejects `'vite'` | accepts `'vite'` |

### 7.2 Init flow updates (`src/cli/init.ts`)

Add detection for Vite (`src/detect/vite.ts`):

```ts
export function isVite(root: string): boolean {
  const hasViteConfig =
    existsSync(resolve(root, 'vite.config.js')) ||
    existsSync(resolve(root, 'vite.config.ts')) ||
    existsSync(resolve(root, 'vite.config.mjs'));
  if (!hasViteConfig) return false;
  const pkgPath = resolve(root, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
    const deps = {
      ...(pkg.dependencies as Record<string, unknown> | undefined ?? {}),
      ...(pkg.devDependencies as Record<string, unknown> | undefined ?? {}),
    };
    // Accept any supported router. v0.2 only ships react-router-dom support;
    // detection is forward-compatible to avoid having to touch detect again.
    return 'react-router-dom' in deps;
  } catch {
    return false;
  }
}
```

Register in `src/detect/index.ts` BEFORE `isExpress` (a Vite app may have `express` as a dev-time dep but isn't an express server). Order:

```ts
if (isNextjs(root)) return 'nextjs';
if (isVite(root)) return 'vite';        // NEW — before express
if (isDjango(root)) return 'django';
if (isExpress(root)) return 'express';
if (isFastApi(root)) return 'fastapi';
if (isOpenApi(root)) return 'openapi';
```

Update `src/cli/init.ts`:
- `defaultLaunchCommand['vite'] = 'npm run dev'`
- `defaultBaseUrl['vite'] = 'http://localhost:5173'`
- `defaultWatchPaths['vite'] = ['src']`
- Add `detectViteDevPort(projectRoot)` mirroring `detectNextjsDevPort` — parse `vite` from the dev script; recognize `--port <n>`, `--port=<n>`, `vite --port <n>`, and the `server.port` field of `vite.config.{ts,js,mjs}` if statically declarable. If not statically declarable, fall back to default 5173.

### 7.3 Multi-surface init for full-stack repos (TraiderJo case)

`detectMultiSurface` already walks subdirs and detects each. With `isVite` registered, a TraiderJo-shape repo (`server/` is express, root is vite) produces:

```json
{
  "surfaces": [
    { "name": "root", "stack": "vite",    "root": ".",      ... },
    { "name": "server", "stack": "express", "root": "server", ... }
  ]
}
```

**Bug today** (`src/detect/monorepo.ts` lines 19-23): it pushes `{ name: 'root', root: repoRoot, stack: rootStack }` for the root. For TraiderJo, `detectStack(repoRoot)` returns `'vite'` (after this spec lands), and the existing per-subdir loop finds `server/` as `'express'`. Output is correct.

Edge: a project that is BOTH Vite AND Express at the root (e.g. a Vite app whose `server.proxy` points at an inline express server in the same package.json) — `isVite` runs first per the order above and returns `'vite'`; the express server lives in a subdir and gets detected separately. If express is colocated at the root, `detectMultiSurface` will only emit the Vite surface for root because the per-subdir loop does not also re-check the root. Document this as a limitation: **for the rare colocated case, use `--stack=express` to force a single-surface init, then hand-edit a second `vite` surface entry.** Add this to `init`'s warning output when both `vite` and `express` indicators are present at the root.

### 7.4 Catalog regen — single-surface only on the served port

Today `serve` instantiates one surface at a time. Multi-surface init writes both, but only `surfaces[0]` is served on the configured port. To serve both, run `surfacemcp serve --surface vite` and `surfacemcp serve --surface server` (separate ports — already each gets `port` allocated at init). This is **out of scope** for this spec — `serve` already supports a `--surface` flag selection. No new code needed.

For BugHunter's TraiderJo run, BugHunter must point at the **vite** SurfaceMCP for page discovery and the **express** SurfaceMCP for API tools. Today BugHunter's config has a single `surfaceMcpUrl`. Companion BugHunter spec § 4.4 addresses the multi-surface client side.

### 7.5 Build sequencing

Implement order:
1. Add `'vite'` to `Stack` type and config zod schema. All tests still green.
2. Add `src/detect/vite.ts` + register in `detect/index.ts` + add `vite-app` fixture (with `package.json` only at first; just enough to detect). Test detection.
3. Implement `extractVitePages` + unit tests (§ 6.2, § 6.3).
4. Wire into `regenerateCatalog`-equivalent for pages (`regeneratePageCatalog`); add `getPageCatalog()`.
5. Add MCP tools `surface_list_pages` + `surface_describe_self`.
6. Build out the rest of the fixture (full source files). Add e2e test § 6.4.
7. Update init (launch command, base URL, watch paths, port detection).
8. Add backward-compat regression test § 6.5.

Each step independently committable and verifiable.

---

## 8. Edge cases

### 8.1 Lazy via top-level `lazy` import (not `React.lazy`)

```tsx
import { lazy } from 'react';
const Home = lazy(() => import('./pages/Home'));
```

Pass C must recognize both `React.lazy(...)` and `lazy(...)` where `lazy` is bound to `react`'s named export. Use ts-morph symbol resolution: get the `Identifier`'s `getDefinitions()`, check that one of them imports from `'react'`.

### 8.2 `<Route index element={<X/>}>`

Already specified in § 3.2 Pass A step 4. The index route's effective path is the parent's path. If both an index route and a layout-only entry would be emitted for the same path, suppress the layout-only entry. Rationale: the layout component renders only as a wrapper around the index; the index route component is the navigable thing.

If the parent has both an index route AND children but no element prop on the parent, emit the index entry only (no layout entry).

### 8.3 Multiple routes pointing to the same component

```tsx
<Route path="/home" element={<Home />} />
<Route path="/start" element={<Home />} />
```

Both routes are emitted (different `route` strings). `componentName` and `sourceFile` are identical between them. Dedup is by `route`, not by component.

### 8.4 Dynamic / unresolvable router config

Patterns we must detect and emit a single `route_unresolved` skip for:

```tsx
// 8.4a — path is not a literal
<Route path={DYNAMIC_PATH} element={<X/>} />

// 8.4b — element is not a JSX element (e.g. fn ref)
<Route path="/foo" element={renderX} />

// 8.4c — createBrowserRouter argument is mutated
const routes = [...baseRoutes, { path: '/extra', element: <X/> }];
createBrowserRouter(routes);

// 8.4d — routes fetched from API
const routes = await fetchRoutes();
createBrowserRouter(routes);
```

For 8.4a/b: skip with `dynamic_path` and `unsupported_element` respectively. For 8.4c/d: skip with `dynamic_route_array`. Each emits ONE skip entry per unresolvable site (not one per missed route, since we don't know what we missed).

### 8.5 Tab-state routing (TraiderJo) — explicitly out of scope

Code like:

```ts
if (path === '/privacy') { setTab('privacy'); return; }
window.history.pushState(null, '', '/privacy');
```

Is NOT detected by this extractor. Detecting it requires escape-analysis of `window.history.pushState` callsites and reverse-engineering `setTab` mappings — a separate problem from router-table extraction. Documented here so future implementers know not to expand scope mid-implementation.

When a Vite project has zero discoverable routes AND `window.history.pushState` is called somewhere in the codebase, emit a single warning skip:

```json
{ "route": "<unknown>", "reason": "tab_state_routing_suspected", "detail": "<n> pushState callsites found; tab-state routing is a v0.3 feature" }
```

This makes the failure mode visible without breaking discovery.

### 8.6 `BrowserRouter` / `HashRouter` / `MemoryRouter` wrappers

Irrelevant to extraction — these are JSX wrappers that affect runtime behavior, not route declarations. The extractor scans for `<Routes>`/`<Route>` and `createBrowserRouter` regardless of the surrounding wrapper.

### 8.7 Routes declared inside conditional render

```tsx
{user ? <Routes>...</Routes> : <PublicRoutes />}
```

The extractor mines all `<Routes>`/`<Route>` it finds, regardless of conditional surroundings. This may produce a "logical superset" of actually-rendered routes. That's the correct behavior for discovery — BugHunter will exercise each route under each role and discover the conditional behavior at test time.

### 8.8 Multiple `<Routes>` blocks in the same file

Each block contributes to the same flat output. No de-duplication across blocks except by `route` string (§ 3.5).

### 8.9 Type-only imports

`import type { Foo } from './foo'` — these are erased at runtime and **never** referenced as a JSX element. Skip them in the import map walk.

### 8.10 Routes from non-`react-router-dom` packages

If `@reach/router` or `wouter` are present, `isVite` still returns true (because we check for `react-router-dom`). For a project with **only** `wouter`, `isVite` returns false and `init` errors out with "Could not detect stack". This is correct for v0.2.

---

## 9. Acceptance criteria

All criteria are concrete, testable, and gating for v0.2 release.

### 9.1 Unit + e2e

- `npm test` (vitest) green from a clean checkout.
- `src/extract/vite/router.test.ts` passes — exact-match on `MUST_DISCOVER.json` (six pages, zero extras).
- `src/extract/vite/router-jsx.test.ts`, `router-config.test.ts`, `router-edge.test.ts`, `router-resolve.test.ts` all pass.
- `src/e2e/surfacemcp-e2e.test.ts` `vite-app` block passes — exact-match against MUST_DISCOVER, plus filter-by-lazy and filter-by-pathPrefix work.
- `src/extract/extract.test.ts` regression test passes — `extractPagesForStack('nextjs', ...)` returns `[]`.
- All existing fixture extraction tests still green (no regression).

### 9.2 Init + detect

- Running `surfacemcp init` against `/root/SurfaceMCP/fixtures/vite-app` writes a `surfacemcp.config.json` with `surfaces[0].stack === 'vite'`, `baseUrl: 'http://localhost:5173'`, and a non-zero `port` allocated.
- Running `surfacemcp init --multi-surface` against a TraiderJo-shape repo (root = vite, `server/` = express) writes BOTH surfaces.
- `detectStack('/root/SurfaceMCP/fixtures/vite-app')` returns `'vite'`.

### 9.3 Live target re-smoke (TraiderJo)

After this spec lands AND BugHunter's companion spec lands:

- `surface_describe_self` against TraiderJo's vite surface returns `{ stack: 'vite', capabilities: { listPages: true } }`.
- `surface_list_pages` against TraiderJo's vite surface returns either:
  - **Empty `pages: []`** (expected — TraiderJo uses tab-state routing, not `react-router-dom`), AND
  - A non-empty `skips` (or a log line) with `tab_state_routing_suspected`.

- BugHunter `bughunter run` against `/tmp/TraiderJo` plans `0` UI tests (because `pages: []`) but completes without errors. **This is the v0.2 expected outcome**: TraiderJo is a v0.3 target. v0.2 unblocks the SPA codepath; the e2e fixture proves it works for projects that DO use `react-router-dom`.

- BugHunter's e2e harness, running against the new vite-app fixture, plans non-zero UI tests covering all six fixture routes. **This is the v0.2 functional gate.**

### 9.4 Backward compat

- `surface_list_tools` JSON shape unchanged (no `kind` field added).
- All existing BugHunter e2e tests against the nextjs-app fixture pass without modification.
- The Next.js page list emitted by BugHunter's `discoverFilesystemPages('/path/to/nextjs-app')` is byte-identical (same set, same ordering) before and after this spec lands.

### 9.5 Performance

- `extractVitePages` against the vite-app fixture completes in < 500 ms on a cold ts-morph project.
- Watcher-driven page-catalog regeneration on a single-file edit completes in < 1.5 s.

---

## 10. Open questions

(Defaults recommended inline.)

- **Q1.** Should `Page.dynamicParams` include splat (`*`) under a synthetic name? **Default: yes, name `'*'`.** Splats are common in catch-all 404 routes and BugHunter needs to know.
- **Q2.** Should we track `caseSensitive` on `<Route caseSensitive>`? **Default: no.** Defer to v0.3. Document as TODO. Practical impact: extremely rare in practice.
- **Q3.** When `tsconfig.json` has `paths: { '@/*': ['src/*'] }` AND `paths: { '~/*': ['./*'] }`, should both resolve? **Default: yes — read all `paths` entries.** Read once, cached per `Project` instance.
- **Q4.** Should the watcher trigger page-catalog regen on changes to `vite.config.{ts,js,mjs}`? **Default: yes, but the extractor only mines route-tables, so a config change rarely affects output. Cheap to regen.**

---

End of spec.
