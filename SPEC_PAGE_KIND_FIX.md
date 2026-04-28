# SPEC: SurfaceMCP — drop synthetic tab-state pages from `surface_list_pages`

Status: draft.
Owner: @architect.
Implementer: @coder.
Predecessors: `SPEC_NAV_EXTRACT.md` (introduced `synthesizeTabStatePages`), `SPEC_CRAWL_SEED.md` (introduced `crawl_seed` source).
Related: `BugHunter/SPEC_SPA_DEEP_CRAWL.md` (introduced `kind: 'state' | 'url'` on the crawler queue), `BugHunter/SPEC_CRAWLER_STATE_FIX.md` (sister spec; no behavioural changes required there).

---

## 1. Problem

Live evidence — TraiderJo (Vite SPA, tab-state routing), captured against `127.0.0.1:3105`:

- `surface_list_pages` returns 30 entries.
- 1 entry is the `crawl_seed` `/` (correct).
- 29 entries are synthetic query-string pages: `/?activeTab=insights`, `/?eqRange=`, `/?feeMode=fixed`, etc. Every one carries `source: 'static'` and is structurally indistinguishable from a real route-defined page.

These 29 synthetic pages are produced by `synthesizeTabStatePages` in `src/extract/vite/router.ts`. Each is derived from a `setActiveTab('insights')`-style state-setter callsite. They are not URL routes: TraiderJo's SPA does not read URL state on mount. Navigating to `/?activeTab=insights` renders the identical SPA shell as `/`.

Downstream, `BugHunter` consumes these 29 entries through `discoverPages` (`packages/cli/src/discovery/pages.ts`). Anything that is not `source: 'crawl_seed'` flows into the static-page walking loop in `phases/discover.ts:164` and is opened with `walkDom(browser, baseUrl + route, ...)`. Because the SPA ignores the query params, all 29 walks land on the same shell. The vision-baseline screenshot-hash dedup (`phases/discover.ts:286`) collapses them to one unique screenshot, so vision runs on a single page instead of the dozen+ real distinct dashboard states.

The deep-crawl path is wired correctly: `crawlFromSeeds` (`packages/cli/src/discovery/crawler.ts:206`) calls `surface_list_navigations`, picks up the 32 `kind: 'state'` navigations, and clicks each one. That path produces the real distinct screenshots. The bug is upstream: the synthetic pages should never have been emitted in the first place — they duplicate the navigation data while losing the `kind` discriminator and the `triggerSelectorHint` needed to actually reach those states.

The two designs in `SPEC_NAV_EXTRACT.md` D.4 ("emit synthetic pages") and `SPEC_SPA_DEEP_CRAWL.md` ("walk state via clicks") are mutually exclusive. The deep-crawl spec landed second and is correct. The synthetic-page emission is now redundant and actively harmful.

## 2. Investigation findings

Citations are file:line at HEAD of `main` on the `spec/page-kind-fix` branch.

- `src/extract/vite/router.ts:657-665` — `extractVitePages` calls `synthesizeTabStatePages(navs)` after navigation extraction and merges the result into `dedupedPages`. This is the emission site.
- `src/extract/vite/router.ts:681-697` — `synthesizeTabStatePages(navigations: Navigation[]): Page[]` filters `navigations.filter(n => n.kind === 'state' && n.stateVar)` and constructs a synthetic `Page` with `route: \`/?${stateVar}=${target}\``, `source: 'static'`, `componentName: undefined`, `sourceFile: nav.sourceFile`. The function is exported and currently re-exported from the module.
- `src/extract/vite/navigations.ts:564-579` — Pass D constructs the underlying `Navigation` entries with `kind: 'state'`, `method: 'state-setter'`, `stateVar`, `triggerSelectorHint`, `confidence`. These remain authoritative and unaffected.
- `src/types.ts:54-94` — `PageSource = 'static' | 'crawl_seed'`. `Page` has no `kind` discriminator. Pages have always been "URL routes only"; the synthetic emission violated that.
- `BugHunter/packages/cli/src/discovery/pages.ts:43-58` — `surface_list_pages` results are mapped into `DiscoveredPageMeta` with no kind awareness.
- `BugHunter/packages/cli/src/phases/discover.ts:75-76` — splits on `source === 'crawl_seed'`. Synthetic state-pages carry `source: 'static'`, so they fall into `staticEntries`.
- `BugHunter/packages/cli/src/phases/discover.ts:164-205` — static entries get walked as URLs. This is the path producing the duplicate-shell DiscoveredPages.
- `BugHunter/packages/cli/src/discovery/crawler.ts:206-238` — the crawler already correctly handles `kind: 'state'` navigations from `surface_list_navigations`: enqueues a `QueueItem` with `kind: 'state'`, base route, stateVar, stateValue, trigger hint. Lines 270-290 navigate to the base then click the resolved trigger.

Live evidence:

```
$ curl ... surface_list_navigations
navigations: 47
state-kind: 32
  Community Insights -> insights (stateVar=activeTab, src=src/ui/pages/APR.tsx:383)
  Leaderboard -> leaderboard (stateVar=activeTab, src=src/ui/pages/APR.tsx:373)
  ...

$ curl ... surface_list_pages
pages: 30
query-string synthetic pages: 29
non-synthetic: 1
  route=/  source=crawl_seed
  route=/?activeTab=insights  source=static
  route=/?activeTab=leaderboard  source=static
  ...
```

Same 32 state navigations are already exposed via `surface_list_navigations`. The 29 page entries are pure duplication of that data with worse semantics.

## 3. Design — Option A1: drop synthetic tab-state pages

`surface_list_pages` returns only:
- Statically-resolved URL routes (Pass A `<Routes>/<Route>`, Pass B `createBrowserRouter`), and
- The `crawl_seed` `/` page when no static routes resolved.

State transitions are reachable solely via `surface_list_navigations` (where they have always existed and where the crawler already handles them via clicks).

### 3.1 Removed behaviour

In `src/extract/vite/router.ts`:

- Delete the call site (`router.ts:657-665`) that imports `extractViteNavigations`, computes synthetic pages, and merges them into `dedupedPages`.
- Delete the exported helper `synthesizeTabStatePages` (`router.ts:681-697`). It has no remaining callers.
- The `import type { Navigation } from '../../types.js'` import becomes unused; remove it.

The crawl-seed branch (`router.ts:626-655`) is untouched. That is the gateway that triggers BugHunter's crawl. For TraiderJo: still emits one seed (`/`, `source: 'crawl_seed'`), still emits the `tab_state_routing_suspected` skip. After the fix, the seed is the only page returned for fully tab-state apps.

### 3.2 Preserved behaviour

- `surface_list_navigations` is unchanged. The 32 state-kind navigations are still emitted with `kind: 'state'`, `stateVar`, `triggerSelectorHint`, exactly as before.
- Real route-defined Vite apps (`<Routes>`, `createBrowserRouter`) are unchanged — they never went through `synthesizeTabStatePages`.
- Next.js, Express, FastAPI, Django, OpenAPI extractors are unchanged.
- The `crawl_seed` fallback in `extractVitePages` is unchanged.
- `Page`, `PageSource`, `PageSkip` types are unchanged. No new fields, no removed fields.

### 3.3 Why A1 (and not A2)

A2 — "tag synthetic pages with `kind: 'state'`" — was rejected because:

1. A `kind` discriminator on `Page` would partially overlap with `kind` on `Navigation`, with no consumer that benefits. BugHunter consumes the same data through `surface_list_navigations` already, which carries the `triggerSelectorHint` required to actually reach the state. Pages have no such hint and would still be useless even tagged.
2. A2 keeps the duplication: the 29 entries continue to consume budget in any consumer that iterates `pages`. Today that includes BugHunter's static walk loop, the planning phase, and any future tools that iterate the page catalog.
3. A1 is strictly subtractive: smaller surface, smaller types, fewer corner cases. The semantic invariant "a page is a URL endpoint" is restored.
4. The trade-off A1 imposes — consumers must merge `pages + navigations` into a unified queue with kind discriminators — has already been paid by BugHunter. `crawler.ts` already does this merge correctly: pages feed `seedRoutes`, `surface_list_navigations` feeds the navigation queue with kind awareness.

## 4. Cross-repo impact

### 4.1 BugHunter — no behavioural change required

`packages/cli/src/discovery/crawler.ts` already:
- Treats only `crawl_seed`-flagged entries from `surface_list_pages` as crawl seeds (`phases/discover.ts:75`).
- Pulls navigations independently via `surface_list_navigations` (`crawler.ts:206-238`).
- Handles `kind: 'state'` navs through the click path (`crawler.ts:270-290`), with trigger resolution via `resolveTriggerSelector`.

After this fix:
- `staticEntries` (the path that drives the duplicated walks) is empty for fully tab-state apps.
- Crawl path runs from the seed, picks up all `kind: 'state'` navigations, and visits each via click. Vision baseline runs on each unique state.

A sister spec, `BugHunter/SPEC_CRAWLER_STATE_FIX.md`, is published to record this verification and to guard against regressions; no code changes required there.

### 4.2 Real route-defined apps — unaffected

Apps with `<Routes>/<Route>` or `createBrowserRouter` continue to expose all routes through `surface_list_pages`. The synthetic-page emission was gated on `n.kind === 'state'` navigations — apps without `useState`-driven tab-state never produced synthetic pages and never will.

### 4.3 Older BugHunter clients reading `pages` directly

Clients that iterated `surface_list_pages` for non-crawl purposes (e.g. internal dashboards, smoke scripts) will see fewer pages on tab-state apps. This is correct: those entries were never URL-reachable. Clients that need state transitions should consume `surface_list_navigations`.

## 5. Test plan

### 5.1 Unit — fixture `vite-tab-state-app`

`src/extract/extract.test.ts:261-272` (`describe 'vite-tab-state-app navigation extraction'`) currently asserts that `extractVitePages` emits four synthetic pages keyed `/?tab=<value>`. Update this test to assert the inverse: zero synthetic pages.

```ts
it('emits no synthetic /?<state>= pages — state lives only in navigations', async () => {
  const root = resolve(FIXTURES, 'vite-tab-state-app');
  const { pages } = await extractVitePages(root);
  expect(pages.every(p => !p.route.startsWith('/?'))).toBe(true);
});
```

The companion test `discovers all must-discover navigations` (lines 246-258) is unaffected — `extractViteNavigations` still emits the four state-setter navigations.

### 5.2 Unit — `src/extract/vite/navigations.test.ts`

Two existing tests assert synthetic-page emission. Both must be inverted:

- Line 337-346 `'synthetic-page — tab-state produces /?tab=value pages'` — replace with the negative assertion above (`pages.every(p => !p.route.startsWith('/?'))`).
- Line 402-407 `'synthesizes 4 synthetic pages'` — delete this test.

The negative-regression test `'vite-app: surface_list_pages output unchanged (6 pages, no synthetic)'` (line 358-364) already asserts the correct invariant for `<Routes>`-based apps; keep it.

### 5.3 Unit — `synthesizeTabStatePages` removal

After deletion, no test should import `synthesizeTabStatePages`. `src/extract/vite/router.ts` exports list and any import from outside the file must be searched and either deleted or replaced. (At the time of this spec, only `router.ts` itself uses it; no re-export from the public surface, no test reference.)

### 5.4 Fixture metadata — `vite-tab-state-app/MUST_DISCOVER.json`

Remove the `syntheticPages` block:

```json
{
  "navigations": [
    { "method": "state-setter", "target": "dashboard", ... },
    { "method": "state-setter", "target": "trades", ... },
    { "method": "state-setter", "target": "settings", ... },
    { "method": "state-setter", "target": "profile", ... }
  ]
}
```

`navigations` block is unchanged.

### 5.5 E2E / live — TraiderJo killer demo

Run BugHunter's discover phase against TraiderJo with vision enabled. Acceptance:

1. `surface_list_pages` returns exactly 1 page (`/`, `source: 'crawl_seed'`). No `/?activeTab=…`, no `/?eqRange=…`, etc.
2. `surface_list_navigations` returns 47 navigations with 32 `kind: 'state'` (unchanged from current).
3. BugHunter's `crawlTelemetry.staticNavigations` ≥ 32, `stateKindPages` > 1.
4. Vision baseline runs on > 1 unique screenshot — at minimum the dashboard `monthly`/`hour` heatmap variants, the `feeMode=fixed`/`feeMode=manual` settings, and the `activeTab=leaderboard`/`activeTab=insights` APR tabs each produce distinct screenshots.

### 5.6 HTTP-level regression

`src/server/http-crawl-seed.test.ts` and any integration test in `src/e2e/surfacemcp-e2e.test.ts` that calls `surface_list_pages` against the tab-state fixture must reflect the new count. Specifically: the tab-state fixture now returns 1 page (the `/` seed), not 5.

## 6. Backward compat

- `Page`, `PageSource`, `PageSkip` types: identical. No version bump required on the type level.
- `surface_describe_self.capabilities.listPages`: still `true` for Vite. The capability has always been "we can list URL-routed pages", and that remains accurate.
- `surface_describe_self.capabilities.crawlSeed`: unchanged.
- `surface_describe_self.capabilities.listNavigations`: unchanged.
- Pre-deep-crawl BugHunter (any client that didn't read `surface_list_navigations`): such clients lose visibility of tab-state surfaces entirely. Tradeoff accepted: those clients also could not click the triggers, so they never reached those surfaces anyway. The synthetic pages were strictly noise to them.
- `<Routes>`-based fixture (`vite-app`): no change — already had no synthetic pages (asserted by the existing negative regression).

## 7. Acceptance criteria

A1. Unit: `fixtures/vite-tab-state-app` → `extractVitePages` emits zero pages with `route.startsWith('/?')`. The fixture's `navigations` extraction still finds the four `state-setter` entries with their labels, stateVars, and trigger hints.

A2. Unit: `synthesizeTabStatePages` is deleted from `src/extract/vite/router.ts`. `tsc --noEmit` passes. `npx vitest run` passes.

A3. Unit: `vite-app` fixture (existing real-routes case) returns the same 6 pages it returned before this spec.

A4. Live (TraiderJo): `surface_list_pages` returns exactly 1 page, `route: '/'`, `source: 'crawl_seed'`. `surface_list_navigations` continues to return 47 navigations with 32 `kind: 'state'`.

A5. Live (TraiderJo via BugHunter): vision baseline runs on > 1 unique screenshot. The screenshot-hash dedup in `phases/discover.ts:286` no longer collapses 30 walks to 1 — there are no 30 walks. The dedup is only deciding among the click-driven state pages, which are genuinely distinct.

A6. No new files, no new dependencies, no new fields on `Page`/`PageSkip`/`Navigation`. Net diff: deletion plus a small handful of inverted test assertions.

## 8. Files to touch

### Modified

- `src/extract/vite/router.ts` — delete the `synthesizeTabStatePages` import/merge block (lines 657-665) and the function itself (lines 681-697). Remove the now-unused `Navigation` import (line 17).
- `src/extract/vite/navigations.test.ts` — invert/delete the two synthetic-page tests (lines 337-346 and 402-407).
- `src/extract/extract.test.ts` — invert the `synthesizes one tab-state page per state value` test (lines 261-272).
- `fixtures/vite-tab-state-app/MUST_DISCOVER.json` — remove the `syntheticPages` array.

### Possibly modified (verify in implementation)

- `src/e2e/surfacemcp-e2e.test.ts` — if any assertion against the tab-state fixture mentions synthetic page count, adjust to 1.
- `src/server/http-crawl-seed.test.ts` — if it asserts page count against the tab-state fixture, adjust.

### Not touched

- `src/extract/vite/navigations.ts` — Pass D state-setter detection unchanged.
- `src/extract/vite/router-crawl-seed.test.ts` — crawl-seed fallback behaviour unchanged.
- `src/types.ts` — no schema changes.
- All non-Vite extractors.
- `BugHunter/**` — sister spec is informational only.

## 9. Risk

R1. A test fixture or e2e assertion outside the four files listed above silently encodes the synthetic-page count. Mitigation: implementer must run the full vitest suite (`npx vitest run`) and chase failures, not just the targeted files. The acceptance criterion A2 ("vitest passes") makes this explicit.

R2. A downstream consumer outside the BugHunter monorepo iterates `pages` and depends on the synthetic entries. Mitigation: SurfaceMCP's documented contract is "a page is a URL endpoint"; the synthetic entries violated that contract. Consumers depending on them were already broken (the URL didn't work). Bumping the SurfaceMCP `pageRevision` is sufficient signal; no major-version bump.

R3. A future state-routing pattern (e.g. URL-driven tab state via `useSearchParams`) emits real query-string routes and we mistakenly forbid them. Mitigation: this spec only deletes synthesis from `setState` callsites. Real `<Route path="/?...">` or `useSearchParams`-driven routes would flow through Pass A/B and continue to emit. Pass A/B do not call `synthesizeTabStatePages`.

## 10. Open questions

None. The cross-cutting decisions (recommend A1, drop the helper, leave `surface_list_navigations` authoritative) are settled by the live evidence: the deep-crawl path already does the right thing; the synthetic-page emission is pure noise.
