# SPEC — SurfaceMCP: resolve closure-variable navigation targets via ts-morph

**Status:** ready for `@coder` · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-28 · **Predecessor:** `SPEC_NAV_EXTRACT.md` (shipped — Pass A/B/C/D), `SPEC_NAV_HINT_QUALITY.md` (in flight on `spec/nav-hint-quality`, page-local hint quality), `SPEC_V02_CLOSURE_ACTIONS.md` (Next.js server-action discovery — orthogonal). **Downstream consumer:** BugHunter SPA crawler (vision-baseline killer-demo gate on TraiderJo).

The static SPA navigation extractor today resolves only **literal-argument** state-setters (`setTab('dashboard')`). When the argument is a closure-bound identifier (`setTab(id)`), Pass C and Pass D both bail out with `dynamic_target`. Result: the **top-level navigation** of any SPA whose Navbar uses a factory-function or `array.map` rendering pattern is invisible to `surface_list_navigations`. TraiderJo, TanStack Router examples, react-router-dom examples, and effectively every non-trivial SPA we have measured against fall into this hole. This spec adds a bounded **second-chance closure-resolution pass** that turns closure-bound setter calls into concrete navigation entries when — and only when — the static graph proves the set of literal values the closure variable can take.

The fix is local: changes live in `src/extract/vite/navigations.ts`, `src/types.ts` (one new skip reason), the existing `vite-tab-state-app` fixture (no breaking change), and two new fixtures. No new files outside that list. No new dependencies. No behavior change for any input that was already resolvable.

---

## 1. Problem

### 1.1 The exact failure mode in TraiderJo

`/tmp/TraiderJo/src/components/Navbar.tsx` (verified file contents):

```tsx
type Props = { tab: string; setTab: (t: string) => void; /* … */ };

export function Navbar({ tab, setTab, /* … */ }: Props) {
  const item = (id: string, label: string) => (
    <button
      onClick={() => setTab(id)}
      className={/* … */}
    >
      {label}
    </button>
  );
  return (
    <div className="…">
      {/* logo */}
      {item('dashboard', 'Dashboard')}
      {item('trades', 'Trades')}
      {item('plan', 'Plan')}
      {item('import', 'Import')}
      {item('apr', 'Rankings')}
      {item('profile', 'Profile')}
      {item('settings', 'Settings')}
      {/* help button (literal) */}
    </div>
  );
}
```

The `setTab` setter is **passed in as a prop** — its `useState` lives in the parent (TraiderJo's `App.tsx`), where the existing extractor already resolves the union members and the literal-argument callsites correctly. But `Navbar.tsx` itself emits **zero** navigations: the seven `item(…)` calls render seven `<button onClick={() => setTab(id)}>` triggers whose `id` argument is the parameter `id` of the `item` arrow — Pass D sees `setTab(id)`, fails the `arg0.getKind() === SyntaxKind.StringLiteral` check, and pushes a single `dynamic_target` skip per `item` definition (or, more accurately, the call inside `item`'s body — one skip total, not seven).

This is the unifying killer demo gate. Vision baseline cannot reach the dashboard, trades, settings, plan, import, APR, or profile surfaces because the crawler does not know to click "Dashboard" / "Trades" / etc. at the root URL. IDOR matrix gets zero candidates. XSS sweep covers only the auth screen. The 16-line factory function is the entire blocker.

### 1.2 Why the existing extractor cannot resolve this

`src/extract/vite/navigations.ts:529` (verbatim):

```ts
if (arg0.getKind() !== SyntaxKind.StringLiteral) {
  skips.push({
    reason: 'dynamic_target',
    detail: `${sv.setterName}(${arg0.getText().slice(0, 30)}) non-literal at ${sourceFileRelative}:${line}`,
    declaredAt: { file: sourceFileRelative, line },
  });
  continue;
}
```

This is the entire failure: as soon as `arg0` is anything other than a `StringLiteral`, the pass concedes. There is no second-chance path that looks at where `arg0` came from.

The same pattern blocks Pass C (`useNavigate()`) at line 326. Generalizing the resolver to both passes is the goal.

### 1.3 The two real-world closure patterns

#### Pattern E1 — local factory call (TraiderJo)

A locally-declared arrow or function literal accepts parameters and renders a JSX trigger inside its body. Multiple invocations supply literal arguments.

```tsx
const item = (id: string, label: string) => (
  <button onClick={() => setTab(id)}>{label}</button>
);
return <>{item('dashboard', 'Dashboard')}{item('trades', 'Trades')}</>;
```

#### Pattern E2 — array-iteration JSX (TanStack / react-router idiom)

A literal array of objects is iterated via `.map(...)` (or, less commonly, `.forEach(...)` for side-effect rendering, or a `for..of` loop building JSX into an array). The iteree's destructured fields supply the setter argument and the JSX label.

```tsx
const tabs = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'trades',    label: 'Trades' },
  { id: 'settings',  label: 'Settings' },
];
return (
  <nav>
    {tabs.map(({ id, label }) => (
      <button key={id} onClick={() => setTab(id)}>{label}</button>
    ))}
  </nav>
);
```

Both patterns reduce to the same primitive: **at the setter callsite, the argument is an Identifier; the Identifier's value is statically determined by enumeration over a set of literal values supplied either at function callsites (E1) or as elements of a literal array (E2).** The spec's resolver covers both with one mechanism: an Identifier→callsite-bindings map.

### 1.4 In scope vs out of scope

In scope (this spec):

- E1: factory-call patterns where the factory is **declared in the same file** and called with **string-literal positional arguments**.
- E2: array-iteration patterns where the iteree array is a **literal const declaration in the same file** with **string-literal field values**.
- Resolution of the JSX label expression `{label}` (and `{ariaLabel}`, `{title}`) when it traces to the same parameter/destructure binding.
- Both Pass C (`useNavigate()` / `navigate(…)`) and Pass D (state-setters).

Out of scope (deferred or future work):

- **Cross-file factories.** `import { TabItem } from './TabItem'` where `TabItem` calls `setTab` internally. (Symbol resolution across files is correct in ts-morph, but the cost grows fast and TraiderJo doesn't need it. Future spec if needed.)
- **Computed targets.** `setTab(\`tab-${id}\`)` template-literal interpolation. Skip with `runtime_index` (see §5).
- **Index access.** `setTab(tabs[i].id)`. Skip with `runtime_index`.
- **Runtime-loaded iterables.** `setTab(t.id)` inside `tabs.map(...)` where `tabs` is `useState([])` later filled by `fetch`. Skip with new reason `runtime_iterable`.
- **Conditional filtering.** `tabs.filter(t => isAdmin || t.id !== 'admin').map(...)` — emit ALL tab entries (including admin) but **MUST NOT** invent a `roleGated` field for v1. Annotation lives in a future spec; today the worst case is one extra navigation attempted by the crawler, which is safe.
- **`switch (id)` resolution.** Switch-statement-with-string-cases inside a setter wrapper (`function go(id) { switch (id) { case 'a': setTab('a'); break; } }`) — defer; not the dominant SPA idiom.
- **Recursion into JSX-defined subcomponents.** `<NavItem id="dashboard" />` where `NavItem` internally calls `setTab` — defer; cross-file complexity.
- **Closure capture through context providers.** `const { setTab } = useTabContext()` plus `setTab(id)` — out of scope per `SPEC_NAV_EXTRACT.md` §10.
- **Wrapping `Link` with `to={x}`** — handled by `SPEC_NAV_EXTRACT.md` Pass A's existing `dynamic_target` skip; an extension parallel to this spec is plausible but lives separately.

The TraiderJo killer-demo gate requires only E1 (factory-call). The TanStack/react-router idiom is E2. Both cost the same to implement, share 80% of the resolver code, and ship together to avoid a second round of churn.

### 1.5 Live targets and acceptance posture

- **TraiderJo (`/tmp/TraiderJo`):** `surface_list_navigations` returns ≥ 7 new top-level navigations from `Navbar.tsx`, with `kind: 'state'`, `target ∈ { dashboard, trades, plan, import, apr, profile, settings }`, `triggerSelectorHint.text ∈ { Dashboard, Trades, Plan, Import, Rankings, Profile, Settings }`, `confidence: 'high'`. The existing `dynamic_target` skip at `Navbar.tsx:9` is **removed** (the resolver succeeds, no skip is emitted).
- **`vite-tab-state-app` (existing fixture):** **No change.** Existing 4 navigations remain; no new ones added; no skips removed.
- **`vite-tab-state-app-array-map` (NEW fixture):** Pattern E2. 4 navigations emitted by the resolver, one per array element.
- **`vite-tab-state-app-factory` (NEW fixture):** Pattern E1, mirrors TraiderJo's exact shape. 4 navigations emitted by the resolver, one per `item(…)` callsite.
- **Negative fixture cases (covered as inline test code, no fixture dir):** runtime-loaded iterable, computed-index access, template-literal interpolation, mixed literal/non-literal callsite arguments — each MUST result in a `dynamic_target` / `runtime_iterable` / `runtime_index` skip with no false-positive navigation.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `src/extract/vite/navigations.ts` | The whole navigation extractor — Passes A/B/C/D. The new logic is a **second-chance helper** invoked from the existing `dynamic_target` branches in Pass C (line ~326) and Pass D (line ~529). DO NOT introduce a new pass; extend the existing ones. |
| `src/extract/vite/navigations.test.ts` | Existing test patterns. Each new behavior gets a `describe` block at the bottom; do not modify any existing test. The `extractFromSource` helper at lines 10-22 is the canonical inline-fixture mechanism — reuse it for E1/E2 micro-tests. |
| `src/types.ts` (lines 250-308) | `Navigation`, `NavigationConfidence`, `NavigationCatalog`, `NavigationSkip`. **One** additive change here: add two reason values (`runtime_iterable`, `runtime_index`) to `NavigationSkip['reason']`. No other type changes. |
| `src/extract/vite/util.ts` | Shared utility (`buildImportMap`, `loadPathsMap`, `resolveImportSpecifier`). NOT modified. |
| `src/extract/extract.test.ts` | Integration test that loads `MUST_DISCOVER.json` per fixture. Two new `describe` blocks for the new fixtures land here. |
| `fixtures/vite-tab-state-app/src/App.tsx` | Reference fixture — **MUST stay byte-identical**. Existing 4-nav assertions must continue to pass. |
| `/tmp/TraiderJo/src/components/Navbar.tsx` | Real-world reference. The factory pattern (`item(id, label) => …`) is the killer demo. Coder MUST hand-verify this file resolves cleanly after implementation by running the live smoke (§7.5). |

### 2.2 Patterns to follow

- **Pure helpers.** The closure-resolver is a pure function: input `(arg0: Node, sourceFile: SourceFile)`, output `ResolvedClosureArg | null`. No I/O. No project-wide mutation.
- **Discriminated-union returns** for the resolver's success/skip channels. The resolver returns a tagged union; the caller (Pass C / Pass D) inspects `kind` and decides whether to emit navigations or push a skip.
- **Existing trigger-finder reuse.** `findEnclosingTrigger` and `extractTriggerInfo` already do the JSX traversal; the new code wraps them with a binding-resolution layer. **Do not duplicate trigger-walking logic.**
- **Bounded recursion.** Identifier-resolution chases at most **2 hops** of binding redirection (`const a = b; const b = 'x';` is 1 hop). Deeper alias chains stop with a skip — TraiderJo and TanStack idioms are at most 1 hop.
- **All new code paths run only when the existing literal-check fails.** Every existing test must continue to pass without modification.

### 2.3 DO NOT

- Do **not** create new files in `src/extract/vite/`. The new logic lives in `navigations.ts` (one new helper section, ≤ 200 lines added).
- Do **not** create a new `Pass E`. The resolver is invoked from Passes C and D; introducing a fifth pass duplicates the trigger-walking and the dedup logic. Reusing the existing emission branches keeps the patch surgical.
- Do **not** mutate any existing `Navigation` object after construction. New entries are pushed; old entries are left alone.
- Do **not** add `confidence: 'low'` from this resolver. If both target and label fail to resolve, fall through to `dynamic_target`. Resolver outputs are `'high'` (target + label both literal) or `'medium'` (target literal, label non-literal).
- Do **not** introduce new ts-morph imports beyond what `navigations.ts` already pulls. `Project, SyntaxKind, SourceFile, Node` cover everything. (`Symbol`, `Identifier` are accessed via existing `getKind`/`asKindOrThrow`.)
- Do **not** call `Symbol.getValueDeclaration()` cross-file. The spec is same-file only for v1; symbol-table lookups stay within the source file.
- Do **not** modify `src/extract/vite/util.ts`, `src/extract/navigations/index.ts`, `src/server/navigation-catalog.ts`, or `src/server/http.ts`. None of them require changes for this spec.
- Do **not** change the public signature of `extractViteNavigations`. Return type extends (no new top-level fields); arity unchanged.
- Do **not** introduce new dependencies. ts-morph is already in.
- Do **not** introduce `as any` to satisfy ts-morph friction. Narrow with `asKindOrThrow` or explicit kind checks. If a narrowing is genuinely impossible, return `null` from the resolver (skip path) rather than fight the types.
- Do **not** add `roleGated`, `conditional`, or any new `Navigation` field. Edge cases that suggest such a field land in `§10 open questions` for a follow-up spec.
- Do **not** depend on `SPEC_NAV_HINT_QUALITY.md` having merged. This spec stands alone. The two interact correctly because all existing post-passes (sibling counting, dedup, scope classification) consume `Navigation` objects and don't care how each entry was produced.

---

## 3. Design

### 3.1 Top-level structure

The closure-resolver lives in **one new section** at the bottom of `src/extract/vite/navigations.ts`, between the existing helpers and `extractViteNavigations`. The section exports nothing externally; all types and functions are file-private.

```
src/extract/vite/navigations.ts (after this spec)
├── existing label/trigger helpers
├── existing Pass A (Link/NavLink)
├── existing Pass B (anchor href)
├── existing Pass C (useNavigate)              ← modified: invokes resolveClosureArg() on skip path
├── existing Pass D (state-setter)             ← modified: invokes resolveClosureArg() on skip path
├── NEW: closure-arg resolver section
│   ├── type ResolvedClosureArg
│   ├── resolveClosureArg(arg, sf)             ← entry point
│   ├── tryFactoryCallResolution(...)          ← Pattern E1
│   ├── tryArrayMapResolution(...)             ← Pattern E2
│   ├── resolveBindingToLiteral(...)           ← shared binding chaser
│   └── resolveJsxLabelInScope(...)            ← context-aware label
└── existing extractViteNavigations
```

The two pass functions (C and D) gain ~10 lines apiece — they catch the ex-skip path, call `resolveClosureArg`, and either emit N navigations or push the original skip. No other changes to Passes A/B/C/D.

### 3.2 Resolver entry point

```ts
type ResolvedClosureArg =
  | { kind: 'resolved'; bindings: Array<{ target: string; label?: string; ariaLabel?: string; title?: string; testId?: string; }> }
  | { kind: 'skip'; reason: 'dynamic_target' | 'runtime_iterable' | 'runtime_index' | 'iterable_overflow'; detail: string };

/**
 * Attempt to resolve a non-literal call argument to a finite set of concrete bindings.
 *
 * Returns 'resolved' with N >= 1 bindings when:
 *   - Pattern E1 (factory call): arg traces to a parameter of an enclosing function whose every callsite supplies a string-literal at the matching position; OR
 *   - Pattern E2 (array map):    arg traces to a destructured field of a `.map`/`.forEach` arrow's parameter, and the iteree resolves to a const-bound array literal.
 *
 * Returns 'skip' otherwise. The caller MUST push a NavigationSkip with the reason.
 */
function resolveClosureArg(arg: Node, sf: SourceFile): ResolvedClosureArg
```

**Caller (Pass D, around line 529):**

```ts
if (arg0.getKind() !== SyntaxKind.StringLiteral) {
  // Skip on updaters first (existing behavior, unchanged)
  if (arg0.getKind() === SyntaxKind.ArrowFunction || arg0.getKind() === SyntaxKind.FunctionExpression) {
    skips.push({ reason: 'dynamic_target', detail: ..., declaredAt: ... });
    continue;
  }

  // NEW: second-chance closure resolution
  const resolved = resolveClosureArg(arg0, sf);
  if (resolved.kind === 'skip') {
    skips.push({ reason: resolved.reason, detail: resolved.detail, declaredAt: { file: sourceFileRelative, line } });
    continue;
  }

  // Iterable overflow guard (defensive; resolver also self-checks)
  if (resolved.bindings.length === 0) continue;

  // Find enclosing trigger ONCE; the trigger node is shared across all bindings
  const trigger = findEnclosingTrigger(call);
  if (!trigger) {
    skips.push({ reason: 'no_trigger_label', detail: ..., declaredAt: { file: sourceFileRelative, line } });
    continue;
  }

  for (const binding of resolved.bindings) {
    const target = binding.target;
    const dedupeKey = `${sourceFileRelative}:${line}:${target}`;
    if (emitted.has(dedupeKey)) continue;
    emitted.add(dedupeKey);

    const inUnion = sv.unionMembers.has(target);
    // Confidence rules: high if target+label both resolved AND target ∈ union; medium if either is missing or out-of-union (still emit; don't drop to low)
    const labelResolved = binding.label !== undefined && binding.label.trim() !== '';
    const confidence: NavigationConfidence =
      inUnion && labelResolved ? 'high'
      : inUnion ? 'medium'
      : 'low';

    navigations.push({
      label: binding.label ?? '',
      method: 'state-setter',
      target,
      kind: 'state',
      stateVar: sv.varName,
      triggerSelectorHint: {
        text: binding.label || undefined,
        testId: binding.testId,
        ariaLabel: binding.ariaLabel,
      },
      sourceFile: sourceFileRelative,
      sourceLine: line,
      confidence,
    });
  }
  continue;
}
```

**Caller (Pass C, around line 326):** same shape, but for `method: 'router-push'` and `kind: 'url'`. Confidence logic is simpler — there's no union to check, so:
- `confidence: 'medium'` always (matches existing Pass C literal-arg confidence).

### 3.3 Pattern E1 — factory-call resolution

**Algorithm `tryFactoryCallResolution(arg, sf)`:**

1. **Validate the argument is a simple identifier.** If `arg.getKind() !== SyntaxKind.Identifier`, return `null` (caller falls through to E2). This excludes property accesses, call expressions, template literals, and binary expressions.
2. **Find the parameter declaration the identifier resolves to.** Walk up the AST from `arg` until finding an enclosing `ArrowFunction`, `FunctionExpression`, or `FunctionDeclaration`. For each candidate:
   - Check if any of its parameters has the same name as `arg.getText()`.
   - If yes, that's the **resolution function**. Stop and capture (a) the function node, (b) the parameter index, (c) the parameter name.
   - If no parameter matches, continue walking up. (Skips event-handler arrow functions like `() => setTab(id)` whose `id` is captured from an outer scope.)
3. **If no enclosing function declares the name as a parameter** (e.g. the identifier is captured from a `const` or `useState` outside any arrow), return `null` — try E2 fallback (which itself will fail, leading to `dynamic_target`).
4. **Bound the resolution function.** It MUST be:
   - declared as a `const`, `let`, or `var` at file scope OR inside a `FunctionComponent` body — the spec does not chase imports;
   - referenced by **at least one** `CallExpression` in the same source file whose `getExpression().getText()` equals the resolution function's binding name.
   If either fails, return `null`.
5. **Find every callsite.** For each `CallExpression` in `sf` whose callee is the resolution function's binding name:
   - Get `args = call.getArguments()`.
   - If `args[paramIndex]` is a `StringLiteral`, capture its value.
   - Else, the call is **mixed** — return a `'skip'` with reason `'dynamic_target'` and detail `factory ${fnName} called with non-literal at line ${line}`. **Mixed callsites are unsafe: emitting only the literal subset would silently miss a clickable target.**
6. **Resolve the JSX-label expression at each callsite (if applicable).** The setter callsite lives inside the resolution function's body (the `<button onClick={() => setTab(id)}>{label}</button>`). Find the label-expression: it's the `JsxExpression` in the trigger element's children whose expression text matches a parameter name. For each parameter found this way (`label`, `ariaLabel`, `title`), record the parameter index. At each external callsite, the literal at that parameter index becomes the per-callsite label/ariaLabel/title.
7. **Emit `kind: 'resolved'` with one binding per callsite.**

**Bound check.** If `bindings.length > 32`, return `'skip'` with reason `'iterable_overflow'`. Same constant as `MAX_UNION_MEMBERS` (Pass D line 369) — keep them aligned.

#### 3.3.1 Worked example — TraiderJo

```tsx
const item = (id: string, label: string) => (   // resolution function
  <button onClick={() => setTab(id)}>{label}</button>
);
{item('dashboard', 'Dashboard')}                  // callsite 1
{item('trades', 'Trades')}                        // callsite 2
…
```

- `arg = id` (Identifier inside `setTab(id)`).
- Walking up from `arg`: first enclosing function is `() => setTab(id)` — does NOT declare `id`. Continue. Next: `(id, label) => <button>…</button>` — declares `id` at index 0 AND `label` at index 1. Stop. **Resolution function = `item`**, `paramIndex = 0`, `paramName = 'id'`.
- `item` is a `const`-bound arrow at file scope; called 7 times in the same file.
- Find label expression in trigger body. The trigger is the `<button>` returned by `item`'s body. Its children include `{label}` — a `JsxExpression` resolving to parameter `label` at index 1. Record `labelParamIndex = 1`.
- For each of the 7 callsites: `args[0]` is a `StringLiteral` ('dashboard', …); `args[1]` is a `StringLiteral` ('Dashboard', …). All literal — proceed.
- Emit 7 bindings, each with `target` and `label` populated. `confidence: 'high'`.

#### 3.3.2 Edge case — capture from outer scope

```tsx
function App() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const id = 'dashboard';
  return <button onClick={() => setTab(id)}>Dashboard</button>;
}
```

- `arg = id`.
- Walking up: enclosing arrow `() => setTab(id)` does NOT declare `id` as a parameter. Next: `App` does NOT declare `id` as a parameter. **No resolution function found** — return `null`. Fall through to E2 (which also fails). Final outcome: `dynamic_target` skip.

(A future spec could resolve `const id = 'dashboard'` via `resolveBindingToLiteral`. v1 does not — TraiderJo doesn't need it, and the false-positive risk on captured identifiers without finite enumeration is real. Documented in §10.)

### 3.4 Pattern E2 — array-iteration resolution

**Algorithm `tryArrayMapResolution(arg, sf)`:**

1. **Validate the argument is a simple identifier.** Same as E1 step 1.
2. **Find the destructure declaration.** Walk up from `arg` to enclosing `ArrowFunction` / `FunctionExpression` whose parameter list contains an `ObjectBindingPattern` declaring `arg.getText()` as a destructured property. Capture (a) the arrow/fn node, (b) the property name (`'id'`).
3. **Confirm the arrow is a `.map` / `.forEach` callback.** The arrow's parent must be a `CallExpression` whose `getExpression()` is a `PropertyAccessExpression` ending in `.map` or `.forEach`. (`.flatMap` is also accepted; treat as `.map`.)
4. **Resolve the iteree to a literal array.** The PropertyAccessExpression's `getExpression()` is the iteree. Two cases:
   - **Direct array literal:** `[{id:'a',label:'A'},...].map(...)` — iterate the elements directly.
   - **Identifier (`tabs`):** call `resolveBindingToLiteral(identifier, sf)`. This helper walks back at most 2 hops through `const X = Y` / `const X = Z` style aliases until landing on an `ArrayLiteralExpression`. If the chain lands on anything else (`useState(...)`, `fetch(...)`, an imported binding, a function call) — return `'skip'` with reason `'runtime_iterable'`.
5. **Validate every array element.** Each element MUST be an `ObjectLiteralExpression`. If any element is a spread, conditional, function call, or other non-object — return `'skip'` with reason `'runtime_iterable'`.
6. **Extract field values per element.** For each element, find the property whose name matches the destructured target field; require its initializer to be a `StringLiteral`. If any element's required field is missing or non-literal — return `'skip'` with reason `'runtime_iterable'`.
7. **Resolve label / ariaLabel / title fields the same way** (per §3.3.6 — find JSX expressions in the trigger that map back to destructured property names, then look up the corresponding field on each element).
8. **Length bound.** If `elements.length > 32`, return `'skip'` with reason `'iterable_overflow'`.
9. **Emit `kind: 'resolved'` with one binding per element.**

#### 3.4.1 Worked example — TanStack idiom

```tsx
const tabs = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'trades',    label: 'Trades' },
];
{tabs.map(({ id, label }) => (
  <button onClick={() => setTab(id)}>{label}</button>
))}
```

- `arg = id`. Walking up: enclosing arrow `({id, label}) => <button>…</button>` declares `id` via ObjectBindingPattern. Captured.
- Arrow's parent is `tabs.map(...)` — a `.map` call. Iteree = `tabs` (Identifier).
- `resolveBindingToLiteral(tabs)`: 1 hop — `const tabs = [...]`. Lands on ArrayLiteralExpression. OK.
- Iterate 2 elements. Each is an ObjectLiteralExpression. Each has `id` (string-literal) and `label` (string-literal). OK.
- Find label expression in trigger body. `{label}` traces to destructure field `label`. Record.
- Emit 2 bindings. `confidence: 'high'`.

### 3.5 Shared helpers

#### `resolveBindingToLiteral(node, sf, depth = 2)`

Returns the `ArrayLiteralExpression` node if `node` (an Identifier) resolves through ≤ `depth` levels of `const X = Y` redirection to a const-bound array literal in the same source file. Otherwise returns `null`.

- Use `sf.getVariableDeclaration(node.getText())` to find the binding (file-local only).
- If the initializer is an `ArrayLiteralExpression`, return it.
- If the initializer is an Identifier and `depth > 0`, recurse with `depth - 1`.
- Else return `null`.

#### `resolveJsxLabelInScope(triggerNode, paramNames)`

Given a JSX trigger node and a set of parameter names, scan the trigger's text-content children for `JsxExpression`s whose expression is a single Identifier matching a name in the set. Returns a map `{ paramName -> 'text' | 'ariaLabel' | 'title' | 'testId' role }`. The role is determined by where the expression is used:
- Inside the trigger's children (textContent) → `'text'`.
- As the value of a `JsxAttribute` named `aria-label` → `'ariaLabel'`.
- As the value of a `JsxAttribute` named `title` → `'title'`.
- As the value of a `JsxAttribute` named `data-testid` → `'testId'`.

This function does NOT extract literal values — it only identifies which parameters surface as which selector roles. Per-binding literal substitution happens at emission time.

### 3.6 Negative cases and skip reasons

| Input | Resolver outcome | Skip reason |
|---|---|---|
| `setTab(id)` where `id` is a captured outer-scope `const id = ...` | resolver returns `null` (E1+E2 both fail) | caller emits `dynamic_target` (existing behavior preserved) |
| `setTab(id)` inside `tabs.map(t => …)` where `tabs = useState([])` | E2 detects iteree but `resolveBindingToLiteral` lands on `useState(...)` | `runtime_iterable` |
| `setTab(tabs[i].id)` — index access, not destructure | resolver returns `null` (arg is `PropertyAccessExpression`, not `Identifier`); but caller's pre-check for `ElementAccessExpression` catches it | `runtime_index` |
| `setTab(\`tab-${id}\`)` — template literal | resolver returns `null` (arg is `TemplateExpression`, not Identifier) | `dynamic_target` (unchanged); future spec may handle |
| `[{id: 'a'}, ...spreadArr].map(...)` — spread element | E2 step 5 fails | `runtime_iterable` |
| `tabs.map(...)` where `tabs.length` would exceed 32 | E2 step 8 | `iterable_overflow` |
| Mixed `item('a', 'A')` and `item(getId(), 'B')` callsites | E1 step 5 detects non-literal at one callsite | `dynamic_target` (entire factory unsafe) |
| `setTab(condition ? 'a' : 'b')` — conditional | resolver returns `null` (ternary not Identifier) | `dynamic_target`; future spec may enumerate ternary branches |

**Caller-level pre-check for `runtime_index`:** before calling `resolveClosureArg`, the caller checks `if (arg0.getKind() === SyntaxKind.ElementAccessExpression) { skips.push({ reason: 'runtime_index', ... }); continue; }`. This is a 3-line addition and produces a clearer skip reason than `dynamic_target`.

### 3.7 Pass C (useNavigate) parity

The same resolver runs on Pass C's `dynamic_target` skip path (line ~326). The only difference: navigations emitted from Pass C have `method: 'router-push'`, `kind: 'url'`, no `stateVar`, and the confidence assignment is simpler:

```ts
const confidence: NavigationConfidence = labelResolved ? 'medium' : 'low';
```

(Pass C's existing literal-arg confidence is `'medium'`. The closure-resolved entries cannot exceed that.)

The fixture coverage for Pass C closure-resolution is one inline test per pattern (E1, E2). Full fixture build is not required — the per-pattern unit tests exercise the same resolver code.

### 3.8 Interaction with Pass D's union-member checking

Today, Pass D refuses to emit a navigation whose `target` is not in the inferred union (`unionMembers`). The closure-resolver does not bypass this — every emitted target is still checked against the union, and the existing confidence logic applies:

- `target ∈ unionMembers` AND `inferredUnion === false` AND label resolved → `'high'`.
- `target ∈ unionMembers` AND `inferredUnion === true` → `'medium'`.
- `target ∉ unionMembers` → `'low'`.

In TraiderJo, the parent `App.tsx` declares `useState<Tab>(...)` where `Tab = 'dashboard' | 'trades' | 'plan' | 'import' | 'apr' | 'profile' | 'settings' | 'wiki'`. **But the `setTab` setter is a prop** in `Navbar.tsx`, not a local `useState`. Pass D's `stateVars` discovery happens **per file**. In `Navbar.tsx`, Pass D finds zero state-vars (no `useState` call) and returns early.

This is a **load-bearing limitation**: Pass D today cannot resolve a setter that is passed as a prop. The closure-resolver alone does not lift this; it would still fire only when a state-var is found in the same file.

**Resolution:** the spec adds a **prop-setter recognition step** to Pass D. Before the `if (stateVars.length === 0) return;` early-out at line 485, scan the current file's exported function signatures for **prop-typed setters** matching the pattern:

```ts
type Props = { tab: string; setTab: (t: string) => void; ... };
```

Or, more permissively, any function-component parameter whose object-type member is named `set<X>` and typed as `(arg: <stringtype>) => void` / `(arg: <stringtype>) => any`. For each such setter:

1. Treat the setter name as a known setter (add to a `propSetters: Set<string>` parallel to `stateVars`).
2. Skip union-membership checks for prop setters (we don't know the union in this file). Confidence becomes:
   - `'high'` if target+label both literal AND from closure-resolution (target was statically determined).
   - `'medium'` otherwise.
3. `stateVar` field: set to the setter's parameter name (`'setTab'`) — debugging hint for the consumer.

This is the **minimum change** needed to make TraiderJo work. It is bounded — only same-file prop signatures are inspected. Cross-file context-providers remain out of scope.

**Trade-off acknowledged:** prop-setter recognition is a small but real expansion of Pass D's scope. The alternative (relying on the parent file's Pass D to discover the navigations via the parent's literal-arg `setTab(...)` calls) **does not work for TraiderJo** — the parent file (`App.tsx`) does NOT call `setTab(literal)` directly; it only renders `<Navbar setTab={setTab} />`. The setter calls live exclusively in `Navbar.tsx`. Without prop-setter recognition, no extractor sees them.

### 3.9 Confidence rules — closure-resolved navigations

Decision table (first match wins). `T` = target. `L` = label resolved (non-empty literal). `U` = `unionMembers` available and `T ∈ unionMembers`. `P` = derived from prop-setter (no local union).

| Source | T | L | U | P | confidence |
|---|---|---|---|---|---|
| Pass D, local state-var | resolved | yes | yes | n/a | `high` |
| Pass D, local state-var | resolved | no  | yes | n/a | `medium` |
| Pass D, local state-var | resolved | yes | no  | n/a | `medium` (target probably typo'd or wider type than detected) |
| Pass D, prop-setter | resolved | yes | n/a | yes | `high` |
| Pass D, prop-setter | resolved | no  | n/a | yes | `medium` |
| Pass C, useNavigate | resolved | yes | n/a | n/a | `medium` |
| Pass C, useNavigate | resolved | no  | n/a | n/a | `low` |

The resolver itself never emits `'low'` from Pass D — Pass D's existing `'low'` semantics (target outside union) are preserved through the same path; the closure-resolver just feeds it more candidate targets.

### 3.10 What Passes C and D look like after the patch

The diff is small. Pass D's existing skip block (lines 528-545) is replaced by:

```ts
// 1. Pre-check: element-access (e.g. tabs[i].id) gets its own skip reason.
if (arg0.getKind() === SyntaxKind.ElementAccessExpression) {
  skips.push({
    reason: 'runtime_index',
    detail: `${sv.setterName}(${arg0.getText().slice(0, 30)}) element-access at ${sourceFileRelative}:${line}`,
    declaredAt: { file: sourceFileRelative, line },
  });
  continue;
}

// 2. Updater-fn check (existing, unchanged).
if (arg0.getKind() === SyntaxKind.ArrowFunction || arg0.getKind() === SyntaxKind.FunctionExpression) {
  skips.push({ reason: 'dynamic_target', /* … existing detail … */ });
  continue;
}

// 3. Existing literal-arg fast path (unchanged).
if (arg0.getKind() === SyntaxKind.StringLiteral) {
  /* … existing emission code … */
  continue;
}

// 4. NEW: closure-arg second-chance resolution.
const resolved = resolveClosureArg(arg0, sf);
if (resolved.kind === 'skip') {
  skips.push({
    reason: resolved.reason,
    detail: resolved.detail,
    declaredAt: { file: sourceFileRelative, line },
  });
  continue;
}
// … emission loop (see §3.2) …
```

Pass C's diff has the same shape: pre-checks + literal fast path + closure resolver.

The new `resolveClosureArg` plus its helpers add roughly **180 lines** to `navigations.ts`. Total file size goes from 698 to ~880. This is past the project's 300-lines-per-file guideline, so the implementer MUST split before merging:

- Move the closure-resolver section to **`src/extract/vite/navigations-closure.ts`** (new file, ≤ 200 lines, exports `resolveClosureArg` and the supporting helper types).
- `navigations.ts` imports from it and stays under 750 lines.

(This is the SECOND new file — the first being the closure module itself. The fixture files are not "code" in this sense. The split is clean and well-bounded; it does not violate the "no new files in `src/extract/vite/`" rule because the rule was a soft rule and we're keeping the directory tidy. The split is ALLOWED and REQUIRED.)

---

## 4. Type changes

### 4.1 `src/types.ts`

```diff
 export type NavigationSkip = {
   reason:
     | 'dynamic_target'
     | 'unresolved_setter'
     | 'union_overflow'
+    | 'iterable_overflow'
+    | 'runtime_iterable'
+    | 'runtime_index'
     | 'no_trigger_label';
   detail?: string;
   declaredAt?: { file: string; line: number };
 };
```

Three new reason values. **All other types unchanged.** No new `Navigation` field is added by this spec.

### 4.2 No public-API surface change

`extractViteNavigations` signature, return shape, and tool-handler wire-up are untouched. The catalog produced by `getNavigationCatalog()` simply contains more entries (the closure-resolved navigations) and slightly different skip reasons. Existing BugHunter consumers continue to work; new reasons are silently ignored by code that filters on the existing four.

---

## 5. Edge cases — exhaustive enumeration

| # | Input shape | Resolver path | Outcome |
|---|---|---|---|
| 1 | TraiderJo factory: 7 callsites, all literal args | E1 | 7 navigations, `confidence: 'high'` |
| 2 | TanStack: `[{id, label}, ...].map(...)` | E2 | N navigations, `confidence: 'high'` |
| 3 | `tabs.map(...)` where `const tabs = ARRAY` (1 hop) | E2, `resolveBindingToLiteral` succeeds | N navigations |
| 4 | `tabs.map(...)` where `const tabs = otherArr; const otherArr = ARRAY` (2 hops) | E2, `resolveBindingToLiteral` succeeds at depth 1 | N navigations |
| 5 | `tabs.map(...)` where `const tabs = useState(initial)[0]` | E2, `resolveBindingToLiteral` returns null at `CallExpression(useState)` | `runtime_iterable` skip |
| 6 | `tabs.map(...)` where `tabs` is imported from another file | E2, `resolveBindingToLiteral` returns null (no local declaration) | `runtime_iterable` skip |
| 7 | Mixed callsites: `item('a', 'A'); item(x, 'B');` | E1 step 5 | `dynamic_target` skip on the factory |
| 8 | `item('a', 'A')` only — single callsite, all literal | E1 | 1 navigation |
| 9 | `setTab(id)` inside an arrow that captures `id` from outer scope | E1 fails (not a parameter), E2 fails (not a destructure) | `dynamic_target` skip |
| 10 | `setTab(\`tab-${id}\`)` template literal | resolver returns `null` (arg is TemplateExpression) | `dynamic_target` skip |
| 11 | `setTab(tabs[i].id)` element-access | caller pre-check | `runtime_index` skip |
| 12 | `setTab(condition ? 'a' : 'b')` ternary | resolver returns `null` (ternary not Identifier) | `dynamic_target` skip |
| 13 | `setTab(getId())` call result | resolver returns `null` | `dynamic_target` skip |
| 14 | `setTab(props.id)` PropertyAccess on a captured Identifier | resolver returns `null` (arg is PropertyAccessExpression, not Identifier) | `dynamic_target` skip (future spec may resolve common idioms) |
| 15 | `array.flatMap(({id}) => ...)` | E2 (treats flatMap as map) | works, N navigations |
| 16 | Array exceeds 32 elements | E2 step 8 | `iterable_overflow` skip |
| 17 | Array element is a spread or function call | E2 step 5 | `runtime_iterable` skip |
| 18 | Required destructured field missing on one element | E2 step 6 | `runtime_iterable` skip |
| 19 | Closure-resolved target ∉ union (Pass D) | normal Pass D logic | navigation emitted with `confidence: 'low'` |
| 20 | Closure-resolved navigation duplicates an existing literal-arg one (same file, same line) | existing dedup `emitted: Set<string>` | only first emitted |
| 21 | Trigger element's label is a JSX expression that doesn't map to a destructured field (e.g. `{i18n.t('foo')}`) | resolver emits with `label: undefined`, `triggerSelectorHint.text: undefined` | navigation emitted; consumers fall back to other selectors. Confidence: `medium`. |
| 22 | Two destructure aliases: `({id: tabId, label}) => setTab(tabId)` | E2 with rename: resolves to property name `id` correctly via BindingElement.getNameNode() vs propertyNameNode | works, N navigations (implementer must use `getPropertyNameNode()` on the destructure) |
| 23 | Pass D with **prop-setter** factory pattern (TraiderJo) | §3.8 prop-setter detection + E1 | 7 navigations, `confidence: 'high'`, `stateVar: 'setTab'` |
| 24 | Pass D with prop-setter but no factory (literal arg in onClick) | §3.8 prop-setter detection, normal literal emission path | 1 navigation, `confidence: 'medium'` (no union to confirm) |
| 25 | Pass C closure resolution: `useNavigate()` then `nav(path)` where `path` is a factory parameter | E1 from Pass C | navigations emitted, `confidence: 'medium'` |
| 26 | Empty array literal `const tabs = []` | E2 step 5 (zero elements) | NO navigations emitted; resolver returns `kind: 'resolved'` with `bindings: []`; caller's `if (resolved.bindings.length === 0) continue;` makes this a silent no-op (no skip, no nav) |
| 27 | `forEach` instead of `map` (rare; e.g. building an array imperatively) | E2 accepts `.forEach` | works, N navigations |
| 28 | `for (const t of tabs) { … }` for-of loop | NOT supported in v1 (resolver returns null) | `dynamic_target` skip |
| 29 | Trigger label is `{label.toUpperCase()}` (method call on a destructured field) | label resolution returns null for that JsxExpression | navigation emitted with `label: undefined`; confidence drops to `medium` |
| 30 | Recursion: factory calls itself | E1 step 5 detects own callsite as a literal-checking step; if all callsites are literal, it works; if not, `dynamic_target` skip | safe |

---

## 6. Tests

### 6.1 Unit tests — `src/extract/vite/navigations.test.ts` (additions only)

All new tests use the existing `extractFromSource` helper. Add these `describe` blocks at the bottom of the file. **Do not modify any existing test.**

#### 6.1.1 `describe('Pass D — closure-arg resolution: factory call (E1)')`

```ts
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

it('factory/captured-identifier: id is from outer scope, not a parameter → dynamic_target', async () => {
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

it('factory/single-callsite: 1 callsite all literal → 1 navigation', async () => { /* trivial; expect 1 nav, target='a', confidence='high' */ });

it('factory/label-resolution: {label} JSX expression resolves per-callsite', async () => {
  // Verify triggerSelectorHint.text differs across the 3 emitted navigations (label substitution worked)
});

it('factory/aria-label-resolution: {ariaLabel} attribute resolves per-callsite', async () => {
  // Factory: const item = (id, ariaLabel) => <button aria-label={ariaLabel} onClick={() => setTab(id)} />
  // Verify triggerSelectorHint.ariaLabel is per-callsite literal
});
```

#### 6.1.2 `describe('Pass D — closure-arg resolution: array map (E2)')`

```ts
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

it('map/destructure-rename: ({id: tabId, label}) → setTab(tabId)', async () => { /* verify rename works */ });

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

it('map/spread-element: [...other] → runtime_iterable skip', async () => { /* spread element fails step 5 */ });

it('map/missing-field: one element missing required field → runtime_iterable skip', async () => { /* element {id:'a'} without label → fails step 6 */ });

it('map/flatMap: tabs.flatMap(...) treated like map', async () => { /* verify */ });

it('map/forEach: tabs.forEach(...) accepted', async () => { /* verify */ });

it('map/binding-1-hop: const tabs = ARRAY then map', async () => { /* resolveBindingToLiteral 1 hop */ });

it('map/binding-2-hops: const tabs = other; const other = ARRAY', async () => { /* resolveBindingToLiteral 2 hops */ });

it('map/binding-3-hops: const tabs = a; const a = b; const b = ARRAY → null (depth exceeded)', async () => { /* runtime_iterable skip */ });

it('map/empty-array: const tabs = []; → 0 navigations, no skip', async () => { /* silent no-op */ });
```

#### 6.1.3 `describe('Pass D — closure-arg resolution: bounded')`

```ts
it('iterable_overflow: array of 33 elements → iterable_overflow skip', async () => { /* */ });
it('runtime_index: setTab(tabs[i].id) → runtime_index skip', async () => { /* */ });
it('template-literal: setTab(`tab-${id}`) → dynamic_target skip (not handled in v1)', async () => { /* */ });
it('ternary: setTab(cond ? "a" : "b") → dynamic_target skip', async () => { /* */ });
```

#### 6.1.4 `describe('Pass D — prop-setter recognition')`

```ts
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
});

it('prop-setter/literal: props.setTab + literal-arg onClick → 1 navigation, confidence medium', async () => { /* */ });

it('prop-setter/non-string-type: props.setVisible: (b: boolean) => void → not detected as nav setter', async () => { /* must not emit */ });
```

#### 6.1.5 `describe('Pass C — closure-arg resolution')`

```ts
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

it('useNavigate/array-map: nav(t.path) inside .map → navigations emitted', async () => { /* */ });
```

### 6.2 Existing fixture: `vite-tab-state-app`

**No change.** The fixture's `App.tsx` uses literal-arg setter calls; the existing 4 navigations remain. Acceptance: existing test in `src/extract/extract.test.ts` continues to pass without modification.

### 6.3 New fixture: `fixtures/vite-tab-state-app-factory`

Mirrors TraiderJo's exact pattern. Files:

`fixtures/vite-tab-state-app-factory/package.json`, `index.html`, `vite.config.ts`, `tsconfig.json`, `surfacemcp.config.json`: copied verbatim from `vite-tab-state-app` with project name swap.

`fixtures/vite-tab-state-app-factory/src/main.tsx`:

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
```

`fixtures/vite-tab-state-app-factory/src/App.tsx`:

```tsx
import { useState } from 'react';
import { Navbar } from './components/Navbar';
import { Dashboard } from './pages/Dashboard';
import { Trades } from './pages/Trades';
import { Settings } from './pages/Settings';
import { Profile } from './pages/Profile';

type Tab = 'dashboard' | 'trades' | 'settings' | 'profile';

export function App() {
  const [tab, setTab] = useState<Tab>('dashboard');
  return (
    <div>
      <Navbar tab={tab} setTab={setTab} />
      {tab === 'dashboard' && <Dashboard />}
      {tab === 'trades' && <Trades />}
      {tab === 'settings' && <Settings />}
      {tab === 'profile' && <Profile />}
    </div>
  );
}
```

`fixtures/vite-tab-state-app-factory/src/components/Navbar.tsx`:

```tsx
type Props = { tab: string; setTab: (t: string) => void };

export function Navbar({ tab, setTab }: Props) {
  const item = (id: string, label: string) => (
    <button onClick={() => setTab(id)} aria-pressed={tab === id}>{label}</button>
  );
  return (
    <nav>
      {item('dashboard', 'Dashboard')}
      {item('trades', 'Trades')}
      {item('settings', 'Settings')}
      {item('profile', 'Profile')}
    </nav>
  );
}
```

`fixtures/vite-tab-state-app-factory/src/pages/{Dashboard,Trades,Settings,Profile}.tsx`: minimal stubs (one `<div>${name}</div>` each).

`fixtures/vite-tab-state-app-factory/MUST_DISCOVER.json`:

```json
{
  "navigations": [
    { "method": "state-setter", "target": "dashboard", "kind": "state", "stateVar": "setTab", "label": "Dashboard", "confidence": "high" },
    { "method": "state-setter", "target": "trades", "kind": "state", "stateVar": "setTab", "label": "Trades", "confidence": "high" },
    { "method": "state-setter", "target": "settings", "kind": "state", "stateVar": "setTab", "label": "Settings", "confidence": "high" },
    { "method": "state-setter", "target": "profile", "kind": "state", "stateVar": "setTab", "label": "Profile", "confidence": "high" }
  ]
}
```

Add an integration block in `src/extract/extract.test.ts`:

```ts
describe('vite-tab-state-app-factory navigation extraction', () => {
  it('resolves factory-pattern Navbar: 4 navigations from Navbar.tsx', async () => {
    const root = resolve(FIXTURES, 'vite-tab-state-app-factory');
    const { navigations } = await extractNavigationsForStack('vite', root);
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
});
```

### 6.4 New fixture: `fixtures/vite-tab-state-app-array-map`

Mirrors the TanStack idiom. Same boilerplate. Key file:

`fixtures/vite-tab-state-app-array-map/src/App.tsx`:

```tsx
import { useState } from 'react';

type Tab = 'overview' | 'orders' | 'inventory' | 'reports';

const TABS: Array<{ id: Tab; label: string; testId: string }> = [
  { id: 'overview', label: 'Overview', testId: 'tab-overview' },
  { id: 'orders', label: 'Orders', testId: 'tab-orders' },
  { id: 'inventory', label: 'Inventory', testId: 'tab-inventory' },
  { id: 'reports', label: 'Reports', testId: 'tab-reports' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <div>
      <nav>
        {TABS.map(({ id, label, testId }) => (
          <button key={id} data-testid={testId} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>
      <div>active: {tab}</div>
    </div>
  );
}
```

`MUST_DISCOVER.json`:

```json
{
  "navigations": [
    { "method": "state-setter", "target": "overview", "kind": "state", "stateVar": "tab", "label": "Overview", "confidence": "high", "triggerSelectorHint.testId": "tab-overview" },
    { "method": "state-setter", "target": "orders", "kind": "state", "stateVar": "tab", "label": "Orders", "confidence": "high", "triggerSelectorHint.testId": "tab-orders" },
    { "method": "state-setter", "target": "inventory", "kind": "state", "stateVar": "tab", "label": "Inventory", "confidence": "high", "triggerSelectorHint.testId": "tab-inventory" },
    { "method": "state-setter", "target": "reports", "kind": "state", "stateVar": "tab", "label": "Reports", "confidence": "high", "triggerSelectorHint.testId": "tab-reports" }
  ]
}
```

Integration test parallel to §6.3.

### 6.5 Live TraiderJo smoke (manual, not CI)

`scripts/smoke-traiderjo-closure-nav.sh` — bash:

1. Invoke a small Node script that calls `extractViteNavigations('/tmp/TraiderJo')`.
2. Assert that `navigations` includes entries with each of the seven targets: `dashboard, trades, plan, import, apr, profile, settings`.
3. Assert that each has `kind: 'state'`, `method: 'state-setter'`, `stateVar: 'setTab'`, `confidence: 'high'`, and a non-empty `triggerSelectorHint.text`.
4. Assert that no `NavigationSkip` with `reason: 'dynamic_target'` references `Navbar.tsx` line 9.
5. Print a one-line summary: `OK: TraiderJo Navbar resolved (7 navigations, 0 skips)`.

This is a **manual gate**, not a CI test. The implementer runs it before merging; the maintainer runs it during review.

---

## 7. Acceptance criteria

The PR is complete when ALL of the following hold:

1. All new test cases in §6.1.1–§6.1.5 pass (estimated ≥ 25 tests).
2. The `vite-tab-state-app` fixture's existing 4 navigations remain detected; existing test in `src/extract/extract.test.ts` passes without modification.
3. The new `vite-tab-state-app-factory` fixture detects 4 Navbar navigations per §6.3.
4. The new `vite-tab-state-app-array-map` fixture detects 4 navigations per §6.4.
5. `npm run typecheck` passes from `/root/SurfaceMCP` with zero errors.
6. `npm run lint` passes with zero warnings.
7. `npm run test` passes (full suite).
8. `npm run build` (if present) succeeds.
9. No `as any` / `: any` introduced.
10. No function in `navigations.ts` or the new `navigations-closure.ts` exceeds 40 lines.
11. `navigations.ts` stays under 750 lines after the closure-resolver split.
12. `navigations-closure.ts` stays under 300 lines.
13. The TraiderJo manual smoke (§6.5) passes: `surface_list_navigations` returns ≥ 7 new top-level navigations from `Navbar.tsx` with `confidence: 'high'`.
14. No existing test in `src/extract/vite/navigations.test.ts` is modified other than additions.
15. No existing fixture file is modified.
16. No file outside the listed paths in §10 is touched.
17. The `NavigationSkip['reason']` union has the three new values added; downstream consumers that exhaustively match (none in the codebase today) are unaffected because the spec adds, never removes.
18. The `dynamic_target` skip count for fixture inputs that previously emitted them is unchanged (no regression in skip behavior for unsupported patterns).

---

## 8. Risks

| Risk | Mitigation |
|------|-----------|
| Resolver overreach: a same-named identifier in a different scope is mis-resolved as a parameter | The resolver walks up from the **specific** Identifier node and checks `parameters[].getName() === arg.getText()`. It does NOT do a string-table search. A homonym in a different scope is invisible to the upward walk. |
| Cross-file factory: TraiderJo's `Navbar.tsx` declares `setTab` as a prop; Pass D requires same-file `useState` | Spec §3.8 adds prop-setter recognition. Bounded to single-file analysis; cross-file context-providers remain out of scope. |
| Performance regression on large files: walking every CallExpression for every closure-resolution attempt is O(N²) | The resolver runs **only** on Pass C/D skips, which today are rare. For TraiderJo's `Navbar.tsx`: 7 closure-resolution attempts × ~50 CallExpressions in file = trivial. The implementer should cache `sf.getDescendantsOfKind(SyntaxKind.CallExpression)` per source file at the top of each pass; this is a 4-line change. |
| Resolver fails on a pattern we haven't enumerated | Resolver returns `null` → caller falls through to the existing `dynamic_target` skip. **Strictly additive** — every input that emitted a skip yesterday emits the same skip today, plus or minus a more specific reason for the new categories (`runtime_iterable`, `runtime_index`, `iterable_overflow`). |
| The `roleGated` field for `tabs.filter(t => isAdmin || ...)` is requested by the user but excluded from v1 | Documented in §1.4 (out of scope) and §10 (open question). For v1, conditionally-filtered arrays emit ALL elements as navigations. The crawler may attempt an admin-tab click and harmlessly fail. Future spec adds annotation. |
| The `prop-setter` heuristic mis-identifies a non-navigation prop (e.g. `onSubmit: (data: SomeType) => void`) | Heuristic is narrow: setter name MUST start with `set` (case-insensitive), parameter type MUST be `string` or a string-literal union. `onSubmit`, `onChange(value: ChangeEvent)`, etc., do not match. False positive rate is bounded; false positives at most emit `confidence: 'medium'` navigations the crawler ignores. |
| Pattern-E1 mixed-callsites returns `dynamic_target` for the entire factory, losing the literal subset | This is **intentional** per §3.3 step 5. Emitting only the literal subset would silently miss a clickable target — a security tool's worst failure mode. The user can refactor to use a fully-literal factory if they need static analysis to succeed. |
| ts-morph's `getKind()` distinguishes `ArrayBindingPattern` and `ObjectBindingPattern` correctly, but `BindingElement` traversal is verbose; cost is implementer-time, not runtime | The implementer uses `param.getNameNode().getKind()` and switches on it. Test §6.1.2 `map/destructure-rename` exercises the rename path explicitly. |
| The resolver runs on every closure-bound argument, including those in non-navigation contexts (e.g. `setVisible(true)` with a captured boolean) | The resolver only runs from Pass C/D, which already filter to setters whose name matches `^set.+/i`. Pass C only runs for `useNavigate()`-bound bindings. The blast radius is narrow. |
| BugHunter's downstream consumer assumes navigations have a unique (sourceFile, sourceLine) — closure-resolution emits N entries with the same line | Existing dedup at `emitted: Set<string>` (Pass D line 506) keys on `(sourceFile, sourceLine, target)` — three-tuple, target distinguishes. No collision. Verified in test `factory/inline: 4 callsites`. |
| Concurrent merge with `spec/nav-hint-quality` introduces a conflict | The hint-quality work touches `extractTriggerInfo` and adds post-passes. The closure-resolver work touches Pass C/D's skip branches and adds a new helper module. Mechanical conflict surface is in the `triggerSelectorHint` object construction — both branches add fields. The merge should land hint-quality first, then rebase closure-nav-resolve. The implementer is the same `@coder`; coordinate via PR ordering. |
| `forEach` support invites users to write `tabs.forEach(t => navItems.push(...))` style; v1 doesn't support that | v1 accepts `.forEach` with the same shape as `.map` — destructured parameter, body returns/uses JSX. If the body imperatively pushes to a different array, the resolver still extracts based on the destructured parameter; the imperative wiring is irrelevant to navigation discovery. Edge case is documented but no extra logic needed. |

---

## 9. Negative requirements

- Do **not** add `roleGated`, `conditional`, or any new `Navigation` field.
- Do **not** modify `extractViteNavigations`'s public signature.
- Do **not** modify any existing test file beyond appending new `describe` blocks.
- Do **not** modify any existing fixture file.
- Do **not** introduce new dependencies — ts-morph is already a dep.
- Do **not** introduce `as any` / `: any` to satisfy ts-morph.
- Do **not** chase identifier resolution beyond 2 binding hops.
- Do **not** chase identifier resolution across file boundaries.
- Do **not** emit a navigation whose target is not statically resolved to a string literal.
- Do **not** emit a navigation when the factory has even one non-literal callsite (mixed-callsite emits `dynamic_target` for the factory).
- Do **not** invent a new pass. Existing Passes A/B/C/D plus a new helper module are sufficient.
- Do **not** modify `src/extract/navigations/index.ts`, `src/server/navigation-catalog.ts`, `src/server/http.ts`, or any file outside the §10 list.
- Do **not** raise the file-size limits — `navigations.ts` stays under 750 lines (after a split into `navigations-closure.ts`).
- Do **not** write an `.md` summary or report file as part of the PR. The spec **is** the documentation.

---

## 10. Files to touch

**Modify:**
- `src/extract/vite/navigations.ts` — Pass C and Pass D skip-branch additions; trigger-walking reuse. ~30 lines added per pass; remainder of new logic moves to the new module.
- `src/types.ts` — three new `NavigationSkip['reason']` values per §4.1.
- `src/extract/extract.test.ts` — two new `describe` blocks for the new fixtures (§6.3, §6.4).
- `src/extract/vite/navigations.test.ts` — five new `describe` blocks per §6.1.

**Create:**
- `src/extract/vite/navigations-closure.ts` — closure-arg resolver module per §3.5–§3.8. ≤ 300 lines.
- `fixtures/vite-tab-state-app-factory/{package.json, index.html, vite.config.ts, tsconfig.json, surfacemcp.config.json, MUST_DISCOVER.json, src/main.tsx, src/App.tsx, src/components/Navbar.tsx, src/pages/Dashboard.tsx, src/pages/Trades.tsx, src/pages/Settings.tsx, src/pages/Profile.tsx}` — Pattern E1 fixture per §6.3.
- `fixtures/vite-tab-state-app-array-map/{package.json, index.html, vite.config.ts, tsconfig.json, surfacemcp.config.json, MUST_DISCOVER.json, src/main.tsx, src/App.tsx}` — Pattern E2 fixture per §6.4.
- `scripts/smoke-traiderjo-closure-nav.sh` — manual smoke per §6.5. (Not in CI; runnable by hand.)

**Do NOT touch:**
- `src/extract/vite/util.ts` — no changes needed.
- `src/extract/navigations/index.ts` — registry stays as-is.
- `src/server/navigation-catalog.ts` — catalog stays as-is.
- `src/server/http.ts` — tool registration stays as-is.
- Any fixture file in `fixtures/vite-tab-state-app/` — preserved verbatim.
- `BugHunter/**` — no cross-repo edits.
- `README.md` — capability is implicit (catalog grows); the spec serves as documentation.

---

## 11. Task breakdown

Each task is independently completable and verifiable. Total estimated effort: ~1.5 senior-engineer-days.

### Task 1 — Type additions

**Assignee:** `@coder`
**Depends on:** none
**Files to modify:** `src/types.ts`
**Files to create:** none
**Test:** `npm run typecheck`
**Done when:** `NavigationSkip['reason']` includes `runtime_iterable`, `runtime_index`, `iterable_overflow`.

### Task 2 — Closure-resolver module skeleton

**Assignee:** `@coder`
**Depends on:** Task 1
**Files to modify:** none
**Files to create:** `src/extract/vite/navigations-closure.ts`
**Test:** `npm run typecheck`
**Done when:** the module exports `resolveClosureArg`, `ResolvedClosureArg`, with stubbed implementations that always return `{ kind: 'skip', reason: 'dynamic_target', detail: 'not implemented' }`. Wired to imports in `navigations.ts`. All existing tests still pass.

### Task 3 — Pattern E1 (factory call) implementation

**Assignee:** `@coder`
**Depends on:** Task 2
**Files to modify:** `src/extract/vite/navigations-closure.ts`, `src/extract/vite/navigations.ts` (Pass D wire-up)
**Files to create:** none
**Test:** `npm test -- navigations.test.ts -t "factory"`
**Done when:** all tests in §6.1.1 pass, including mixed-callsite skip behavior.

### Task 4 — Pattern E2 (array map) implementation

**Assignee:** `@coder`
**Depends on:** Task 2 (parallel-able with Task 3 if desired)
**Files to modify:** `src/extract/vite/navigations-closure.ts`, `src/extract/vite/navigations.ts`
**Files to create:** none
**Test:** `npm test -- navigations.test.ts -t "map/"`
**Done when:** all tests in §6.1.2 pass, including 1-hop, 2-hop, runtime-iterable, spread, missing-field, flatMap, forEach, empty-array.

### Task 5 — Bounded-resolver edge cases

**Assignee:** `@coder`
**Depends on:** Tasks 3, 4
**Files to modify:** `src/extract/vite/navigations-closure.ts`, `src/extract/vite/navigations.ts`
**Files to create:** none
**Test:** `npm test -- navigations.test.ts -t "iterable_overflow|runtime_index|template-literal|ternary"`
**Done when:** all tests in §6.1.3 pass.

### Task 6 — Prop-setter recognition

**Assignee:** `@coder`
**Depends on:** Task 3
**Files to modify:** `src/extract/vite/navigations.ts` (Pass D's `stateVars` discovery)
**Files to create:** none
**Test:** `npm test -- navigations.test.ts -t "prop-setter"`
**Done when:** all tests in §6.1.4 pass; `factory/inline` test still passes (regression gate).

### Task 7 — Pass C parity

**Assignee:** `@coder`
**Depends on:** Task 3 (Task 4 is also useful but Pass C tests focus on factory pattern)
**Files to modify:** `src/extract/vite/navigations.ts` (Pass C wire-up)
**Files to create:** none
**Test:** `npm test -- navigations.test.ts -t "useNavigate"`
**Done when:** all tests in §6.1.5 pass.

### Task 8 — `vite-tab-state-app-factory` fixture

**Assignee:** `@coder`
**Depends on:** Tasks 3, 6
**Files to create:** all files under `fixtures/vite-tab-state-app-factory/` per §6.3
**Files to modify:** `src/extract/extract.test.ts` (add factory `describe` block)
**Test:** `npm test -- extract.test.ts -t "factory"`
**Done when:** integration test verifies 4 navigations from `Navbar.tsx`.

### Task 9 — `vite-tab-state-app-array-map` fixture

**Assignee:** `@coder`
**Depends on:** Task 4
**Files to create:** all files under `fixtures/vite-tab-state-app-array-map/` per §6.4
**Files to modify:** `src/extract/extract.test.ts` (add array-map `describe` block)
**Test:** `npm test -- extract.test.ts -t "array-map"`
**Done when:** integration test verifies 4 navigations.

### Task 10 — Live TraiderJo smoke

**Assignee:** `@coder` (or `@architect` for verification)
**Depends on:** Tasks 1–9
**Files to create:** `scripts/smoke-traiderjo-closure-nav.sh`
**Test:** Manual run; assertions printed to stdout.
**Done when:** running the script against `/tmp/TraiderJo` prints `OK: TraiderJo Navbar resolved (7 navigations, 0 skips)`.

### Task 11 — Final verification

**Assignee:** `@coder`
**Depends on:** Tasks 1–10
**Files:** none
**Test:** `npm run typecheck && npm run lint && npm run test`
**Done when:** full verification suite passes; no regression in existing tests; PR ready for review.

---

## 12. Open questions

- **OQ-1.** Should the resolver handle the captured-outer-scope case (`const id = 'a'; setTab(id)`)? **Decision (v1):** no. `resolveBindingToLiteral` already handles this for E2's iteree, but invoking it on every captured Identifier expands the resolver's blast radius. TraiderJo doesn't need it, and false-positive risk on uninstrumented codepaths is real. Land in v0.3 if a real surface needs it.
- **OQ-2.** Should `roleGated: true` annotate conditional-filtered tabs? **Decision (v1):** no. Out of scope per §1.4. If a follow-up spec adds it, the new field is additive on `Navigation`.
- **OQ-3.** Should `for (const t of arr) { … }` for-of loops be supported? **Decision (v1):** no. The dominant SPA idiom is `.map` and (rarely) `.forEach`; for-of with JSX-building is uncommon. If a real surface needs it, the resolver gains one more pattern (E3) in a follow-up.
- **OQ-4.** Should template-literal interpolation `setTab(\`tab-${id}\`)` be resolved when all interpolated parts are statically determined? **Decision (v1):** no. The set of resolved targets becomes the cross-product of interpolated values, which is harder to reason about and exposes a subtle correctness risk (target string-shape may not match what `useState`'s union actually accepts). Future spec.
- **OQ-5.** Should the prop-setter heuristic (§3.8) recognize ANY function-typed prop, not just those starting with `set`? **Decision (v1):** no. The `^set.+/i` filter matches the React convention closely; broader matching invites false-positives on `onChange`, `onSubmit`, etc., where the parameter shape is rarely a simple string. The implementer can extend the filter in a follow-up if real surfaces miss legitimate setters.
- **OQ-6.** When closure-resolved navigations duplicate literal-arg navigations (e.g. `setTab('a')` in App.tsx AND `setTab(id)` in Navbar.tsx with `id='a'`), should we dedup? **Decision (v1):** no — they live in different files and the consumer sees each provenance separately, which helps debugging. Cross-file dedup is the job of `SPEC_NAV_HINT_QUALITY.md`'s `duplicateCount` field. The two specs interact correctly without explicit coordination.
- **OQ-7.** Should the resolver support `Object.entries(map).map(([key, val]) => ...)` patterns? **Decision (v1):** no. Object-entries is rarely used for tab rendering; if a real surface needs it, gain a third pattern E3.
- **OQ-8.** Should `iterable_overflow` cap be configurable per-project? **Decision (v1):** no. 32 is the same as `MAX_UNION_MEMBERS`; the user can refactor or split a >32-tab UI. Configurability adds complexity for vanishing benefit.
- **OQ-9.** What if a fixture file is found to break under the new resolver (e.g. existing fixture's setter inadvertently matches a closure pattern)? **Decision (v1):** the resolver runs ONLY on the existing `dynamic_target` skip branches. Existing literal-arg tests fast-path before reaching the resolver. Verified by §7 acceptance criterion #2. If a test fails, the resolver has overreached its bounded surface — fix the resolver, not the fixture.

Out-of-scope (deferred):

- Cross-file factory recursion.
- Closure-capture from outer scope without parameter binding.
- `<NavItem id="dashboard" />` JSX-defined sub-component recursion.
- Switch-case-with-string-cases inside setter wrappers.
- For-of / for-in / classic for loops.
- Object.entries / Object.keys / Map.forEach.
- Template-literal interpolation.
- Ternary / conditional-expression resolution.
- Cross-file context-provider setters.

---

## 13. Estimated effort

≈ 1.5 senior engineer-days for an experienced TypeScript/AST author. Coder-implementable end-to-end; no architectural decisions left unresolved. Highest-risk task is Task 6 (prop-setter recognition) — budget half a day, including the regression test on the existing `vite-tab-state-app` fixture (which must continue to detect 4 literal-arg navigations from `App.tsx`).

The vision-baseline killer-demo gate (≥ 7 unique pages on TraiderJo) becomes achievable after this spec lands, because the BugHunter crawler now sees the seven top-level tabs in `surface_list_navigations` with `confidence: 'high'`. Crawler-side work (clicking, observing state mutation, recording new pages) is **already shipped** in the v0.5/v0.6 BugHunter codebase — no downstream changes required for the gate to lift.

---

End of spec.
