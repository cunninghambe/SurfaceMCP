# SurfaceMCP — Probe Tightening + Discovery Cleanup Spec

Source: BugHunter integration smoke against `/root/spoonworks` (2026-04-26). The smoke surfaced two SurfaceMCP-side defects that BugHunter's escape-hatches mitigate but do not fix at the source.

This spec covers the SurfaceMCP-side work that complements `/root/BugHunter/SPEC_SMOKE_FIXES.md` § 3.X (probe tightening) and § 3.Y (external-integrations grep). It is small, self-contained, and lands on this branch (`spec/probe-and-detection-tightening`) before any code is written.

---

## 1. Problem statement

Two related issues:

1. **`surface_probe` cannot detect required fields for routes that use manual `if (!body.x) throw …` validation.** The current probe path (`src/server/http.ts:51-88` `probeSchema`) issues an empty-body POST and tries to recover a schema from the *response* body via `recoverFromZodError` / `recoverFromPydanticError` / `recoverFromFastApiError` / `recoverFromDrfError`. Manual validation throws plain `Error("memo is required")` and the framework returns a generic 500 — none of the recoverers match. The tool stays at `inputSchemaConfidence: 'unknown'` and BugHunter's `happy`-palette call sends an empty body, tripping a 400/500 cluster as a smoke artifact.

2. **`detectExternalIntegrations` (in `src/classify/grep-init.ts:39-61`) over-matches on legal copy and product strings inside React page components.** Files like `app/policies/privacy/page.tsx` (privacy policy mentioning "Stripe" in body text) and `app/products/[slug]/page.tsx` (product names that happen to contain a vendor brand string) get added to `_suggestedExternalIntegrations`, polluting the noise floor and confusing users about which files actually call Stripe.

---

## 2. Existing code map

### Files you MUST read before changing anything

- `/root/SurfaceMCP/src/types.ts:29` — `InputSchemaConfidence` union; we add a fourth variant.
- `/root/SurfaceMCP/src/server/http.ts:51-88` — `probeSchema` runtime path (post-call response recovery).
- `/root/SurfaceMCP/src/extract/nextjs/schemas.ts:17-36` — `extractZodSchema` static-analysis path; the new manual-validation analyser lives next to it (sibling export).
- `/root/SurfaceMCP/src/extract/nextjs/routes.ts:93-114` — the call site that decides initial `inputSchemaConfidence` per route. The static analyser must run inside this branch when `extractZodSchema` returns `unknown`.
- `/root/SurfaceMCP/src/classify/grep-init.ts:23-37` — `walkDir` and the per-file content scan. The fix lives here.
- `/root/SurfaceMCP/src/server/tools-meta.ts` — passes `inputSchemaConfidence` through; ensure no narrow casts.

### Patterns to follow

- Use `ts-morph` (already a dependency, used in `extract/nextjs/schemas.ts`) for AST work — not regex over source text. The probe analyser must be AST-based.
- The grep-init module currently reads each file with `readFileSync` and runs regex over the full text. The fix preserves that I/O shape; only the matcher logic changes.

### DO NOT

- Do not change the `surface_probe` MCP tool surface (input/output JSON shape unchanged).
- Do not move or rename `recoverFromZodError` / `recoverFromPydanticError` / etc. — the runtime probe path stays.
- Do not add new dependencies. `ts-morph` and the existing zod stack are sufficient.

---

## 3. § A — Add `'partial'` to `InputSchemaConfidence`

### 3.A.1 Decision

Add a fourth variant: `'introspected' | 'inferred' | 'partial' | 'unknown'`.

Semantics:
- `introspected` — full Zod (or framework) schema parsed; high confidence, all required fields known.
- `inferred` — recovered from a runtime error response; high confidence, all required fields known.
- `partial` — recovered from static analysis of manual `if (!body.X)` style guards; **field set is incomplete by definition**, no constraint info, and may include false positives.
- `unknown` — no recovery succeeded.

### 3.A.2 Files to touch

- `src/types.ts:29` — extend the union.
- `src/server/http.ts` — return `'partial'` from the static-analysis path (§ B). Existing runtime-probe path is unchanged.
- `src/server/tools-generated.ts` — confirm no string-narrowing casts that exclude `'partial'` (search and update if any exist).

### 3.A.3 Acceptance

- `npx tsc --noEmit` clean across `src/**` after the union extension.
- The `surface_probe` JSON-RPC return type now permits `confidence: 'partial'`.

---

## 4. § B — Static manual-validation detector

### 4.B.1 Approach

A new exported function `extractManualValidationSchema(sf: SourceFile, methodName: string): SchemaResult` lives in `src/extract/nextjs/schemas.ts`. It:

1. Locates the exported handler function for the given HTTP method (e.g. `export async function POST(req)`).
2. Walks the function body for **body-validation patterns** (definitions § 4.B.2). Each pattern adds field name(s) to a `requiredFields: Set<string>`.
3. If at least one field is found AND the function did not also call `<schema>.parse(body)` (which would have been picked up already by `extractZodSchema`), returns:

   ```ts
   {
     schema: { type: 'object', properties: <each field as { type: 'string' }>, required: [...sortedFields] },
     confidence: 'partial',
   }
   ```
4. If no fields found, returns `{ schema: UNKNOWN_SCHEMA, confidence: 'unknown' }`.

The wiring point in `routes.ts:93-94` becomes:

```ts
const zodResult = await tryImportZodSchema(filePath, zodAlias);
const { schema, confidence } = zodResult.confidence !== 'unknown'
  ? zodResult
  : extractManualValidationSchemaFromFile(filePath); // new export
```

`extractManualValidationSchemaFromFile` is a thin wrapper that loads the source file via `Project.addSourceFileAtPath` (mirroring the fallback path at `schemas.ts:208-214`) and calls `extractManualValidationSchema` per detected method. For mixed-method files, the union of fields is fine — both POST and PUT generally validate the same body — and the analyser is intentionally conservative (false negatives over false positives).

### 4.B.2 Patterns the analyser must recognise

All patterns are AST-matched, not regex. The analyser walks `IfStatement`, `BinaryExpression`, `ThrowStatement`, and `ReturnStatement` nodes inside the handler function.

| Pattern | AST shape | Field extracted |
|---|---|---|
| **Falsy guard then throw/return-error** | `if (!<id>.<prop>) { throw … }` or `if (!body.<prop>) return NextResponse.json({…}, {status: 4XX})` | `<prop>` |
| **Typeof guard then throw/return-error** | `if (typeof <id>.<prop> !== 'string') { throw … }` (or `'number'`, `'boolean'`) | `<prop>`, with corresponding `type` if recoverable |
| **Length guard** | `if (!<id>.<prop> \|\| <id>.<prop>.length === 0) …` | `<prop>` |
| **Destructure-then-check** | `const { a, b } = body; if (!a) throw …; if (!b) throw …` | each `<prop>` whose binding is checked |
| **Zod safeParse without `.parse`** | `const r = schema.safeParse(body); if (!r.success) return …` — already handled by `extractZodSchema`; analyser SKIPS files where this matched | none (defer to existing path) |

The analyser is **conservative**: a single static check on `body.X` is enough to mark `X` required. It does NOT attempt to infer types beyond `string`/`number`/`boolean` when the typeof guard is explicit.

### 4.B.3 What the analyser does NOT do

- Not type inference beyond the three primitives above. All other fields default to `{ type: 'string' }`.
- Not constraint inference (no `minLength`, `maximum`, etc. — those require domain knowledge the analyser does not have).
- Not control-flow analysis. `if (foo) { /* ignore */ }` does not add `foo` as required; only `if (!body.foo)` followed by an early-exit (throw or return-error-response) does.
- Not nested-object analysis. `if (!body.user.id)` only adds `user` (not `user.id`). v0.2 can deepen this.
- Not handler-extracted helper functions. If `validateBody(body)` is a separate function the analyser does not follow the call. Document this as a known limitation.

### 4.B.4 BugHunter-side behaviour for `'partial'`

(Cross-reference: `/root/BugHunter/SPEC_SMOKE_FIXES.md` § 3.X; this is the consumer side and is specced there. Summary: BugHunter treats `'partial'` like `'unknown'` for `apiTestCases` — single happy-path call only — until a `bodyFixtures` entry covers the tool. This is **defensive**: the partial schema may be missing fields that would cause the call to fail, so the safer behaviour is the single-call path that `'unknown'` already takes. The `'partial'` tag is informational; downstream tooling can show "schema partial, consider adding bodyFixtures" hints in `bughunter inspect`.)

### 4.B.5 Files to touch

- `src/types.ts` — § A (the union extension).
- `src/extract/nextjs/schemas.ts` — new exports: `extractManualValidationSchema(sf, methodName)`, `extractManualValidationSchemaFromFile(filePath)`. Must not exceed 200 added LOC across the file.
- `src/extract/nextjs/routes.ts` — wire the fallback at line 93. Single line change in the call chain plus the new branch.
- `src/extract/nextjs/schemas.test.ts` — NEW test file (sibling). Five scenarios from § 4.B.2 plus negatives (Zod present, no validation, helper function — should defer/return unknown).
- `src/extract/extract.test.ts` — add a regression case: a route file with manual validation gets `inputSchemaConfidence: 'partial'` and the right `required` array.

### 4.B.6 Acceptance

- Given a route file:
  ```ts
  export async function POST(req: NextRequest) {
    const body = await req.json();
    if (!body.memo) throw new Error('memo required');
    if (typeof body.amount !== 'number') return NextResponse.json({error:'bad'},{status:400});
    return NextResponse.json({ ok: true });
  }
  ```
  the analyser returns `{ confidence: 'partial', schema: { type: 'object', properties: { memo: { type: 'string' }, amount: { type: 'number' } }, required: ['amount', 'memo'] } }`.

- Given a route with `schema.parse(body)`: analyser is NOT invoked (defer to `extractZodSchema`).
- Given a route with no body access: returns `{ confidence: 'unknown', schema: { type: 'object', additionalProperties: true } }`.
- Given a route that calls a helper `validateBody(body)`: returns `'unknown'` (documented limitation).
- `npx vitest run` green; new tests covered.

---

## 5. § C — `detectExternalIntegrations` precision

### 5.C.1 Approach

Replace the free-text `pattern.test(content)` match in `src/classify/grep-init.ts:51-58` with import/require-statement matching:

1. Skip files that:
   - Live under `app/**/page.tsx`, `app/**/layout.tsx`, `app/**/loading.tsx`, `app/**/error.tsx`, `app/**/not-found.tsx`.
   - Begin with `'use client'` or `"use client"` directive (read first 200 bytes of the file).
   - Live under `pages/**/[!_]*.tsx` excluding `pages/api/**`.
2. For surviving files, parse imports (regex is acceptable here — not full AST):
   - `import … from '<lib>'`
   - `import('<lib>')`
   - `require('<lib>')`
   Match the import target against `EXTERNAL_INTEGRATIONS[i].pattern`.
3. Only add the file to `hits` when an import matches — never on free-text body match.

### 5.C.2 Boundaries

- Same `EXTERNAL_INTEGRATIONS` list at `grep-init.ts:4-16`. No new patterns.
- Same `walkDir` traversal at `grep-init.ts:23-37`. The skip-list is applied **inside** the per-file loop, not in the directory walker — so a `page.tsx` in `app/api/.../page.tsx` (illegal but not impossible) is still skipped.
- Server actions (`'use server'`) are NOT skipped — they legitimately make external calls and must surface.

### 5.C.3 Files to touch

- `src/classify/grep-init.ts:39-61` — replace the matcher loop body. `walkDir` unchanged.
- `src/classify/classify.test.ts` — add three regression cases:
  - File `app/policies/privacy/page.tsx` with body text "We use Stripe" but no Stripe import: NOT matched.
  - File `app/api/orders/route.ts` with `import Stripe from 'stripe'`: matched.
  - File `app/components/CheckoutButton.tsx` with `'use client'` directive at top and `import Stripe from 'stripe'`: NOT matched (client component, not server side-effect surface).

### 5.C.4 Acceptance

- Running `surfacemcp init` against a project containing both server-side Stripe imports and JSX page text mentioning Stripe: only the server file appears in `_suggestedExternalIntegrations`.
- Existing integration tests pass.
- A new test fixture under `fixtures/nextjs-app/app/policies/privacy/page.tsx` (mock content) is **excluded** from suggested integrations.

---

## 6. § D — Default base-URL detection (Next.js port from package.json)

### 6.D.1 Smoke evidence

`bughunter init` writes a config that pins `surfaceMcpUrl = http://127.0.0.1:3102`; `surfacemcp init` sets the SurfaceMCP `surfaces[0].baseUrl = http://localhost:3000` for nextjs by default (`src/cli/init.ts:20`). Spoonworks uses `:3456`, so the smoke required a manual edit.

### 6.D.2 Approach

In `src/cli/init.ts`, before `defaultBaseUrl(stack)` is called, attempt port detection (Next.js only):

1. Read `<projectRoot>/package.json`.
2. Look at `scripts.dev`. Match `next dev (?:\S+\s+)*-p\s+(\d+)` (handle short `-p` only — long `--port` next).
3. Also handle `next dev (?:\S+\s+)*--port\s+(\d+)` and `next dev (?:\S+\s+)*--port=(\d+)` and `PORT=(\d+) next dev` (env-var-prefix form).
4. If a port is found, return `http://localhost:<port>`. Otherwise fall back to `defaultBaseUrl(stack)`.
5. Apply only when `stack === 'nextjs'`. Other stacks unchanged.

### 6.D.3 Boundaries

- Pure precedence change inside `runInit`: the new helper `detectNextjsDevPort(projectRoot): number | undefined` is called in `runInit` *before* `defaultBaseUrl`, and only when `opts.baseUrl` is unset.
- `--baseUrl` CLI flag still wins — it always has.
- No exception leakage: the helper catches any read/parse error and returns `undefined`.

### 6.D.4 Files to touch

- `src/cli/init.ts` — new helper `detectNextjsDevPort` and a single call before `defaultBaseUrl`.
- `src/cli/init.test.ts` — NEW or extended file. Four cases: explicit port via `-p`, via `--port`, via `--port=`, env-var prefix. One negative: `next dev` with no port flag → returns `undefined`.

### 6.D.5 Acceptance

- `surfacemcp init` in a project whose `package.json` has `"dev": "next dev -p 3456"` writes `baseUrl: "http://localhost:3456"`.
- `surfacemcp init` in a project with `"dev": "next dev"` writes `baseUrl: "http://localhost:3000"` (current behaviour preserved).
- `surfacemcp init --baseUrl http://x:1` always writes `http://x:1` regardless of `package.json`.

---

## 7. Risk and sequencing

| Section | Depends on | Risk |
|---|---|---|
| § A (`'partial'` variant) | none | minimal — additive |
| § B (manual-validation analyser) | § A | medium — AST work; conservative posture limits blast |
| § C (grep-init precision) | none | low — drops false positives only |
| § D (port detection) | none | low — fallback preserved |

Land in order A → B → C → D. Each is independently testable and committable.

---

## 8. Definition of done

- `npx tsc --noEmit` clean.
- `npx vitest run` green; new tests cover the four sections.
- Re-run the BugHunter smoke against `/root/spoonworks` after BugHunter consumes the new `'partial'` variant: tools previously stuck at `'unknown'` with manual validation now report `'partial'` with the right field list, and BugHunter falls back to its `bodyFixtures` escape-hatch only for tools that the analyser still can't recover.
- `_suggestedExternalIntegrations` no longer lists page components or layout files.

---

## 9. Open questions

None for v0.1 of this spec. Multi-file helper-function tracing (§ 4.B.3 limitation) is deferred to v0.2 if real projects show the limitation matters.
