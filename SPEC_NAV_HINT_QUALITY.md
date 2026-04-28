# SPEC — SurfaceMCP: improve trigger-hint extraction quality in nav-extractor

**Status:** ready for `@coder` · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-28 · **Predecessor:** `SPEC_NAV_EXTRACT.md` (shipped — surface_list_navigations) · **Sibling:** `SPEC_PAGE_KIND_FIX.md` (shipped — page-kind separation) · **Downstream consumer:** `BugHunter/SPEC_SPA_DEEP_CRAWL.md`

The static SPA navigation extractor (`src/extract/vite/navigations.ts`) currently emits navigations with trigger hints that are too vague for BugHunter's crawler to resolve to a unique DOM element. The vision-baseline killer demo (TraiderJo, ≥ 7 unique pages) is gated on this. This spec specifies **hint-quality improvements**, **scope-classification**, **confidence-promotion** rules, and a **deduplication pass** to close the gap.

The fix is bounded: changes live in `src/extract/vite/navigations.ts`, `src/types.ts`, and the existing `vite-tab-state-app` fixture (with one new fixture for ambiguous-target cases). No new tools. No new server endpoints. No new dependencies.

---

## 1. Problem

### 1.1 Concrete failure mode

TraiderJo at `/` (the unauthenticated landing) does not surface enough navigations for BugHunter's crawler to reach the dashboard / trades / settings / APR / wiki / plan / import / attribution surfaces — the very surfaces the vision baseline needs to reach for the killer demo.

The navigations **are** in the catalog: `surface_list_navigations` for TraiderJo returns ~16 entries (per `SPEC_NAV_EXTRACT.md` §1.1). But:

- Several entries have **`triggerSelectorHint.text`** values like `"monthly"`, `"hour"`, `"daily"` that match **multiple** clickable elements at once across the rendered page — the crawler has no way to pick the right button.
- Several entries are extracted from setter callsites whose **enclosing trigger does not exist at `/`** — they live inside `Dashboard.tsx`, only rendered after the user is authenticated and on the dashboard page. The catalog has no signal that these triggers are "deep" (page-local) rather than top-level.
- Several entries have **identical hints** (same target, same label) emitted from multiple files — three `<Link to="/x">About</Link>` callsites in three components are all in the catalog, with the same hint, leading the crawler to retry on duplicates.

The unifying theme: the catalog has **all** of TraiderJo's navigations, but the **resolution quality** (what selector to use, where in the app to expect this trigger, how confident we are) is too low for BugHunter to act on.

### 1.2 Concrete examples from TraiderJo

#### Example A — page-local tab labels collide with tab targets

`src/ui/pages/Dashboard.tsx:1508-1509`:

```tsx
<button ... onClick={() => setHmDim('monthday')}>monthly</button>
<button ... onClick={() => setHmDim('hour')}>hour</button>
```

State declaration at `src/ui/pages/Dashboard.tsx:148`:
```tsx
const [hmDim, setHmDim] = useState<'monthday' | 'hour'>('monthday');
```

What the extractor emits today:

```jsonc
{ method: 'state-setter', target: 'monthday', label: 'monthly', stateVar: 'hmDim', triggerSelectorHint: { text: 'monthly' }, confidence: 'high' }
{ method: 'state-setter', target: 'hour', label: 'hour', stateVar: 'hmDim', triggerSelectorHint: { text: 'hour' }, confidence: 'high' }
```

Three issues:

1. **Target ≠ label.** The setter argument is `'monthday'` but the rendered button text is `"monthly"`. BugHunter's crawler may click the right button (matching by text "monthly") but the state value reached is `'monthday'`. For the crawler this is fine — it observes DOM mutation and moves on. But for the **synthetic page key** (`/?hmDim=monthday`) the URL doesn't match what a human sees ("monthly"). This is a UX / debuggability issue, not a correctness gap.
2. **`hour` is ambiguous.** TraiderJo also has chart-timespan UI with "1h" / "4h" / "1day" labels in `KLineChartWrapper.tsx`. A crawler trying to click `text=hour` may hit a different button entirely — not the heatmap-dim toggle.
3. **No scope signal.** These buttons live inside `Dashboard.tsx`, rendered only when `tab === 'dashboard'`. They're **page-local** — only reachable after navigating to the dashboard tab. The catalog gives no hint of this — the crawler tries them at `/` and finds nothing.

#### Example B — APR tabs (correct)

`src/ui/pages/APR.tsx:373, 383`:

```tsx
<button ... onClick={() => setActiveTab('leaderboard')}>Leaderboard</button>
<button ... onClick={() => setActiveTab('insights')}>Insights</button>
```

What the extractor emits today:

```jsonc
{ method: 'state-setter', target: 'leaderboard', label: 'Leaderboard', stateVar: 'activeTab', triggerSelectorHint: { text: 'Leaderboard' }, confidence: 'high' }
{ method: 'state-setter', target: 'insights', label: 'Insights', stateVar: 'activeTab', triggerSelectorHint: { text: 'Insights' }, confidence: 'high' }
```

Same scope problem: these only render when the user is on the APR sub-page (`tab === 'apr'`). The crawler at `/` cannot resolve them.

#### Example C — command-palette setters

`src/ui/App.tsx:202-211`:

```tsx
const actions = [
  { id: 'import', title: 'Import CSV', shortcut: 'I', run: () => setTab('import') },
  { id: 'apr', title: 'APR Rankings', shortcut: 'R', run: () => setTab('apr') },
  // ...
];
```

What the extractor emits today: `no_trigger_label` skips for each — the setter callsite is inside an object literal, not enclosed by a JSX trigger. **This is correct behavior.** The fix should not regress it.

But: the dashboard / apr / trades navigations **also exist** as top-level `setTab(...)` calls inside the keydown handler at `App.tsx:180-191`:

```tsx
const onKey = (e: KeyboardEvent) => {
  // ...
  if (key === 'f') { setTab('dashboard'); /* ... */ }
};
```

These also produce `no_trigger_label` skips today (the enclosing scope is an event listener, not JSX). **Correct behavior.**

The actual top-level navigation in TraiderJo is in `Navbar.tsx`:

```tsx
<button ... onClick={() => setTab(id)} >...</button>
```

Where `id` is a non-literal — `dynamic_target` skip today. **Correct.**

**Net result:** TraiderJo's top-level tabs are statically un-resolvable. The catalog has them as skips. The vision baseline is gated on **finding another way**: either runtime route enumeration (separate spec) or recognizing the `Navbar.tsx` pattern of `setTab(id)` where `id` ranges over a **statically-known** literal-array. That's the closure-actions extension at `SPEC_V02_CLOSURE_ACTIONS.md` (separate spec, distinct work).

This spec is **not** about TraiderJo's `Navbar.tsx`. This spec is about making the navigations **already in the catalog** resolvable by the crawler.

### 1.3 Live targets

- **TraiderJo:** today's catalog has navigations from `Dashboard.tsx`, `Trades.tsx`, `Plan.tsx`, `Import.tsx`, `APR.tsx`, `Auth.tsx`, `TradeDetails.tsx`. After this spec, each navigation has:
  - A scope label (`top-level` vs `page-local`) so the crawler knows whether to attempt resolution at `/` vs after navigating to the parent page.
  - A higher-quality `triggerSelectorHint` (testid > aria-label > text > attribute fallback) with the **strongest available** selector promoted.
  - A confidence label that **drops to `medium` when the text hint is shared with another navigation in the same scope** (ambiguous text triggers).
  - A **`siblingNavigations` count** so the crawler can deprioritize when many same-text triggers exist.
- **`fixtures/vite-tab-state-app/`** (existing): no breaking change. New fields are additive. Existing test cases continue to pass.
- **New fixture `fixtures/vite-tab-state-app-deep/`**: page-local nested tab states (a parent tab + sub-tabs inside one of the pages). Scope classification verified.

### 1.4 Out of scope

- **Cross-file setter resolution** (e.g. `setTab` defined in a context provider, consumed in 50 files). Already out of scope per `SPEC_NAV_EXTRACT.md` §9.
- **Closure-actions** (`setTab(id)` where `id` ranges over a literal-array). That's `SPEC_V02_CLOSURE_ACTIONS.md`'s job.
- **Runtime route enumeration.** Already shipped as a separate tool; this spec is static-only.
- **Per-stack support beyond Vite.** `extractNavigationsForStack` returns empty for non-vite stacks; that does not change.
- **Wrapper-component support.** `import { Link } from '../components/Link'` re-exporting react-router-dom's `Link` remains unsupported.
- **Mutation of existing navigations' `target` / `method` / `kind` fields.** Hint quality is the only target.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `src/extract/vite/navigations.ts` | Owner of the four passes (A through D). All hint-extraction lives in `extractTriggerInfo` and `extractJsxLabel`. The new scope/dedup logic is appended at the bottom of `extractViteNavigations` after all passes complete. |
| `src/types.ts` (lines 250-298) | `Navigation`, `NavigationConfidence`, `NavigationCatalog`, `NavigationSkip`. New optional fields land here. **Do not** change existing field types. |
| `src/extract/vite/util.ts` | Shared util (`buildImportMap`, `loadPathsMap`, `resolveImportSpecifier`). No changes here. |
| `src/extract/vite/router.ts` | The page extractor. The new `scope: 'top-level' \| 'page-local'` classification on navigations does **not** affect page extraction; pages stay as-is. |
| `src/server/navigation-catalog.ts` | The in-memory catalog. The catalog stores whatever the extractor returns; no logic change here. |
| `src/server/http.ts` (lines 352-369) | `surface_list_navigations` tool registration. The tool's response shape grows with optional fields; no breaking change. |
| `fixtures/vite-tab-state-app/src/App.tsx` | The reference fixture. Existing test assertions in `src/extract/vite/navigations.test.ts` must continue to pass. |

### 2.2 Patterns to follow

- **Pure functions** for new logic. Scope classification, dedup, and ambiguity counting are post-passes — they take the array of `Navigation` produced by passes A-D and return a transformed array. No I/O. No state.
- **Discriminated-union returns** are not relevant for these helpers (no error path); they take inputs and return outputs.
- **Confidence promotion is monotonic** — confidence can only **drop**, never rise above what the original pass assigned. (Ambiguity cannot make a `medium` finding more reliable.)
- **Additive types.** New fields on `Navigation` are optional. Existing consumers (BugHunter v0.4/v0.5/v0.6) still see a valid `Navigation` if they ignore the new fields.

### 2.3 DO NOT

- Do **not** create new files. The work is in `navigations.ts` (post-passes) and `types.ts` (additive type fields).
- Do **not** change the existing `Navigation.label`, `target`, `method`, `kind`, `stateVar`, `sourceFile`, `sourceLine` fields.
- Do **not** modify the pages catalog. Scope classification operates on navigations only.
- Do **not** change `surface_list_navigations`'s arguments shape (no new `filter` keys).
- Do **not** introduce a non-static lookup. Static AST analysis only.
- Do **not** import additional ts-morph helpers. The existing `getDescendantsOfKind`, `getStartLineNumber`, `asKindOrThrow`, `getKind`, `getText` cover everything needed.
- Do **not** vendor or wrap a new dependency. ts-morph is already in.
- Do **not** modify the test fixtures' `App.tsx` files in a way that breaks existing tests. Add fixtures for the new scenarios; do not edit existing ones beyond the strictly-additive parts.
- Do **not** allow the new `scope` field to be required. Existing tests would break.

---

## 3. Design

Six additive changes. Each is independent and individually testable.

### 3.1 Hint quality: promote testid + ariaLabel above text

**Today** (`navigations.ts:175-179`, `:266-270`, `:355-359`, `:570-574`):

```ts
triggerSelectorHint: {
  text: labelText || undefined,
  testId,
  ariaLabel,
}
```

All three fields are emitted equally; the consumer (BugHunter crawler) chooses. This is correct — but the **confidence label** doesn't reflect the strength of the selector.

**Fix.** Add a derived field `triggerSelectorHint.preferred: 'testId' \| 'ariaLabel' \| 'text' \| undefined`:

```ts
triggerSelectorHint: {
  text?: string;
  testId?: string;
  ariaLabel?: string;
  /** The strongest available selector — guaranteed to be the highest-priority field that has a value. */
  preferred?: 'testId' | 'ariaLabel' | 'text';
}
```

Priority: `testId` > `ariaLabel` > `text`. If multiple are present, `preferred` is the strongest. If none are present, `preferred` is `undefined`.

**Promotion logic** (post-pass; runs once after passes A-D):

```ts
function preferredSelector(hint: Navigation['triggerSelectorHint']): 'testId' | 'ariaLabel' | 'text' | undefined {
  if (hint.testId !== undefined && hint.testId !== '') return 'testId';
  if (hint.ariaLabel !== undefined && hint.ariaLabel !== '') return 'ariaLabel';
  if (hint.text !== undefined && hint.text !== '') return 'text';
  return undefined;
}
```

### 3.2 Hint quality: extract `title` attribute as a fallback

The current extractor reads `title` only for self-closing `<Link>` (line 110-114 of `extractTriggerInfo`). Many real triggers (icon buttons, accessibility-thin buttons) carry `title="..."` even when textContent is empty:

```tsx
<button title="Refresh trades" onClick={() => refreshTrades()}><RefreshIcon /></button>
```

**Fix.** Extend `extractTriggerInfo` to also extract `title` on **all** trigger kinds (not just self-closing). Add `title?: string` to `triggerSelectorHint`. Promotion priority:

`testId` > `ariaLabel` > `text` (non-empty) > `title`

Update `preferredSelector` accordingly.

### 3.3 Scope classification: top-level vs page-local

The single highest-value addition. New field on `Navigation`:

```ts
scope: 'top-level' | 'page-local';
```

**Definition:**

- `top-level` — the trigger element is rendered by the project's **app-root component** (the component that owns the tab/route state at the top of the tree).
- `page-local` — the trigger element is rendered inside a component that is itself conditionally rendered by a higher-level navigation (a "tab content" component, a "route element" component).

**Heuristic for static detection:**

A trigger is **page-local** when **any** of these hold:

1. The setter callsite's `useState` declaration is in a file matching `**/pages/**` or `**/views/**` (project convention).
2. The setter callsite's `useState` declaration is in a file whose default export name (best-effort: filename matches a kebab/Pascal page name) appears in the **app-root** file as a JSX element guarded by a state-condition (e.g. `{tab === 'dashboard' && <Dashboard />}`).
3. The setter callsite's enclosing `useState` is for a state variable name in the project's "page-local convention" (heuristic: the union has < 5 members and the state-var name does not match `tab|view|route|page|nav` patterns — these names suggest top-level routing).

A trigger is **top-level** otherwise.

**Implementation strategy (single pass):**

After all four navigation passes complete, do a **post-pass** that:

1. Identify the **app-root file**: the file the project entry-point (`main.tsx`/`index.tsx`) imports first, OR the file containing the state-var that has the largest union among detected state-vars (this state-var owns the top-level nav). This file's path is the "root path."
2. For each navigation, compare its `sourceFile` to the root path:
   - If `sourceFile === rootPath`, scope = `top-level`.
   - Else, scope = `page-local`.

This is a deliberate simplification: if the app uses a single-file `App.tsx` for top-level routing (TraiderJo, the existing fixture, most React tutorials), this rule produces correct results. Apps with multi-file top-level routing fall into the `page-local` bucket conservatively — which is **safe** (the crawler tries them after navigating into a parent page; worst case, an extra navigation attempt).

**Edge case — the root path itself is ambiguous:**

If neither heuristic resolves (no `main.tsx` import, no state-var with > 1 detected union member), default `scope = 'top-level'` for **all** navigations. This is the safest fallback: BugHunter will attempt to resolve all triggers at `/` and reduce the catalog as it goes.

**Edge case — `<Link>` and `<a>` (URL-based navigations):**

URL-based navigations (`method: 'link' | 'router-link' | 'router-push'`) are typically reachable from any URL in the app (the browser handles them). They are **always** `top-level` — even if the `<Link>` lives inside `Dashboard.tsx`, the crawler can navigate to its target without first being on the dashboard.

**Edge case — `kind: 'hash'`:**

Hash anchors are not page-local (they're URL-based). `top-level`.

### 3.4 Sibling-navigation counting (text-ambiguity signal)

For each navigation **N**, count how many other navigations in the same scope (`top-level` or the same parent file for `page-local`) share **the exact same `triggerSelectorHint.text`** (case-insensitive after trim).

```ts
siblingNavigations: number;   // 0 = unique text in scope; > 0 = N other navs share this text
```

**Algorithm (post-pass):**

1. Group navigations by `(scope, normalize(triggerSelectorHint.text))` where `normalize` trims and lowercases.
2. For each navigation, set `siblingNavigations = group.length - 1`.

**Confidence drop:** if `siblingNavigations > 0` AND `triggerSelectorHint.preferred === 'text'` (no stronger hint), drop confidence one notch:
- `high` → `medium`
- `medium` → `low`
- `low` → `low`

If a stronger hint exists (`testId` or `ariaLabel`), the ambiguity in `text` is harmless — keep confidence as-is.

### 3.5 Cross-file dedup

Today, three `<Link to="/about">About</Link>` callsites in three components produce three Navigation entries. Per `SPEC_NAV_EXTRACT.md` §10, this is **intentional** ("dedup is BugHunter's responsibility"). However, the catalog can carry redundancy that bloats the response without value.

**Fix (additive, opt-in):**

Add `duplicateCount: number` to each navigation:

- For each `(method, target, kind, scope)` quadruple, count occurrences.
- Set `duplicateCount = count - 1` (so `0` means "unique"; `2` means "two siblings exist with the same target").

The catalog still emits **all** entries — no hard dedup. Consumers (BugHunter) can pick the one with the strongest hint (preferred selector wins ties).

**Rationale:** keeping all entries preserves the file/line provenance for debugging; the field gives the crawler a knob to deprioritize redundant entries without losing them.

### 3.6 Catalog response: `siblingNavigations` is sortable

`surface_list_navigations` returns navigations in source-discovery order today (file-alphabetical, then line-numerical). Add a deterministic re-sort:

1. Primary: `confidence` desc (`high` first, `low` last).
2. Secondary: `siblingNavigations` asc (unique-text wins).
3. Tertiary: `triggerSelectorHint.preferred` desc (`testId` > `ariaLabel` > `text` > `title` > undefined).
4. Quaternary: `sourceFile` asc, `sourceLine` asc (existing tiebreaker).

This shifts high-quality navigations to the top of the response. Consumers that page through results see the best ones first.

**Sort lives in `getNavigationCatalog()`** (in `src/server/navigation-catalog.ts`) **as a one-time sort at catalog-regeneration time** — not on every tool call. That keeps the request path cheap.

---

## 4. Type changes

In `src/types.ts`, lines 265-282, the `Navigation` type grows by **four optional fields** plus one nested optional field:

```diff
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
+    /** title="..." attribute as a last-resort hint. */
+    title?: string;
+    /** The strongest available selector field. Derived; never overrides explicit values. */
+    preferred?: 'testId' | 'ariaLabel' | 'text' | 'title';
   };
   sourceFile: string;          // project-root-relative
   sourceLine: number;
   confidence: NavigationConfidence;
+  /** 'top-level' = reachable from any URL; 'page-local' = only after navigating to the parent page. */
+  scope?: 'top-level' | 'page-local';
+  /** Number of OTHER navigations in the same scope that share this text hint (case-insensitive). 0 = unique. */
+  siblingNavigations?: number;
+  /** Number of OTHER navigations across all files that share (method, target, kind, scope). 0 = unique. */
+  duplicateCount?: number;
 };
```

**Why all four are optional:** existing test fixtures and consumers must keep working. Stage 0 of the rollout: extractor begins emitting the fields; nothing else changes. Stage 1: BugHunter consumes them.

---

## 5. Edge cases

| # | Case | Expected |
|---|------|----------|
| 1 | `<button title="Refresh">..</button>` with no text | `triggerSelectorHint.title = "Refresh"`, `preferred = 'title'` |
| 2 | `<button data-testid="x" aria-label="Y" title="Z">W</button>` | All four fields populated; `preferred = 'testId'` |
| 3 | Two `<Link to="/x">About</Link>` callsites in different files, same scope | Both emit; `siblingNavigations = 1` for each; `duplicateCount = 1` for each |
| 4 | Two `<Link to="/x">About</Link>` callsites in two pages with `scope: 'page-local'` | `siblingNavigations` is per-scope: each has `siblingNavigations = 0` if they're in different parent pages; `1` if same parent page |
| 5 | TraiderJo's `setHmDim('hour')` button labeled "hour" | `text: 'hour'`, `siblingNavigations` ≥ 1 if another nav in the same scope has text 'hour'; if `preferred === 'text'` and ambiguous, confidence drops `high → medium` |
| 6 | The vite-tab-state-app fixture's "Settings" tab with `data-testid="nav-settings"` | `preferred = 'testId'`; sibling-counting on text doesn't drop confidence (text is not preferred) |
| 7 | The vite-tab-state-app fixture's "Profile" tab with `aria-label="My profile"` | `preferred = 'ariaLabel'`; same as #6 |
| 8 | App with no `main.tsx` (only `index.tsx`) | Scope classification falls back: state-var with the largest union owns top-level; everything else page-local |
| 9 | App with two `useState`s in `App.tsx` (top-level uses both for routing) | Both contribute to top-level navigations; `scope = 'top-level'` for either's setters |
| 10 | App with state-var in a nested component, but `App.tsx` imports the component as the main JSX child | `scope = 'page-local'` (heuristic prioritizes the file boundary, not the JSX rendering) |
| 11 | A `<Link to="/x">` inside `Dashboard.tsx` | URL navigations are `scope = 'top-level'` regardless of file (per §3.3 special case) |
| 12 | `confidence: 'low'` navigation with `siblingNavigations > 0` and `preferred = 'text'` | Confidence stays `low` (no further drop possible) |
| 13 | Empty `text` ('') after trim, `testId` present | `preferred = 'testId'`; the empty text is dropped from the hint object (already today's behavior). `siblingNavigations` counts only non-empty texts |
| 14 | `<button onClick={...}>{i18n.t('foo')}</button>` (i18n call as JSX child) | The label extractor returns empty (JSX expressions don't traverse). `siblingNavigations` doesn't count empty texts. Hint quality is just `testId` / `ariaLabel` if available. |
| 15 | Navigations with `method: 'router-push'` (useNavigate) where the same `target` is invoked from multiple buttons | `duplicateCount` increments; each entry retains its own `triggerSelectorHint`. The crawler can pick by preferred selector. |

---

## 6. Tests

### 6.1 Unit tests — `src/extract/vite/navigations.test.ts` (additions)

Add `describe()` blocks; do not modify existing test cases.

#### 6.1.1 `describe('hint quality — preferred selector')`

```ts
it('preferred = testId when testId present', () => { ... });
it('preferred = ariaLabel when only ariaLabel present', () => { ... });
it('preferred = text when only text present', () => { ... });
it('preferred = title when only title present', () => { ... });
it('preferred = testId beats all when all present', () => { ... });
it('preferred = undefined when no hint present', () => { ... });
```

Each test uses an inline TSX fixture (small string passed to `Project.createSourceFile`) with a single trigger that has the relevant attributes.

#### 6.1.2 `describe('hint quality — title attribute fallback')`

```ts
it('extracts title="..." as a hint when textContent is empty', () => {
  const code = `
    import { useState } from 'react';
    export function App() {
      const [tab, setTab] = useState<'a'|'b'>('a');
      return (
        <button title="Switch to B" onClick={() => setTab('b')}><RefreshIcon /></button>
      );
    }
  `;
  // Expect: triggerSelectorHint = { text: undefined, title: 'Switch to B', preferred: 'title' }
});
```

#### 6.1.3 `describe('scope classification')`

```ts
it('classifies state-setter in App.tsx as top-level', () => { /* ... */ });
it('classifies state-setter in pages/Dashboard.tsx as page-local', () => { /* ... */ });
it('classifies <Link> in pages/Dashboard.tsx as top-level (URL navs are always top-level)', () => { /* ... */ });
it('classifies <a href="#x"> as top-level (hash navs)', () => { /* ... */ });
it('falls back to top-level when neither App.tsx nor pages/ convention found', () => { /* ... */ });
```

Each test uses a multi-file inline fixture (use `Project.createSourceFile` with two/three files in the same project).

#### 6.1.4 `describe('siblingNavigations counting')`

```ts
it('siblingNavigations = 0 when text is unique in scope', () => { /* ... */ });
it('siblingNavigations = 2 when 3 navs share text in same scope', () => { /* ... */ });
it('siblingNavigations counts case-insensitively after trim', () => {
  // Two buttons: text "Save" and text "  save  " → siblingNavigations = 1 for each.
});
it('siblingNavigations is per-scope, not global', () => {
  // Two top-level "About" + one page-local "About" → top-level entries have siblingNavigations = 1; page-local has 0.
});
it('confidence drops high→medium when siblings exist AND preferred = text', () => { /* ... */ });
it('confidence stays high when siblings exist BUT preferred = testId', () => { /* ... */ });
```

#### 6.1.5 `describe('duplicateCount')`

```ts
it('duplicateCount = 0 when (method, target, kind, scope) is unique', () => { /* ... */ });
it('duplicateCount = N-1 when N entries share the quadruple', () => { /* ... */ });
it('duplicateCount considers all 4 fields — different scopes do not collide', () => { /* ... */ });
```

#### 6.1.6 `describe('sorting in catalog response')`

This test lives at the catalog level, not the extractor level. Add to `src/server/navigation-catalog.test.ts` (create if absent).

```ts
it('navigation list is sorted by confidence desc, then siblingNavigations asc, then preferred desc, then sourceFile asc, then sourceLine asc', () => { /* ... */ });
```

### 6.2 Existing fixture: `vite-tab-state-app`

The fixture's existing 4 navigations remain (`dashboard`, `trades`, `settings`, `profile` — see the fixture's `App.tsx` already in tree). After this spec's changes, the **expected output** is augmented:

| Target | preferred | scope | siblingNavigations | duplicateCount | confidence |
|---|---|---|---:|---:|---|
| dashboard | `text` | top-level | 0 | 0 | high |
| trades | `text` | top-level | 0 | 0 | high |
| settings | `testId` | top-level | 0 | 0 | high |
| profile | `ariaLabel` | top-level | 0 | 0 | high |

`MUST_DISCOVER.json` should be extended to include these new fields. (Adding to the existing fixture's expected payload — additive; existing tests pass.)

### 6.3 New fixture: `vite-tab-state-app-deep`

Mirrors a real app with a parent tab + sub-tabs:

`fixtures/vite-tab-state-app-deep/src/App.tsx`:

```tsx
import { useState } from 'react';
import { Dashboard } from './pages/Dashboard';
import { Settings } from './pages/Settings';

type Tab = 'dashboard' | 'settings';

export function App() {
  const [tab, setTab] = useState<Tab>('dashboard');
  return (
    <div>
      <nav>
        <button onClick={() => setTab('dashboard')}>Dashboard</button>
        <button onClick={() => setTab('settings')}>Settings</button>
      </nav>
      {tab === 'dashboard' && <Dashboard />}
      {tab === 'settings' && <Settings />}
    </div>
  );
}
```

`fixtures/vite-tab-state-app-deep/src/pages/Dashboard.tsx`:

```tsx
import { useState } from 'react';

type Range = 'monthly' | 'hour';

export function Dashboard() {
  const [range, setRange] = useState<Range>('monthly');
  return (
    <div>
      <button onClick={() => setRange('monthly')}>monthly</button>
      <button onClick={() => setRange('hour')}>hour</button>
      {range === 'monthly' && <div>Monthly View</div>}
      {range === 'hour' && <div>Hourly View</div>}
    </div>
  );
}
```

`fixtures/vite-tab-state-app-deep/src/pages/Settings.tsx`: minimal, no buttons.

`fixtures/vite-tab-state-app-deep/MUST_DISCOVER.json`:

```json
{
  "navigations": [
    { "method": "state-setter", "target": "dashboard", "scope": "top-level", "stateVar": "tab", "siblingNavigations": 0 },
    { "method": "state-setter", "target": "settings", "scope": "top-level", "stateVar": "tab", "siblingNavigations": 0 },
    { "method": "state-setter", "target": "monthly", "scope": "page-local", "stateVar": "range", "siblingNavigations": 0 },
    { "method": "state-setter", "target": "hour", "scope": "page-local", "stateVar": "range", "siblingNavigations": 0 }
  ]
}
```

Add an integration test in `src/extract/extract.test.ts`:

```ts
describe('vite-tab-state-app-deep navigation extraction', () => {
  it('classifies App.tsx setters as top-level', () => { /* ... */ });
  it('classifies pages/Dashboard.tsx setters as page-local', () => { /* ... */ });
});
```

### 6.4 New fixture: `vite-tab-state-app-ambiguous`

Tests the sibling-counting + confidence drop:

```tsx
import { useState } from 'react';

type Range = 'a' | 'b' | 'c';

export function App() {
  const [r, setR] = useState<Range>('a');
  return (
    <div>
      <button onClick={() => setR('a')}>Save</button>
      <button onClick={() => setR('b')}>Save</button>
      <button data-testid="save-c" onClick={() => setR('c')}>Save</button>
    </div>
  );
}
```

`MUST_DISCOVER.json`:

```json
{
  "navigations": [
    { "target": "a", "siblingNavigations": 2, "confidence": "medium", "scope": "top-level" },
    { "target": "b", "siblingNavigations": 2, "confidence": "medium", "scope": "top-level" },
    { "target": "c", "siblingNavigations": 2, "confidence": "high", "scope": "top-level" }
  ]
}
```

(`c` has `data-testid` so `preferred = 'testId'`; even though the text 'Save' is shared, confidence stays high. `a` and `b` have `preferred = 'text'`, so the `high → medium` drop applies.)

### 6.5 Live TraiderJo smoke (optional, not in CI)

A manual run script `scripts/smoke-traiderjo-hints.sh` that:

1. Points `extractViteNavigations` at `/tmp/TraiderJo`.
2. Asserts every navigation has `scope` set.
3. Asserts every navigation with `preferred = 'text'` and a popular text hint (e.g. "monthly", "hour", "save") has `siblingNavigations > 0` AND confidence dropped to `medium` or lower.
4. Asserts at least 4 navigations have `scope: 'top-level'` (the URL-routed `<Link>` paths in the marketing pages — landing, features, privacy, terms — assuming TraiderJo has them).
5. Asserts at least 8 navigations have `scope: 'page-local'` (Dashboard/Plan/Trades sub-tabs).

This is not a unit test; it's a manual confirmation gate.

---

## 7. Acceptance criteria

- [ ] All 6 new test cases in §6.1.1 pass.
- [ ] All 1 new test case in §6.1.2 passes.
- [ ] All 5 new test cases in §6.1.3 pass.
- [ ] All 6 new test cases in §6.1.4 pass.
- [ ] All 3 new test cases in §6.1.5 pass.
- [ ] The 1 new test case in §6.1.6 (catalog sorting) passes.
- [ ] `vite-tab-state-app` fixture: existing 4 navigations remain detected; new fields populated correctly per the §6.2 table.
- [ ] `vite-tab-state-app-deep` fixture: 4 navigations detected; scope classification matches MUST_DISCOVER.json.
- [ ] `vite-tab-state-app-ambiguous` fixture: 3 navigations detected with sibling-counting and confidence drop applied.
- [ ] `npm run typecheck` clean (no `any`, no `as any` introduced).
- [ ] `npm run lint` clean.
- [ ] `npm run test` clean.
- [ ] No existing test in `src/extract/vite/navigations.test.ts` modified except for additions.
- [ ] Catalog response (`getNavigationCatalog().navigations`) is sorted per §3.6 — verified by the §6.1.6 test.
- [ ] `surface_list_navigations` MCP response shape includes the new optional fields (no breaking change to existing consumers).
- [ ] Vision baseline against TraiderJo reaches ≥ 7 unique pages (gated externally; this spec's local acceptance is the unit + integration tests above).

---

## 8. Risks

| Risk | Mitigation |
|------|-----------|
| Scope classification heuristic is wrong for a project layout we haven't seen | Default to `top-level` on ambiguity; the crawler attempts to resolve at `/` and gracefully degrades. Document the fallback behavior in the README. |
| TraiderJo has navigations whose state-var name matches `tab|view|route|page|nav` but is page-local (e.g. `nav` inside `Settings.tsx`) | The state-var-name heuristic is one of several signals (file path is the primary). The combined heuristic is conservative enough; document the layered logic in the source comments. |
| The `vite-tab-state-app-deep` fixture's `Dashboard.tsx` is itself a state-setter file — the heuristic could mis-classify | The `pages/` directory match is the strongest signal; verify with the integration test. |
| Backward compatibility — existing BugHunter consumers may parse `Navigation` strictly | All new fields are optional; existing parsers ignore unknown fields. Verified by re-running existing v0.5 BugHunter test corpus against the post-spec extractor. |
| Sort order changes break consumers that rely on source-discovery order | Confidence-first ordering is the documented contract. Source-discovery order was never a stable contract. Document the new order in the tool description. |
| Sibling counting amplifies false-positives on common labels ("Save", "Cancel") | This is correct behavior — "Save" without a stronger hint really IS ambiguous. The crawler's job is to handle ambiguity (use testid when present, fall back to position when not). The hint catalog correctly reports the ambiguity. |
| Cross-file dedup miscounts when `(method, target, kind)` matches but the navs are semantically different (e.g. two different `<Link to="/about">` rendering different content) | `duplicateCount` is informational; consumers don't act on it directly. False sharing of the count is harmless. |
| ts-morph performance degrades when scoring scope across many files | Scope post-pass is O(navigations × project files) for the file-path match — bounded. The state-var-name heuristic is O(navigations). No perf regression beyond a few ms. |
| New fixtures create maintenance burden | The new fixtures are minimal (~30 lines each) and serve targeted assertions. The maintenance cost is < 30 min per year. |

---

## 9. Negative requirements

- Do **not** modify any test in `src/extract/vite/navigations.test.ts` other than to **add** new `describe()` blocks.
- Do **not** change the existing `Navigation` field types — only add optional fields.
- Do **not** introduce new ts-morph helpers if existing ones cover the case.
- Do **not** create new files in `src/extract/vite/` — all new logic lives in `navigations.ts` and `types.ts`.
- Do **not** change the signature of `extractViteNavigations` — the function arity and return type stay (return type extends; that's fine).
- Do **not** mutate `Navigation` objects in-place after construction — produce new objects in the post-passes.
- Do **not** introduce side effects in the post-passes (no I/O, no logging beyond debug-level traces).
- Do **not** add `any` to satisfy ts-morph type frictions; narrow with `asKindOrThrow` or explicit type guards.
- Do **not** modify the `surface_list_navigations` arguments shape (no new `filter` keys).
- Do **not** add `confidence: 'unknown'` or any new value to `NavigationConfidence` — the three-level union (`high | medium | low`) is fixed.

---

## 10. Task breakdown

Each task is independently completable and verifiable. Total estimated effort: ~1 senior-engineer-day.

### Task 1 — Type additions

**Assignee:** `@coder`
**Depends on:** none
**Files to modify:** `src/types.ts`
**Files to create:** none
**Test:** `npm run typecheck`
**Done when:** `Navigation` has the four new optional fields (`scope`, `siblingNavigations`, `duplicateCount`, plus nested `triggerSelectorHint.title` and `triggerSelectorHint.preferred`); existing field types unchanged.
**DO NOT:** add fields outside the listed paths; do not introduce new exported types.

### Task 2 — `title` attribute extraction

**Assignee:** `@coder`
**Depends on:** Task 1
**Files to modify:** `src/extract/vite/navigations.ts` (functions `extractTriggerInfo` lines 97-117, plus passes A/B/C/D where the hint object is built)
**Files to create:** none
**Test:** `npm test -- navigations.test.ts -t "title"`
**Done when:** §6.1.2 test case passes; `title` field is populated when the trigger has a `title="..."` literal attribute; `preferred` is set per §3.1 priority.
**DO NOT:** modify existing label-extraction logic.

### Task 3 — `preferred` selector field

**Assignee:** `@coder`
**Depends on:** Task 2
**Files to modify:** `src/extract/vite/navigations.ts`
**Files to create:** none
**Test:** `npm test -- navigations.test.ts -t "preferred"`
**Done when:** all 6 test cases in §6.1.1 pass; `preferred` is consistently set on every emitted navigation.
**DO NOT:** override an existing field — `preferred` is computed; never copies a value from `text`/`testId`/`ariaLabel`.

### Task 4 — Scope classification post-pass

**Assignee:** `@coder`
**Depends on:** Task 1
**Files to modify:** `src/extract/vite/navigations.ts` (add a new helper `classifyScope` and call it as a post-pass after pass D)
**Files to create:** none
**Test:** `npm test -- navigations.test.ts -t "scope"`
**Done when:** all 5 test cases in §6.1.3 pass; URL-based navigations always get `scope: 'top-level'`; state-setters classify correctly per the heuristic.
**DO NOT:** add I/O to the classifier; do not rely on the file system beyond the source-file path strings already in the project.

### Task 5 — Sibling-navigation counting + confidence drop

**Assignee:** `@coder`
**Depends on:** Task 4 (scope is required for per-scope counting)
**Files to modify:** `src/extract/vite/navigations.ts`
**Files to create:** none
**Test:** `npm test -- navigations.test.ts -t "siblingNavigations"`
**Done when:** all 6 test cases in §6.1.4 pass; confidence drops correctly when ambiguity meets `preferred === 'text'`.
**DO NOT:** raise confidence — only drops are allowed.

### Task 6 — Cross-file dedup count

**Assignee:** `@coder`
**Depends on:** Task 4
**Files to modify:** `src/extract/vite/navigations.ts`
**Files to create:** none
**Test:** `npm test -- navigations.test.ts -t "duplicateCount"`
**Done when:** all 3 test cases in §6.1.5 pass.

### Task 7 — Catalog sort

**Assignee:** `@coder`
**Depends on:** Tasks 3, 4, 5
**Files to modify:** `src/server/navigation-catalog.ts` (sort once after `extractNavigationsForStack` returns; before storing in `navigationCatalog`)
**Files to create:** `src/server/navigation-catalog.test.ts` (if not present)
**Test:** `npm test -- navigation-catalog.test.ts`
**Done when:** §6.1.6 test case passes; the catalog response is deterministic across regenerations.

### Task 8 — `vite-tab-state-app` fixture: extend MUST_DISCOVER

**Assignee:** `@coder`
**Depends on:** Tasks 2-6
**Files to modify:** `fixtures/vite-tab-state-app/MUST_DISCOVER.json`
**Files to create:** none
**Test:** `npm test -- extract.test.ts -t "vite-tab-state-app"`
**Done when:** the existing fixture's expected output reflects the new fields per §6.2.

### Task 9 — `vite-tab-state-app-deep` fixture

**Assignee:** `@coder`
**Depends on:** Task 8
**Files to create:** `fixtures/vite-tab-state-app-deep/{package.json, index.html, vite.config.ts, tsconfig.json, surfacemcp.config.json, MUST_DISCOVER.json, src/main.tsx, src/App.tsx, src/pages/Dashboard.tsx, src/pages/Settings.tsx}` (copy minimal config from `vite-tab-state-app`)
**Files to modify:** `src/extract/extract.test.ts` (add the `describe('vite-tab-state-app-deep ...')` block per §6.3)
**Test:** `npm test -- extract.test.ts -t "deep"`
**Done when:** integration test verifies scope classification end-to-end; setters in `App.tsx` are `top-level`; setters in `pages/Dashboard.tsx` are `page-local`.

### Task 10 — `vite-tab-state-app-ambiguous` fixture

**Assignee:** `@coder`
**Depends on:** Task 9
**Files to create:** `fixtures/vite-tab-state-app-ambiguous/{...}` (parallel structure to Task 9)
**Files to modify:** `src/extract/extract.test.ts`
**Test:** `npm test -- extract.test.ts -t "ambiguous"`
**Done when:** integration test verifies sibling-counting + confidence drop; testId-having target keeps high confidence while text-only siblings drop.

### Task 11 — README capability note

**Assignee:** `@coder`
**Depends on:** Tasks 1-10
**Files to modify:** `README.md`
**Files to create:** none
**Test:** none
**Done when:** README's capabilities section gains a one-paragraph note: "`surface_list_navigations` v2 — adds scope, sibling-count, duplicate-count, and preferred-selector fields. Backwards-compatible; new fields are optional."

### Task 12 — TraiderJo smoke (manual, not CI)

**Assignee:** `@coder` (or `@architect` for verification)
**Depends on:** Tasks 1-11
**Files to create:** `scripts/smoke-traiderjo-hints.sh`
**Test:** Manual run; assertions printed to stdout.
**Done when:** running the script against `/tmp/TraiderJo` prints the six summary stats from §6.5; the user can verify that hints have improved.

---

## 11. Open questions

- **OQ-1.** Should `siblingNavigations` count navigations across all confidence levels, or only same-confidence siblings? **Decision:** all confidence levels — ambiguity is a property of the rendered DOM, not the catalog's confidence assignment. Documented in §3.4.
- **OQ-2.** Should `duplicateCount` consider `triggerSelectorHint.preferred` as part of the dedup key? **Decision:** no — same `(method, target, kind, scope)` is enough. Hint variation across duplicates is a feature (consumer picks the strongest); not a dedup criterion.
- **OQ-3.** Should the post-passes run in parallel (Promise.all)? **Decision:** no — the post-passes are O(N) on N navigations, where N is small (< 100 even for TraiderJo). Sequential is simpler and faster than parallel-orchestration overhead.
- **OQ-4.** Should the new fields appear in the MCP tool description? **Decision:** yes; update `surface_list_navigations`'s description string in `src/server/http.ts` line 355 to mention `scope` and `preferred`. Consumers reading the tool list see the upgrade.
- **OQ-5.** Does scope classification need to handle `<Outlet />` (react-router-dom v6 layout pattern)? **Decision:** no — the page-local heuristic (file path matching `**/pages/**` or `**/views/**`) handles this naturally. `<Outlet />` is a render-target, not a navigation. Future spec if needed.

Out-of-scope (deferred):

- Wrapper-component support (`Link` re-exported from a project-local file). Documented in `SPEC_NAV_EXTRACT.md` §10.
- Cross-file setter detection (context-provider patterns).
- Closure-actions (`SPEC_V02_CLOSURE_ACTIONS.md`).
- Multi-stack navigation extraction beyond Vite.

---

## 12. Estimated effort

≈ 1 senior engineer-day for an experienced TypeScript/AST author. Coder-implementable end-to-end; no architectural decisions left unresolved. Highest-risk task is Task 4 (scope classification) — budget half a day, including the multi-file integration tests.

The vision-baseline killer demo gate (≥ 7 unique pages on TraiderJo) is **external** to this spec; it depends on BugHunter's crawler consuming the new fields. That work lives downstream in `BugHunter/SPEC_SPA_DEEP_CRAWL.md` (already partially shipped) and is not part of this spec's acceptance.

---

End of spec.
