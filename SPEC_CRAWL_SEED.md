# SPEC: SurfaceMCP v0.2.1 — `crawl_seed` source for SPAs without a recognized router

Status: draft, ready for implementation
Owner: @architect
Target version: SurfaceMCP v0.2.1
Companion spec: `/root/BugHunter/SPEC_CRAWLER.md`

---

## 1. Problem

SurfaceMCP v0.2 added the Vite extractor (`src/extract/vite/router.ts`) which mines `<Routes>/<Route>` JSX and `createBrowserRouter([...])` config. For Vite apps with `react-router-dom`, this returns a list of routes that BugHunter can iterate.

But many Vite SPAs don't use `react-router-dom`. TraiderJo (Vite + React + Express backend) routes via hand-rolled `window.location.pathname` matching against a `tab` state. Vue Router uses a different config shape. Wouter and TanStack Router are different again. v0.2 explicitly deferred those ("`tab_state_routing_suspected`" skip + § 8.5 in `SPEC_VITE_DISCOVERY.md`).

The deferred-pattern list grows with each new framework. Per-framework extractors are expensive and wrong-shaped: they re-implement what the runtime DOM already exposes (links). The higher-leverage path: **emit a single seed page (`/`), and let BugHunter's existing browser+DOM walker discover the rest by following links.** Discovery becomes router-agnostic; new frameworks just work.

This spec is the **producer half** of that pipeline. SurfaceMCP returns a seed when:
1. The stack is `vite`.
2. Static extraction produced zero pages.

The seed is structurally a `Page`, with one new field: `source: 'crawl_seed'`. BugHunter's discovery dispatcher sees the new source value and triggers crawl mode (specced separately in `/root/BugHunter/SPEC_CRAWLER.md`).

### 1.1 Live target

- TraiderJo: today returns 0 pages (tab-state routing suspected). After this spec + the BugHunter crawler, it returns 1 seed page; BugHunter crawls outward from `/` and lands ≥ 5 distinct UI routes.
- Existing fixture `fixtures/vite-app/` (uses `react-router-dom`): unchanged — static extraction returns six pages with no `source` field, no seed.

---

## 2. Root cause / motivation

The Vite extractor today has exactly one fallback when nothing extracts: emit a `tab_state_routing_suspected` skip if `window.history.pushState` callsites are detected, otherwise return empty. Both branches yield zero pages — BugHunter then plans zero UI tests for the surface, regardless of whether the app actually has a navigable UI.

Adding a `crawl_seed` page to the empty-result branch is a one-line change in produce, plus a new field on `Page`. It opens the door to runtime discovery without any per-framework code.

---

## 3. Design

### 3.1 New field: `Page.source`

Add to `src/types.ts` (`Page`):

```ts
export type PageSource = 'static' | 'crawl_seed';

export type Page = {
  /** ... existing fields ... */
  /**
   * How this page entry was produced.
   * - 'static': extracted from source code (default; backward-compatible).
   * - 'crawl_seed': emitted as a starting URL for runtime crawl-based discovery.
   *   Consumer (e.g. BugHunter) is expected to navigate the route, walk the DOM,
   *   follow same-origin links, and recursively discover more pages.
   * Optional for backward-compat: missing/undefined ≡ 'static'.
   */
  source?: PageSource;
};
```

`PageSource` is a discriminated string union (per `/root/.claude/CLAUDE.md` "Discriminated unions over string conventions"). Two values today; design admits more (e.g. `'inferred'` later) without breaking consumers — they can switch on `source` exhaustively.

`source` is **optional** so pre-v0.2.1 callers don't break; new code branches on `p.source === 'crawl_seed'`. After two minor releases the field becomes required (track in v0.4 cleanup spec).

For seed pages, the rest of the `Page` shape:
- `route: '/'`
- `sourceFile: '<unresolved>'` (no source code points at the seed; reuse the existing sentinel)
- `componentName: undefined`
- `lazy: false`
- `dynamicParams: []`
- `declaredAt: { file: '<crawl-seed>', line: 0 }` (sentinel; never read except for logging)
- `source: 'crawl_seed'`

`<crawl-seed>` is a literal string sentinel. BugHunter never resolves it as a real path (its existing `'<unresolved>'` handling kicks in via the `sourceFile` field; `declaredAt.file` is logging-only).

### 3.2 New skip reason: `crawl_seed_emitted` (informational)

Add to the `PageSkip.reason` union:

```ts
export type PageSkip = {
  route: string;
  reason:
    | 'dynamic_path'
    | 'dynamic_route_array'
    | 'unsupported_router_arg'
    | 'duplicate_route'
    | 'unresolved_component'
    | 'unresolved_lazy_import'
    | 'tab_state_routing_suspected'
    | 'crawl_seed_emitted';   // new — informational, signals consumers
  detail?: string;
  declaredAt?: { file: string; line: number };
};
```

When the extractor falls back to a seed, it pushes ONE skip entry:

```ts
{
  route: '/',
  reason: 'crawl_seed_emitted',
  detail: '<reason summary, see § 3.4>',
}
```

This makes the fallback observable in the existing skip list (already surfaced via `surface_list_pages` § 4.4). BugHunter logs it for visibility.

### 3.3 New capability flag: `capabilities.crawlSeed`

Extend `surface_describe_self` capabilities:

```ts
capabilities: {
  listPages: surface.stack === 'vite',
  crawlSeed: surface.stack === 'vite',  // new
};
```

`crawlSeed: true` advertises that this surface MAY return crawl-seed pages. BugHunter's discovery dispatcher reads this to know it's allowed to enter crawl mode without rejecting the unfamiliar shape. Older BugHunter clients ignore unknown fields.

For backward-compat: clients that don't read `crawlSeed` still see a `Page` with `route: '/'` and an unfamiliar `source` field. The `source` field is on the wire as `'crawl_seed'`; older clients that destructure only `route` + `sourceFile` work as if the seed were a real page (and would attempt to walk `'<unresolved>'`-style — same fallback path the existing code already takes for unresolved sources). The capability flag is the explicit signal; the source field is the typed signal. Both are advisory; neither breaks compatibility.

### 3.4 Modified Vite extractor — fallback insertion

`src/extract/vite/router.ts` `extractVitePages` currently ends:

```ts
if (dedupedPages.length === 0) {
  const pushStateCount = detectTabStateRouting(files);
  if (pushStateCount > 0) {
    allSkips.push({ route: '<unknown>', reason: 'tab_state_routing_suspected', ... });
  }
}
// sort + return
```

Replace with:

```ts
if (dedupedPages.length === 0) {
  const pushStateCount = detectTabStateRouting(files);
  const reasonDetail = pushStateCount > 0
    ? `tab-state routing suspected (${pushStateCount} pushState callsites); seeding crawl from /`
    : 'no static routes resolved; seeding crawl from /';

  // Emit the crawl seed page
  dedupedPages.push({
    route: '/',
    sourceFile: '<unresolved>',
    componentName: undefined,
    lazy: false,
    dynamicParams: [],
    declaredAt: { file: '<crawl-seed>', line: 0 },
    source: 'crawl_seed',
  });

  // Emit informational skip so consumers can observe the fallback
  allSkips.push({
    route: '/',
    reason: 'crawl_seed_emitted',
    detail: reasonDetail,
  });

  // Keep the existing tab-state diagnostic skip alongside the seed
  if (pushStateCount > 0) {
    allSkips.push({
      route: '<unknown>',
      reason: 'tab_state_routing_suspected',
      detail: `${pushStateCount} pushState callsites found`,
    });
  }
}
```

Statically-extracted pages get `source: 'static'` (or omitted; either is valid). Seeds get `source: 'crawl_seed'`.

To set `source` on static pages explicitly, the extractor's `pages.push({...})` calls (in `walkJsxRoutes`, `processRouteObject`, etc.) get one new field: `source: 'static'`. This makes the contract explicit on the wire and avoids ambiguity.

### 3.5 Detection — no change to `isVite()`

`src/detect/vite.ts` `isVite()` today requires `react-router-dom`. **Do not relax** in this spec. Rationale:

- Auto-detect for `surfacemcp init` is a one-time hint. A fresh TraiderJo-shape repo has both Vite and Express; today auto-detect picks Vite (via `react-router-dom`), and falls through to Express otherwise. Loosening would change classification for repos with `vite.config` + no router (rare) — risks false positives for projects that use Vite for build-only (e.g. component libraries).
- This spec assumes the surface is **explicitly configured** as `stack: 'vite'` in `surfacemcp.config.json`. The user wires it; SurfaceMCP doesn't have to guess.
- The fallback only fires when the configured stack is `vite` AND extraction is empty.

**Open question Q1** (§ 7): defer `isVite()` loosening to v0.3. Document workaround in `surfacemcp init` UX: when init detects Vite but skips it (no router), print a hint:

> Vite detected but no recognized router. If this app routes via custom code (tab-state, hand-rolled history), set `stack: 'vite'` manually in `surfacemcp.config.json` and SurfaceMCP will return a crawl seed.

(Implementation: add the hint to `src/cli/init.ts` after the existing detect call falls through.)

### 3.6 `surface_list_pages` filtering interaction

`surface_list_pages({ filter: { lazy: true } })` filters out the seed (because `seed.lazy === false`). `filter: { pathPrefix: '/' }` includes the seed. No change to filter logic — just consumers should be aware.

`surface_list_pages` (no filter) returns the seed when present.

### 3.7 `crawlSeed` on `surface_describe_self` — consumer guidance

```ts
{
  name: 'traider-jo',
  stack: 'vite',
  baseUrl: 'http://localhost:8787',
  toolRevision: 12,
  pageRevision: 3,
  capabilities: {
    listPages: true,
    crawlSeed: true,
  },
}
```

A consumer that supports crawling reads `capabilities.crawlSeed === true` and is prepared to receive `Page` entries with `source: 'crawl_seed'`. A consumer that doesn't is unaffected: the seed still has a usable `route` field.

---

## 4. Files

### Files to modify

- `/root/SurfaceMCP/src/types.ts` — add `PageSource` type; add `source?: PageSource` to `Page`; add `'crawl_seed_emitted'` to `PageSkip.reason` union.
- `/root/SurfaceMCP/src/extract/vite/router.ts` — replace the empty-result branch (§ 3.4); set `source: 'static'` on existing `pages.push(...)` calls (4 callsites: 2 in `walkJsxRoutes`, 2 in `processRouteObject`).
- `/root/SurfaceMCP/src/server/http.ts` — add `crawlSeed: surface.stack === 'vite'` to the `surface_describe_self` capabilities object.
- `/root/SurfaceMCP/src/cli/init.ts` — print the hint message when `isVite()` returned false but `vite.config.*` exists (one extra `existsSync` check, then `console.log`).

### Files to create

- `/root/SurfaceMCP/src/extract/vite/router-crawl-seed.test.ts` — unit tests for the seed emission (§ 5.2).

### Files NOT to modify

- `src/detect/vite.ts` — no change in v0.2.1 (deferred).
- `src/extract/pages/index.ts` — no change. The extractor registry stays. Vite extractor self-contains the seed logic.
- `src/extract/nextjs/**`, `src/extract/express/**`, `src/extract/fastapi/**`, `src/extract/django/**`, `src/extract/openapi/**` — must NOT emit seeds (no UI for non-vite stacks today).
- `surfacemcp.config.example.json` — no schema change required.

---

## 5. Tests

### 5.1 Type-level

`src/types.ts` test: import `PageSource` and assert it equals `'static' | 'crawl_seed'`. The type exists primarily as an exhaustiveness aid for downstream consumers; the test is one assertion + one switch with `assertNever`.

### 5.2 Unit — `src/extract/vite/router-crawl-seed.test.ts`

Cases (each backed by an inline tmp-fixture or parametrized over `extractVitePages`):

1. **Empty src/ — seed emitted, no static pages.**
   - Fixture: `vite.config.ts` only (no `src/App.tsx` with routes).
   - Assert `pages.length === 1`.
   - Assert `pages[0].route === '/'`.
   - Assert `pages[0].source === 'crawl_seed'`.
   - Assert `pages[0].sourceFile === '<unresolved>'`.
   - Assert `skips.some(s => s.reason === 'crawl_seed_emitted')`.
   - Assert `skips.find(s => s.reason === 'crawl_seed_emitted')!.detail` contains `"no static routes resolved"`.

2. **Tab-state routing fixture — seed AND tab-state skip both present.**
   - Fixture: `src/App.tsx` containing `window.history.pushState({}, '', '/dashboard')` with no `<Route>` JSX.
   - Assert `pages.length === 1` and `pages[0].source === 'crawl_seed'`.
   - Assert `skips.some(s => s.reason === 'crawl_seed_emitted')`.
   - Assert `skips.some(s => s.reason === 'tab_state_routing_suspected')`.
   - Assert `seedSkip.detail` contains `"tab-state routing suspected"`.

3. **react-router-dom fixture (existing `fixtures/vite-app/`) — NO seed, six static pages.**
   - Run `extractVitePages('/root/SurfaceMCP/fixtures/vite-app')`.
   - Assert `pages.length === 6`.
   - Assert `pages.every(p => p.source === 'static')`.
   - Assert `skips.every(s => s.reason !== 'crawl_seed_emitted')`.
   - This is the regression-pin for the existing v0.2 extractor.

4. **createBrowserRouter present but argument unresolvable — NO seed (skip emitted, no pages, but extractor saw the marker).**
   - Wait — re-read § 3.4: the seed fires when `dedupedPages.length === 0`. An unresolvable router argument produces 0 pages + a `dynamic_route_array` skip. Should it ALSO seed?
   - Decision: **YES.** From the consumer's point of view, "0 pages discovered" is the same regardless of why. The seed gives them a working starting point.
   - Assert `pages.length === 1`, `pages[0].source === 'crawl_seed'`, AND `skips` contains `dynamic_route_array` AND `crawl_seed_emitted`.
   - Detail: `"no static routes resolved; seeding crawl from /"`.

5. **Existing tab-state-only test (already in `router.test.ts`?) regression — assert seed now also emitted.**
   - If a current test asserts "0 pages emitted for tab-state-only fixture", update it to assert `1 page (seed) + tab_state_routing_suspected skip`.

### 5.3 Server — `src/server/streaming.test.ts` or new `src/server/http-crawl-seed.test.ts`

E2E through HTTP MCP:

6. **`surface_describe_self` for vite stack returns `capabilities.crawlSeed: true`.**
7. **`surface_list_pages` for an empty Vite project returns one page with `source: 'crawl_seed'`.**

### 5.4 Existing tests — assert NO regression

- `extract.test.ts`: any existing assertions on the `vite-app` fixture still hold (six static pages with `source: 'static'` if explicit).
- `detect.test.ts`: unchanged. `isVite()` semantics unchanged.

### 5.5 Sanity build

- `npx tsc --noEmit` clean.
- `npx eslint . --max-warnings 0` clean.
- `npx vitest run` green.

---

## 6. Risk

| Risk | Likelihood | Mitigation |
|---|---|---|
| Older BugHunter consumers see `source: 'crawl_seed'` and try to navigate `'<unresolved>'` as if it were a file path | low — `sourceFile` already handles this sentinel | Existing code at `discovery/pages.ts:53` already maps `'<unresolved>'` to `undefined`; no breakage |
| `Page.source` lands as required and breaks downstream consumers that omit it | medium if we made it required | Made it optional with `source?` — must NOT change to required in v0.2.1 |
| The `crawl_seed_emitted` skip pollutes logs in projects that legitimately have no pages (e.g. backend-only Vite tooling library) | low — surface only emits when `stack: 'vite'` is explicitly configured | Only fires for stack=vite; backend-only stacks are unaffected |
| `isVite()` still rejects routerless Vite projects, so a TraiderJo-shape repo's auto-detect output doesn't change | medium — auto-detect was never how TraiderJo configured itself | Spec § 3.5 documents the manual config path; init prints a hint |
| The seed is added BEFORE the page-revision bump, so the watcher loop emits a stale page revision | low — `regeneratePageCatalog` always bumps revision after the call | No special handling required |
| Two different surfaces both emit seeds and BugHunter's run sees identical seed routes | n/a — BugHunter only points at one surface today; multi-surface deferred (SPA_PAGES § 4.4) | No mitigation needed |

---

## 7. Open questions

- **Q1.** Should `isVite()` be relaxed to recognize Vite projects without `react-router-dom`? **Default: no, defer to v0.3.** Auto-detect is a hint; explicit config wins. The init hint (§ 3.5) closes the discoverability gap. If user feedback shows people miss the hint, revisit.
- **Q2.** Should the seed be emitted when `dedupedPages.length > 0` (i.e. as supplemental coverage to static extraction)? **Default: no.** Static extraction is exhaustive when the router is supported; adding `/` on top would force BugHunter to crawl from a route already in the static set, producing duplicate work. Crawl is strictly a fallback.
- **Q3.** Should multiple seed routes be emittable (e.g. `/`, `/login`)? **Default: no, single seed `/` only.** The crawler's job is to expand outward; if `/` redirects to `/login`, the crawl naturally lands there. If a project genuinely needs multiple entry points, that's a v0.3 config knob (e.g. `crawlSeeds: ['/admin', '/user']`).
- **Q4.** What if `pageCatalog.skips` already contains `crawl_seed_emitted` from a prior watcher cycle? **Default: skips are rebuilt per regen** (`regeneratePageCatalog` constructs a fresh `pageCatalog` object), so no accumulation. Asserted by the `extractVitePages` contract: it returns a single fresh `{ pages, skips }` per call.

---

## 8. Acceptance criteria

### 8.1 Unit

- All cases in § 5.2 pass.
- The existing six-page assertion against `fixtures/vite-app/` continues to pass with `source: 'static'`.
- Type assertion for `PageSource` passes.

### 8.2 e2e (HTTP)

- `surface_describe_self` against a vite-stack surface returns `capabilities.crawlSeed: true`.
- `surface_list_pages` against a routerless Vite project (e.g. an empty `src/`) returns one page with `route: '/'`, `source: 'crawl_seed'`, `sourceFile: '<unresolved>'`.

### 8.3 Backward compat

- TypeScript build green; no `Page.source` callsite required to update outside this PR.
- `pages` array shape unchanged for existing static-extract consumers (extra optional field only).
- All existing fixtures' MUST_DISCOVER expectations continue to hold (six static pages for `fixtures/vite-app/`).

### 8.4 Live target (validation, not gating)

- Pointing SurfaceMCP at TraiderJo with `stack: 'vite'` configured: `surface_list_pages` returns one page (`route: '/'`, `source: 'crawl_seed'`). This unblocks BugHunter (gated by its own spec).

---

## 9. Implementation sequencing

Each step independently committable.

1. Add `PageSource` + extend `Page` with optional `source` field. Extend `PageSkip.reason` with `'crawl_seed_emitted'`. (`src/types.ts`)
2. Set `source: 'static'` on every existing `pages.push(...)` callsite in `src/extract/vite/router.ts` (no behavior change).
3. Replace the empty-result branch in `extractVitePages` with the seed emission. (§ 3.4)
4. Add `capabilities.crawlSeed` to `surface_describe_self`.
5. Add the `surfacemcp init` hint when Vite config exists but no router. (`src/cli/init.ts`)
6. Add unit tests in `src/extract/vite/router-crawl-seed.test.ts` (§ 5.2).
7. Add HTTP-level assertion in a server test (§ 5.3).
8. Run full test + tsc + lint pass.

---

End of spec.
