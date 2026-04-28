# SPEC: SurfaceMCP — `surface_list_navigations` (static SPA navigation extractor)

Status: draft, ready for implementation
Owner: @architect
Companion specs: `/root/SurfaceMCP/SPEC_RUNTIME_ROUTE_ENUM.md`, `/root/BugHunter/SPEC_SPA_DEEP_CRAWL.md`

---

## 1. Problem

`surface_list_pages` (Vite extractor `src/extract/vite/router.ts`) returns the SPA's *route table*. It tells BugHunter "these URL paths exist". But many real SPAs do not navigate by URL alone:

1. **`react-router-dom` apps with `<Link>`/`<NavLink>`/`useNavigate()`** — these are URL-routed and `<Routes>` already lists their entries, but the *crawler* relies on `<a href>` to follow links between visited pages. `<Link to="/x">` renders as `<a href="/x">` at runtime, so the live DOM walker actually does see them. This case is mostly fine in practice, except for cases where a button uses `useNavigate()` programmatically (no anchor tag), or when the route table is partially incomplete (createBrowserRouter resolution skips, dynamic config, etc.).

2. **Hand-rolled tab-state SPAs** (TraiderJo is the canonical example). The "navigation" is `<button onClick={() => setTab('dashboard')}>` and the "page" is `{tab === 'dashboard' && <Dashboard />}`. There is no URL change, no `<a href>`, no router config. The crawler discovers nothing past `/`. `surface_list_pages` already emits a single `crawl_seed` page in this case (per `SPEC_CRAWL_SEED.md`), but the seed is useless without a way for the crawler to invoke the in-app transitions.

3. **`<HashRouter>` with anchor-only navigation** — `<a href="#dashboard">`. The DOM walker currently strips fragments; even if it didn't, there's no static map between the fragment and the rendered component.

4. **Programmatic `navigate('/x')` calls** — `useNavigate()` from react-router-dom v6, called inside `onClick`/`onSubmit` handlers. These don't render anchors and the URL change happens client-side.

The unifying gap: SurfaceMCP exposes *pages* (component-at-route mappings), but BugHunter's crawler also needs *transitions* (click-this-thing-to-reach-that-page). The DOM only exposes some transitions (rendered `<a href>`s); the source code carries far more, particularly for tab-state apps where the DOM has zero hints.

### 1.1 Live target

- **TraiderJo**: today, `surface_list_pages` returns one `crawl_seed` (`/`) and BugHunter reaches no further. After this spec, `surface_list_navigations` returns ~16 entries (one per literal `setTab(...)` callsite plus `<a href>` mappings for the URL-routed public surfaces). BugHunter consumes these (per `SPEC_SPA_DEEP_CRAWL.md`) and reaches dashboard / trades / settings / profile / admin / wiki / plan / import / apr / attribution.
- **Existing fixture `fixtures/vite-app/`**: unchanged routing — six static pages already extracted via `<Routes>`. `surface_list_navigations` returns the corresponding `<Link>` and `useNavigate` callsites (additive, does not replace pages). Existing BugHunter behaviour against this fixture is unchanged because the crawler dedups by URL and the new entries point at the same routes already in `surface_list_pages`.
- **react-router-dom `useNavigate` apps without `<Link>` wrappers**: previously invisible to crawl-step traversal; now visible.

### 1.2 Out of scope

- TanStack Router, wouter, Solid Router, Vue Router, SvelteKit (deferred — Phase 2 runtime enumeration covers these generically).
- Inferring tab-state from arbitrary state-management libraries (Redux, Zustand, Jotai). Only `useState<string-literal-union>` + setter-with-string-literal-arg is in scope.
- Dynamic targets — `setTab(someVariable)`, `navigate(\`/users/${id}\`)`. Statically unknowable; emitted as a skip.

---

## 2. Root cause / motivation

The Vite extractor is intentionally narrow: it extracts the *router config*. Adding "and also click handlers that change state" to `extractVitePages` would muddle the model — pages and navigations are different shapes (a navigation has no `componentName`, no route params; a page has no `triggerSelectorHint`, no `triggerMethod`).

A separate extractor + tool keeps both responsibilities single-purpose. The extractor reuses the same ts-morph `Project` setup, the same `tsconfig` paths resolution, and the same file-glob; only the AST visitor differs.

---

## 3. Design

### 3.1 New tool: `surface_list_navigations`

Returns a flat list of statically-discovered navigation transitions for the current surface. Behaves like `surface_list_pages`: cached at catalog revision, refreshed on watcher events, scoped per surface.

```jsonc
// MCP request
{ "name": "surface_list_navigations", "arguments": { "filter": { "method": "click" } } }

// MCP response (tool result content)
{
  "revision": 42,
  "navigations": [
    {
      "label": "Dashboard",                      // human-readable; from button text or Link children
      "method": "state-setter",                  // discriminant — see § 3.2
      "target": "dashboard",                     // setter argument (state name) OR URL path
      "kind": "state",                           // "url" | "state" | "hash"
      "stateVar": "tab",                         // for kind:"state"; else undefined
      "triggerSelectorHint": {                   // best-effort selector hints for the runtime DOM
        "text": "Dashboard",                     // textContent — primary; matched via :has-text() at runtime
        "testId": "nav-dashboard",               // data-testid — strongest hint when present
        "ariaLabel": "Open dashboard tab"        // aria-label — fallback hint
      },
      "sourceFile": "src/ui/App.tsx",            // project-root-relative
      "sourceLine": 188,
      "confidence": "high"                       // "high" | "medium" | "low" — see § 3.5
    },
    {
      "label": "About",
      "method": "link",
      "target": "/about",
      "kind": "url",
      "triggerSelectorHint": { "text": "About" },
      "sourceFile": "src/Nav.tsx",
      "sourceLine": 11,
      "confidence": "high"
    }
  ],
  "skips": [
    { "reason": "dynamic_target", "detail": "navigate(`/users/${id}`)", "declaredAt": { "file": "src/Nav.tsx", "line": 22 } }
  ]
}
```

#### 3.1.1 Filter

```ts
filter?: {
  method?: 'link' | 'router-link' | 'router-push' | 'state-setter';
  kind?: 'url' | 'state' | 'hash';
}
```

Optional. When omitted, returns all navigations.

### 3.2 Discriminated union — `Navigation`

Add to `src/types.ts` next to `Page`:

```ts
export type NavigationMethod =
  | 'link'           // <a href="...">
  | 'router-link'    // <Link to="..."> | <NavLink to="...">
  | 'router-push'    // useNavigate()('...') | navigate('...') | router.push('...')
  | 'state-setter';  // setTab('dashboard') with literal arg, where 'dashboard' is in the state-var union

export type NavigationKind =
  | 'url'    // target is a URL path; crawler navigates
  | 'state'  // target is a state-var value; crawler clicks the trigger
  | 'hash';  // target is a hash fragment

export type NavigationConfidence = 'high' | 'medium' | 'low';

export type Navigation = {
  /** Human-readable button/link label (best-effort: textContent of trigger element). */
  label: string;
  method: NavigationMethod;
  /** URL path for kind:'url'/'hash'; state-value for kind:'state'. Always a string literal. */
  target: string;
  kind: NavigationKind;
  /** Identifier of the state setter (e.g. 'tab', 'view', 'activeTab'). Set iff kind === 'state'. */
  stateVar?: string;
  triggerSelectorHint: {
    text?: string;
    testId?: string;
    ariaLabel?: string;
  };
  sourceFile: string;          // project-root-relative
  sourceLine: number;
  confidence: NavigationConfidence;
};

export type NavigationCatalog = {
  revision: number;
  navigations: Navigation[];
  skips: NavigationSkip[];
};

export type NavigationSkip = {
  reason:
    | 'dynamic_target'             // setX(variable) | navigate(template)
    | 'unresolved_setter'          // onClick={() => setX('foo')} but no useState declaring setX
    | 'union_overflow'             // state union > 32 members; emit none, mark surface as overflow
    | 'no_trigger_label';          // setter callsite not enclosed in a labelable trigger (no button/a/role)
  detail?: string;
  declaredAt?: { file: string; line: number };
};
```

### 3.3 Detection passes (file-by-file)

Run **after** `extractVitePages` (same Project, same file list). Each pass appends to a shared `navigations: Navigation[]` array.

#### Pass A — JSX `<Link>`/`<NavLink>` (`router-link`)

For every `JsxOpeningElement` / `JsxSelfClosingElement` whose tag name is `Link` or `NavLink` AND whose import comes from `react-router-dom` (verified via the per-file ImportMap built by `extractVitePages` — reuse `buildImportMap`):

1. Extract the `to` attribute literal (string-literal or `{ '...' }` JSX expression).
2. Skip if non-literal (push a `dynamic_target` skip).
3. Extract label: textContent of the JSX children. For `<Link to="/x">About</Link>`, label = `'About'`. For self-closing `<Link to="/x" />`, label = the trailing path segment (`'x'`).
4. Extract `data-testid` and `aria-label` attributes if present (string-literals only).
5. Emit `{ method: 'router-link', kind: 'url', target, label, triggerSelectorHint, confidence: 'high', ... }`.

#### Pass B — `<a href="...">` (`link`)

For every `JsxOpeningElement` / `JsxSelfClosingElement` whose tag name is `'a'`:

1. Extract `href` literal. Skip if non-literal, starts with `mailto:`/`tel:`/`javascript:`/`http://`/`https://` (off-origin) — these are not in-app navigations.
2. If `href.startsWith('#')`: kind = `'hash'`, target = the full href (preserves `#`).
3. Else if `href.startsWith('/')`: kind = `'url'`, target = href.
4. Else: skip with `dynamic_target` (relative paths require a base-URL context the static analyzer doesn't have).
5. Label/hints as in Pass A.
6. Emit `{ method: 'link', kind, target, ..., confidence: 'high' }`.

#### Pass C — `useNavigate()` / `navigate('...')` / `router.push('...')` (`router-push`)

For every `CallExpression` in the file:

- Match `useNavigate` *binding*: variables initialised to `useNavigate()` (capture local name; usually `navigate`).
- Match call shapes: `navigate('/x')`, `navigate('/x', { replace: true })`, `nav('/x')`, `router.push('/x')` (where `router` was assigned from `useRouter()`).
- Skip non-string-literal first arg with `dynamic_target`.
- Walk parents to find the enclosing trigger: nearest `JsxOpeningElement` / `JsxSelfClosingElement` whose tag is `'button' | 'a' | 'div' | 'span'` OR has `role="button"|"link"`. If none found within 8 parent hops, emit a `no_trigger_label` skip.
- Extract label/hints from the enclosing trigger's children/attributes (same logic as Pass A).
- Emit `{ method: 'router-push', kind: 'url', target, label, ..., confidence: 'medium' }`. `medium` because there can be multiple `navigate('/x')` callsites in one component for one button (early-returns, etc.); the static analyzer can't disambiguate which fires.

#### Pass D — Tab-state setter detection (`state-setter`)

This is the new, hard pass. Three sub-steps per file:

**D.1 — Identify state unions.** Find every `useState` callsite of the form:
```tsx
const [view, setView] = useState<'a' | 'b' | 'c'>('a');
```
Capture: state-var name (`view`), setter name (`setView`), and the union members (literal strings: `['a','b','c']`).

Acceptance shape:
- `useState` is the named import from `react` (verified via ImportMap).
- LHS is an `ArrayBindingPattern` of length 2.
- Type argument exists AND is a `UnionType` of `LiteralType` with `StringLiteral` literal members. **OR** initial value is a string literal AND the setter is called only with string literals (inferred union = set of literal args; tag confidence `medium`).
- Union members ≤ 32. If > 32, emit a `union_overflow` skip and skip this state.
- The setter name MUST start with `set` (case-insensitive prefix check) AND have ≥ 1 character after.

If no type argument and no string-literal initial, skip (the state isn't a tab-state).

**D.2 — Find setter callsites with literal args.** For each setter identifier captured in D.1, find every `CallExpression` whose expression is that identifier (binding-aware: same scope or enclosed scope; walk ts-morph symbol references).

For each callsite:
- First arg must be a `StringLiteral`. If not, emit `dynamic_target` skip and continue.
- The literal value must be a member of the union from D.1. If not, treat as `low`-confidence (the state may have grown) — still emit but with `confidence: 'low'`.

**D.3 — Resolve the enclosing trigger.** Same parent-walking logic as Pass C: find the nearest JSX trigger. If found, extract label/hints. If not, emit `no_trigger_label` skip.

Emit `{ method: 'state-setter', kind: 'state', target: literal, stateVar: <state-var name>, label, ..., confidence }`.

**D.4 — Coupling to `surface_list_pages` (cross-cutting).** When tab-state navigations exist, emit one *synthetic page entry per discovered state* into `surface_list_pages` with `route: '/?<stateVar>=<target>'` (URL-search-string-encoded synthetic route — see § 3.7 for rationale). This is additive: existing pages remain.

> **Implementation note for D.4:** the synthetic page emission lives in `extractVitePages` (it owns the Page model). The navigation extractor exposes a helper `synthesizeTabStatePages(navigations: Navigation[]): Page[]` that the page extractor calls. This keeps file boundaries clean.

#### Pass E — Hash-router anchors (already covered in Pass B; no separate code path)

`<a href="#x">` with kind `'hash'` is sufficient. No additional logic.

### 3.4 What is explicitly not detected

- Non-react-router-dom navigation libs (next/router, wouter, TanStack, react-location). Out of scope; runtime enumeration handles them.
- `setRoute(computeRoute())` where `computeRoute()` returns one of the union literals — too dynamic. Emit `dynamic_target`.
- Setter calls behind a guard: `if (auth) setTab('admin')`. The static analyzer ignores guards — it just emits the navigation. This is correct: the crawler's DOM-walk-after-click will reveal whether the destination renders.
- Multiple state vars in the same union (`useState<{tab,sub}>`). Only single-string-literal-union states.
- Reducer-based state (`useReducer`). Out of scope.

### 3.5 Confidence labels

- `'high'` — direct, unambiguous: `<Link to="/x">`, `<a href="/x">`, single setter callsite with literal arg matching declared union.
- `'medium'` — `useNavigate()` programmatic calls (multiple in one component possible), inferred-union setters (no explicit union type).
- `'low'` — setter callsites with literals not in the declared union (likely the union is stale).

BugHunter consumes high/medium by default; low is opt-in via crawler config.

### 3.6 Tool registration

Register in `src/server/http.ts` next to `surface_list_pages`:

```ts
server.tool(
  'surface_list_navigations',
  'List statically-discovered SPA navigations (links, router pushes, tab-state setters). Empty for stacks without UI route discovery.',
  {
    filter: z.object({
      method: z.enum(['link', 'router-link', 'router-push', 'state-setter']).optional(),
      kind: z.enum(['url', 'state', 'hash']).optional(),
    }).optional(),
  },
  async (args) => {
    const nc = getNavigationCatalog();
    let navs = nc.navigations;
    if (args.filter?.method) navs = navs.filter(n => n.method === args.filter!.method);
    if (args.filter?.kind) navs = navs.filter(n => n.kind === args.filter!.kind);
    return toolOk({ revision: nc.revision, navigations: navs, skips: nc.skips });
  }
);
```

Update `surface_describe_self.capabilities`:
```ts
capabilities: {
  listPages: surface.stack === 'vite',
  listNavigations: surface.stack === 'vite',  // NEW
  crawlSeed: surface.stack === 'vite',
}
```

### 3.7 Why synthetic `/?stateVar=value` routes

BugHunter's `DiscoveredPage.route` is keyed by string. Tab-state apps need *some* canonical key per state. Options considered:

- **`/dashboard`** — collides with real URL routes if the app also has `/dashboard`. Rejected.
- **`/<tab=dashboard>`** — non-URL; breaks `new URL()` in the crawler. Rejected.
- **`/?tab=dashboard`** — valid URL, parseable, and the crawler already understands query-string normalisation. The "?" prefix makes it human-readable as "this is state, not path." **Selected.**
- **`/#tab=dashboard`** — collides with real hash routing. Rejected.

The crawler treats these as synthetic: it does not navigate to that URL; it clicks the trigger and observes the DOM (per `SPEC_SPA_DEEP_CRAWL.md`).

### 3.8 Catalog wiring

Mirror `surface_list_pages`:

- New file: `src/extract/vite/navigations.ts` with `extractViteNavigations(root: string): Promise<{ navigations: Navigation[]; skips: NavigationSkip[] }>`.
- New entry in `src/extract/pages/index.ts` registry → `src/extract/navigations/index.ts` (parallel structure) with `extractNavigationsForStack(stack, root)`.
- New module `src/server/navigation-catalog.ts` — the in-memory `NavigationCatalog` cache, parallel to `getPageCatalog()`.
- `regenerateCatalog` in `src/server/tools-meta.ts` — also regenerates the navigation catalog.

Stacks other than `'vite'`: registry returns `{ navigations: [], skips: [] }`. The tool still exists but returns empty. (Same pattern as `surface_list_pages` for express/django/etc.)

---

## 4. Files

### Files you MUST read before writing any code

- `src/extract/vite/router.ts` — page extractor; navigation extractor must reuse `buildImportMap`, `loadPathsMap`, `resolveImportSpecifier`, `tryResolveFile`. Either export those helpers from `router.ts` or move them to a sibling `vite/util.ts` and import from both. Choose the latter to avoid circular imports.
- `src/extract/pages/index.ts` — pattern for stack registry.
- `src/server/tools-meta.ts` — pattern for in-memory catalog cache + watcher integration.
- `src/server/http.ts` — pattern for tool registration; `surface_list_pages` is the closest analogue.
- `src/types.ts` — add `Navigation*` types here (do NOT create a new types file).
- `fixtures/vite-app/src/App.tsx` — reference for how the existing Routes-based fixture looks.

### Files to create

- `src/extract/vite/util.ts` — extract shared helpers from `router.ts` (paths, ImportMap, resolveImportSpecifier, tryResolveFile). New file because router.ts is already 750 lines and at the file-size soft cap.
- `src/extract/vite/navigations.ts` — new extractor (max 500 lines).
- `src/extract/vite/navigations.test.ts` — unit tests (max 400 lines).
- `src/extract/navigations/index.ts` — stack registry (≤ 30 lines).
- `src/server/navigation-catalog.ts` — in-memory cache (≤ 80 lines).
- `fixtures/vite-tab-state-app/` — new fixture mirroring TraiderJo's pattern (see § 6.4).
  - `package.json`, `index.html`, `vite.config.ts`, `tsconfig.json` (copy from `vite-app`).
  - `src/main.tsx`, `src/App.tsx` (the tab-state main file).
  - `src/pages/Dashboard.tsx`, `src/pages/Trades.tsx`, `src/pages/Settings.tsx`, `src/pages/Profile.tsx`.
  - `MUST_DISCOVER.json` — listing the 4 expected navigations.
  - `surfacemcp.config.json`.

### Files to modify

- `src/extract/vite/router.ts` — extract helpers to `util.ts` (change imports only; logic untouched). Add `synthesizeTabStatePages(navigations): Page[]` consumption — call it from `extractVitePages` at the end, merging into output.
- `src/extract/pages/index.ts` — no change (registry stays as-is, but verify the page-list still includes the synthetic tab-state pages).
- `src/types.ts` — add `Navigation`, `NavigationMethod`, `NavigationKind`, `NavigationConfidence`, `NavigationCatalog`, `NavigationSkip`. Add `listNavigations` to capabilities discriminator.
- `src/server/tools-meta.ts` — add `getNavigationCatalog()`, regenerate it alongside the page catalog in `regenerateCatalog`.
- `src/server/http.ts` — register `surface_list_navigations`; add `listNavigations: true` to `surface_describe_self` capabilities for `vite`.
- `src/extract/extract.test.ts` — add tests for the new fixture.

### Files NOT to touch

- Any file under `src/extract/{nextjs,express,fastapi,django,openapi}/` — out of scope.
- `src/auth/`, `src/probe/`, `src/classify/`, `src/samples/`, `src/cli/` — unrelated.
- The `surface_list_pages` tool implementation — leave behaviour unchanged for non-tab-state cases.

---

## 5. Edge cases

| # | Case | Expected |
|---|------|----------|
| 1 | `<Link to={dynamicVar}>` | Skip with `dynamic_target` |
| 2 | `<Link to="/x" />` self-closing | Emit; label = `"x"` (last path segment) |
| 3 | `<a href="https://external.com">` | Ignore (off-origin) — not a skip, just absent |
| 4 | `<a href="mailto:x@y">` | Ignore (non-http) |
| 5 | `<a href="#section">` | Emit kind:'hash', target:'#section' |
| 6 | `useNavigate()` aliased: `const goTo = useNavigate(); goTo('/x')` | Detect via local-name binding |
| 7 | `navigate('/x', { replace: true })` | Emit; second arg ignored |
| 8 | `navigate(\`/users/${id}\`)` template literal | Skip with `dynamic_target` |
| 9 | `setTab('dashboard')` outside an enclosing trigger (e.g. inside a `useEffect`) | Skip with `no_trigger_label` |
| 10 | `setTab('admin')` where `'admin'` is NOT in the declared union | Emit with `confidence:'low'` |
| 11 | Two state vars with the same setter name in different files | Emit each separately (file-scoped) |
| 12 | `useState('home')` (no type arg, inferred from initial) | Inferred union = `{'home'}` initially; expand by scanning all setter callsites for literals — see D.1 second bullet |
| 13 | `setTab(prev => prev === 'a' ? 'b' : 'a')` updater function | Skip with `dynamic_target` (first arg is not a literal) |
| 14 | `setTab((t) => 'foo')` arrow returning literal | Skip with `dynamic_target` (we don't introspect arrow bodies) |
| 15 | Same `<Link to="/x">` rendered in 3 places in one file | Emit 3 navigations (deduplication is BugHunter's responsibility — same target, different sourceLines) |
| 16 | `<a>Link without href</a>` | Ignore (no href attribute) |
| 17 | TraiderJo's `setTab` invoked from a key bound in a CommandPalette object literal: `{ id: 'apr', run: () => setTab('apr') }` | Trigger search must succeed: walk up to the enclosing JSX `<button>`/`<MenuItem>` if the object is later rendered into one. **Decision:** if no enclosing JSX trigger found within the same component, emit `no_trigger_label` skip. (TraiderJo's command palette will end up as skips — acceptable; the dashboard buttons still work.) |
| 18 | Setter call inside an `if/else` branch | Emit one navigation per literal target; the trigger label is whichever JSX wraps the if/else (may be the same trigger producing two navigations) |
| 19 | Union with > 32 members | `union_overflow` skip |
| 20 | Component re-exports `Link` from a wrapper: `import { Link } from '../components/Link'` | Skip detection (we cannot prove it's react-router-dom). Emit only when import source is exactly `'react-router-dom'` or matches via tsconfig path alias to a known wrapper (out of scope; leave as a known limitation in the README). |
| 21 | JSX trigger whose `data-testid` is dynamic: `<button data-testid={\`nav-${name}\`}>` | Hint omitted (not a literal) |
| 22 | Button text containing JSX: `<button>Go to <strong>Dashboard</strong></button>` | Label = `"Go to Dashboard"` (concatenate text descendants, strip whitespace, max 80 chars) |
| 23 | `setTab` called inside a callback prop of a child component: `<Modal onConfirm={() => setTab('x')}>` | Trigger = the `<Modal>` element. Label = best-effort (Modal's title attr if string-literal; else `"Modal"`). `confidence:'medium'` |
| 24 | TypeScript file with parse errors | Skip the file silently (parity with router.ts behaviour) |

---

## 6. Tests

### 6.1 Unit tests — `src/extract/vite/navigations.test.ts`

Use the same `Project` setup as `router.test.ts`. Each case asserts a specific navigation shape against a small inline fixture.

Required cases (one `it()` each, named to match § 5 numbering where applicable):

1. **link/static-href** — `<a href="/about">About</a>` → `{ method:'link', kind:'url', target:'/about', label:'About', confidence:'high' }`.
2. **link/external-ignored** — `<a href="https://x.com">` → no entry.
3. **link/mailto-ignored** — `<a href="mailto:x@y">` → no entry.
4. **link/hash** — `<a href="#section">` → kind:'hash'.
5. **router-link/static** — `<Link to="/about">About</Link>` (with `import { Link } from 'react-router-dom'`) → `{ method:'router-link', target:'/about', confidence:'high' }`.
6. **router-link/dynamic** — `<Link to={path}>` → skip `dynamic_target`.
7. **router-link/wrong-import** — `<Link to="/x">` imported from `'../components/Link'` → no entry (skip silently).
8. **router-push/useNavigate** — `const navigate = useNavigate(); <button onClick={() => navigate('/x')}>X</button>` → `{ method:'router-push', target:'/x', label:'X', confidence:'medium' }`.
9. **router-push/dynamic** — `navigate(\`/x/${id}\`)` → skip.
10. **state-setter/explicit-union** — see § 6.2 detailed fixture.
11. **state-setter/inferred-union** — `useState('home')` + setter calls with `'home'` and `'about'` literals → both emitted; confidence `'medium'`.
12. **state-setter/literal-not-in-union** — `setTab('mystery')` where union is `{'a','b'}` → emit confidence `'low'`.
13. **state-setter/dynamic** — `setTab(name)` → skip `dynamic_target`.
14. **state-setter/no-trigger** — `useEffect(() => { setTab('x') })` → skip `no_trigger_label`.
15. **state-setter/union-overflow** — union with 33 members → skip `union_overflow`.
16. **state-setter/updater-fn** — `setTab(prev => 'x')` → skip.
17. **synthetic-page** — fixture with one tab-state state var `tab` ∈ {'a','b'} → `extractVitePages` returns synthetic pages `/?tab=a` and `/?tab=b`.
18. **trigger-label/nested-jsx** — `<button>Go to <strong>X</strong></button>` → label `"Go to X"`.
19. **trigger-label/testid** — `<button data-testid="nav-dash" onClick={...setTab('dash')}>Dashboard</button>` → hint includes testId.
20. **trigger-label/aria-label** — `<button aria-label="Open dashboard"...>` → hint includes ariaLabel.
21. **multiple-callsites-same-target** — three `<Link to="/x">` in one file → three Navigation entries, distinct sourceLines.
22. **dedup-vs-pages** — fixture with both `<Routes>` AND tab-state: pages from `<Routes>` and synthetic `/?tab=*` pages **coexist**; navigations include both `<Link>` and `setTab` entries (no dedup at the navigations layer).

### 6.2 The TraiderJo-style fixture

`fixtures/vite-tab-state-app/src/App.tsx` (≤ 80 lines):

```tsx
import { useState } from 'react';
import { Dashboard } from './pages/Dashboard';
import { Trades } from './pages/Trades';
import { Settings } from './pages/Settings';
import { Profile } from './pages/Profile';

type Tab = 'dashboard' | 'trades' | 'settings' | 'profile';

export function App() {
  const [tab, setTab] = useState<Tab>('dashboard');
  return (
    <div>
      <nav>
        <button onClick={() => setTab('dashboard')}>Dashboard</button>
        <button onClick={() => setTab('trades')}>Trades</button>
        <button data-testid="nav-settings" onClick={() => setTab('settings')}>Settings</button>
        <button aria-label="My profile" onClick={() => setTab('profile')}>Profile</button>
      </nav>
      {tab === 'dashboard' && <Dashboard />}
      {tab === 'trades' && <Trades />}
      {tab === 'settings' && <Settings />}
      {tab === 'profile' && <Profile />}
    </div>
  );
}
```

`MUST_DISCOVER.json`:
```json
{
  "navigations": [
    { "method": "state-setter", "target": "dashboard", "label": "Dashboard", "stateVar": "tab", "confidence": "high" },
    { "method": "state-setter", "target": "trades", "label": "Trades", "stateVar": "tab", "confidence": "high" },
    { "method": "state-setter", "target": "settings", "label": "Settings", "stateVar": "tab", "triggerSelectorHint.testId": "nav-settings", "confidence": "high" },
    { "method": "state-setter", "target": "profile", "label": "Profile", "stateVar": "tab", "triggerSelectorHint.ariaLabel": "My profile", "confidence": "high" }
  ],
  "syntheticPages": [
    { "route": "/?tab=dashboard" },
    { "route": "/?tab=trades" },
    { "route": "/?tab=settings" },
    { "route": "/?tab=profile" }
  ]
}
```

Add an integration test in `src/extract/extract.test.ts`:

```ts
describe('vite-tab-state-app navigation extraction', () => {
  it('discovers all must-discover navigations', async () => {
    const root = resolve(FIXTURES, 'vite-tab-state-app');
    const { navigations } = await extractViteNavigations(root);
    const must = loadMustDiscover('vite-tab-state-app');
    for (const expected of must.navigations) {
      const found = navigations.find(n => n.target === expected.target && n.method === expected.method);
      expect(found, `Missing navigation: ${expected.method}/${expected.target}`).toBeDefined();
      expect(found!.label).toBe(expected.label);
      expect(found!.confidence).toBe(expected.confidence);
    }
  });

  it('synthesizes one tab-state page per state value', async () => {
    const root = resolve(FIXTURES, 'vite-tab-state-app');
    const { pages } = await extractVitePages(root);
    const must = loadMustDiscover('vite-tab-state-app');
    const routes = new Set(pages.map(p => p.route));
    for (const expected of must.syntheticPages) {
      expect(routes.has(expected.route), `Missing synthetic page: ${expected.route}`).toBe(true);
    }
  });
});
```

### 6.3 Negative regression — `vite-app` (existing fixture)

```ts
it('vite-app navigations: no false positives on Routes-based fixture', async () => {
  const root = resolve(FIXTURES, 'vite-app');
  const { navigations } = await extractViteNavigations(root);
  // vite-app has zero <Link>/<a>/setTab usage; only <Routes>.
  expect(navigations.filter(n => n.method === 'state-setter')).toEqual([]);
  // ... but if Home.tsx renders <Link>, those would appear; assert against fixture content.
});

it('vite-app: surface_list_pages output unchanged', async () => {
  const root = resolve(FIXTURES, 'vite-app');
  const { pages } = await extractVitePages(root);
  expect(pages.map(p => p.route).sort()).toEqual(['/', '/about', '/admin', '/admin/settings', '/admin/users', '/users/:id'].sort());
  expect(pages.every(p => !p.route.startsWith('/?'))).toBe(true);  // no synthetic pages
});
```

### 6.4 Live TraiderJo smoke

Optional / out-of-CI: a manual run script `scripts/smoke-traiderjo.sh` that:
1. Points `extractViteNavigations` at `/tmp/TraiderJo`.
2. Asserts ≥ 12 navigations with `method: 'state-setter'` and target ∈ {dashboard, trades, settings, plan, import, apr, ...} (subset check).
3. Documents the exit criterion in the script comments.

This is *not* a unit test (TraiderJo lives outside the repo); it's a manual confirmation gate for the spec.

---

## 7. Acceptance criteria

- [ ] `surface_list_navigations` returns `{ revision, navigations, skips }` for a vite surface.
- [ ] `vite-tab-state-app` fixture: all 4 setTab callsites detected with correct labels, hints, and confidence.
- [ ] `vite-tab-state-app` fixture: 4 synthetic pages emitted at `/?tab=<value>`.
- [ ] `vite-app` fixture: existing pages list unchanged (regression).
- [ ] `vite-app` fixture: any `<Link>`/`<a>` in `Home.tsx` etc. correctly emitted as router-link/link.
- [ ] All 22 unit-test cases in § 6.1 pass.
- [ ] `npm run typecheck` clean (no `any`, no `as any` introduced).
- [ ] `npm run lint` clean.
- [ ] `npm run test` clean.
- [ ] `surface_describe_self.capabilities.listNavigations === true` for vite, `false`/absent for other stacks.
- [ ] Empty navigation list for non-vite stacks (express, django, fastapi, openapi, nextjs).
- [ ] No new heavy deps (only ts-morph; already a dep).
- [ ] Watcher: editing a `.tsx` file triggers regeneration of both page catalog and navigation catalog.

---

## 8. Risks

| Risk | Mitigation |
|------|-----------|
| ts-morph performance on large codebases when scanning every CallExpression | Skip files unlikely to contain navigations: only `.tsx` and `.jsx` (skip pure `.ts`/`.js` for Pass A/B/D); Pass C still runs on all). Cache the file-glob result already shared with router.ts. |
| Setter callsites in deeply nested closures evading the parent-walk for trigger labels | Document the 8-hop limit; emit `no_trigger_label` rather than guess. Coder may iterate later if real fixtures fail. |
| Symbol resolution across re-exports — `import { Link } from 'wrappers/Link'` that re-exports from react-router-dom | Out of scope; coder must NOT add cross-file symbol resolution. Add a README note. |
| TraiderJo's union (~18 members) may bump up against the 32-member ceiling later | 32 is already 1.7x TraiderJo's count; document the limit in the navigation-extractor's source. |
| Synthetic `/?tab=x` routes accidentally clash with a real query-string route in the same app | The crawler dedups by `(path + query)`; if the real app uses `?tab=` for something else, the synthetic page may shadow it. **Mitigation:** include the source-file in the dedup key for tab-state pages. Practical: such collisions are vanishingly rare; documented as a known limitation. |
| Performance regression on the watcher (now extracts twice per file change) | Both extractors share file-load + Project. Acceptable: extract them in parallel within `regenerateCatalog`. |
| New tool name conflicts with future MCP convention | `surface_list_navigations` follows the existing `surface_list_*` pattern (tools, pages); low risk. |

---

## 9. Open questions

None blocking implementation. Items deferred to follow-up specs:
- Should `surface_list_navigations` include a `pageRoute` field linking to which `surface_list_pages` entry the trigger lives on? **Decision:** out of scope; the BugHunter crawler can correlate via `sourceFile` if needed.
- Cross-file setter detection — `setTab` defined in a context provider, consumed in 50 files. **Decision:** out of scope; emit per-file findings and let users add `data-testid` for cross-file robustness.
- Wouter / TanStack / Vue Router static analysis. **Decision:** runtime enumeration (companion spec) covers these.

---

## 10. Negative requirements

- Do NOT modify any existing test in `src/extract/extract.test.ts` other than to **add** new `describe()` blocks.
- Do NOT change the existing `Page` type fields. Adding new types is fine; mutating `Page` is not.
- Do NOT use `any`. If ts-morph node typing forces it, narrow with `asKindOrThrow`.
- Do NOT introduce a new ts-morph `Project` instance — reuse the one from `extractVitePages` via the shared util.
- Do NOT add JSDoc-only comments to satisfy lint; if a function needs a comment, it's because the function isn't self-explanatory — refactor.
- Do NOT skip union-detection when the type argument is missing; fall back to inferred-union (this is the TraiderJo case for some setters).
- Do NOT emit duplicate Navigation entries for the same `(sourceFile, sourceLine, target)` triple — dedup at extractor output.
- Do NOT modify the BugHunter repo from this PR. Coordination spec lives in `/root/BugHunter/SPEC_SPA_DEEP_CRAWL.md`.

---

## 11. Task breakdown

Each task is independently completable and verifiable.

### Task 1 — Type additions
**Files to modify:** `src/types.ts`
**Files to create:** none
**Test:** `npm run typecheck`
**Done when:** `Navigation`, `NavigationMethod`, `NavigationKind`, `NavigationConfidence`, `NavigationCatalog`, `NavigationSkip` exist and compile. Add `listNavigations?: boolean` to capabilities.

### Task 2 — Extract shared helpers from router.ts
**Files to modify:** `src/extract/vite/router.ts`
**Files to create:** `src/extract/vite/util.ts`
**Test:** `npm run test src/extract/vite` — all existing router tests pass unchanged.
**Done when:** `loadPathsMap`, `resolveImportSpecifier`, `tryResolveFile`, `buildImportMap` are exported from `util.ts` and imported by `router.ts`.

### Task 3 — Static link detection (Pass A + B)
**Files to create:** `src/extract/vite/navigations.ts`, `src/extract/vite/navigations.test.ts`
**Test:** `npm run test src/extract/vite/navigations`
**Done when:** test cases 1-7 pass.

### Task 4 — useNavigate / programmatic push detection (Pass C)
**Files to modify:** `src/extract/vite/navigations.ts`, `src/extract/vite/navigations.test.ts`
**Test:** test cases 8-9 pass.

### Task 5 — Tab-state setter detection (Pass D, skipping D.4)
**Files to modify:** same
**Test:** test cases 10-16, 18-23 pass.

### Task 6 — Synthetic page emission (Pass D.4)
**Files to modify:** `src/extract/vite/router.ts`, `src/extract/vite/navigations.ts`
**Files to create:** none
**Test:** test case 17 passes; `vite-app` regression in § 6.3 passes.

### Task 7 — Stack registry + catalog
**Files to create:** `src/extract/navigations/index.ts`, `src/server/navigation-catalog.ts`
**Files to modify:** `src/server/tools-meta.ts`
**Test:** unit test the registry returns `{ navigations: [], skips: [] }` for non-vite stacks.

### Task 8 — Tool registration
**Files to modify:** `src/server/http.ts`
**Test:** add an HTTP-level test in `src/server/http-crawl-seed.test.ts` (or new `http-navigations.test.ts`) calling `surface_list_navigations` against the tab-state fixture.

### Task 9 — Fixture
**Files to create:** `fixtures/vite-tab-state-app/**`
**Test:** integration test in `src/extract/extract.test.ts` passes.

### Task 10 — Documentation
**Files to modify:** `README.md` (one paragraph under "Capabilities").
**Test:** none.

---

## 12. Estimated effort

≈ 1 senior engineer-day for an experienced TypeScript/AST author. Coder-implementable end-to-end; no architectural decisions left unresolved.
