# SPEC: E2E Reliability — fixture fixes for BugHunter cross-repo harness

**Status:** ready for implementation
**Owner:** @architect
**Implementer:** @coder (fixture changes only; no `src/` changes)
**Counterpart spec:** `BugHunter/SPEC_E2E_RELIABILITY.md` (full root-cause analysis lives there)
**Branch:** `spec/e2e-reliability`

---

## Summary

This SurfaceMCP-side spec covers the three fixture changes needed to un-skip three tests in the BugHunter cross-repo e2e harness. The full diagnostic write-up — including the analysis of BugHunter-side code paths that motivate each fixture — is in `BugHunter/SPEC_E2E_RELIABILITY.md`. This file is the SurfaceMCP-bounded checklist.

**Three fixture changes:**

1. New file `fixtures/nextjs-app/app/api/always-404/route.ts` — Zod-validated route that always 404s. Used by BugHunter to produce two clusters with the same toolId and exercise `relatedClusterIds` linking.
2. Edit `fixtures/nextjs-app/app/admin/users/page.tsx` — remove file-level `'use server'` directive that violates Next.js 15 Server Actions module rules.
3. New `fixtures/nextjs-app/.gitignore`, plus track existing local files (`tsconfig.json`, `next-env.d.ts`, `package-lock.json`, `surfacemcp.config.json`) so a clean working tree results after running the harness.

No `src/` code changes. No test changes (the SurfaceMCP-side e2e at `tests-e2e/` does not run BugHunter; this spec only modifies fixture files which the BugHunter harness consumes).

---

## 1. Fixture additions

### 1.1 `fixtures/nextjs-app/app/api/always-404/route.ts` (new)

Exact content:

```ts
import { z } from 'zod';
import { NextRequest, NextResponse } from 'next/server';

// Zod-validated POST endpoint that always returns 404, regardless of body.
// Exists so SurfaceMCP labels it 'introspected' (driving BugHunter's plan
// to generate four palette tests against it). All four tests hit a 404,
// producing two distinct clusters that share a toolId — exercising the
// relatedClusterIds annotation in BugHunter's cluster phase.
const schema = z.object({
  payload: z.string().min(1).max(50),
  count: z.number().int().min(0).max(100),
});

export async function POST(req: NextRequest) {
  const body = await req.json();
  schema.parse(body);
  return NextResponse.json({ error: 'always 404 by design' }, { status: 404 });
}
```

**Why these constraints:**
- Zod schema present → SurfaceMCP's `extract/nextjs/schemas.ts` will infer an `introspected` confidence (verified by `src/extract/extract.test.ts:32-40`).
- Schema is minimal but valid — `payload` is a small bounded string, `count` an integer in a small range. BugHunter's mutation strategy generates `null`/`happy`/`edge`/`out_of_bounds` palettes; all parse-fail or return 404, none cause a 500.
- `schema.parse(body)` runs before the 404 so even a valid happy body still gets a 404 response (palette `happy` produces `surface_call_failed` from BugHunter; non-happy palettes produce `404_for_linked_route`).

**DO NOT:**
- Change `app/api/conditional-404/route.ts` — it remains a useful manual-validation `unknown`-confidence fixture for other tests.
- Add a UI page that links to `/api/always-404` — BugHunter's UI walker doesn't capture network requests, so it can't fire `404_for_linked_route` from a UI navigate. The API path is sufficient.

### 1.2 `fixtures/nextjs-app/app/admin/users/page.tsx` (edit)

**Current content** (line 1 is the bug):
```tsx
'use server';

async function createUser(formData: FormData) {
  'use server';
  const name = formData.get('name');
  const email = formData.get('email');
  console.log({ name, email });
}

export default function AdminUsersPage() {
  return (
    <form action={createUser}>
      <input name="name" type="text" />
      <input name="email" type="email" />
      <button type="submit">Create</button>
    </form>
  );
}
```

**Replace with** (drop the file-level `'use server';` on line 1; keep the function-level one inside `createUser`):

```tsx
async function createUser(formData: FormData) {
  'use server';
  const name = formData.get('name');
  const email = formData.get('email');
  console.log({ name, email });
}

export default function AdminUsersPage() {
  return (
    <form action={createUser}>
      <input name="name" type="text" />
      <input name="email" type="email" />
      <button type="submit">Create</button>
    </form>
  );
}
```

**Why:** Next.js 15 requires every export from a `'use server'` module to be an async function. `AdminUsersPage` is a synchronous React component. With the file-level directive, Next.js dev raises `ModuleBuildError: Server Actions must be async functions.` and serves a 500 error page for *every* request once the file is compiled. Verified locally — removing line 1 restores normal behaviour.

The function-level `'use server';` inside `createUser` is the canonical Next.js 15 form for declaring a single Server Action. It does not constrain other exports.

**DO NOT:**
- Convert `AdminUsersPage` to async to keep the file-level directive — that would change the React semantics (suspense behaviour) and is unnecessary.
- Move `createUser` to a separate file — the existing structure exists to test SurfaceMCP's Server Actions extraction (`src/extract/nextjs/server-actions.ts`).

### 1.3 `fixtures/nextjs-app/.gitignore` (new)

Exact content:

```
# Build / runtime artefacts
.next/
node_modules/

# BugHunter run artefacts
.bughunter/

# pm2 ecosystem (user-specific paths)
ecosystem.config.cjs

# Local env overrides
.env
.env.local
.env.example

# OS / editor noise
.DS_Store
*.log
```

**Rationale (per file):**
- `.next/` — Webpack build cache. Always regenerated.
- `node_modules/` — also covered by repo-root `.gitignore` but explicit here in case the fixture is consumed standalone.
- `.bughunter/` — BugHunter run artefacts (`runs/<id>/screenshots/*.png`, `dom/*.html`, `bugs.jsonl`, etc.). Up to 4 GB per run by default config. Never tracked.
- `ecosystem.config.cjs` — pm2 ecosystem file generated by `surfacemcp init` with absolute paths (`/root/SurfaceMCP/dist/cli/main.js`). User-specific.
- `.env`, `.env.local`, `.env.example` — environment-scoped. The repo-root `surfacemcp.config.example.json` is the canonical example. Fixture-scoped `.env.example` is generated noise.
- `.DS_Store`, `*.log` — standard OS / log noise.

### 1.4 Files to track (currently untracked, working-tree only)

The following exist locally but are not in git. Add them all in one commit:

- `fixtures/nextjs-app/tsconfig.json` — required by Next.js 15 dev. Without it, Next.js auto-installs TypeScript on first `npm run dev` (8-10 s delay), which causes the BugHunter e2e harness to time out during `waitForUrl`.
- `fixtures/nextjs-app/next-env.d.ts` — auto-generated TS reference. Convention is to track it.
- `fixtures/nextjs-app/package-lock.json` — pins fixture deps for deterministic e2e runs.
- `fixtures/nextjs-app/surfacemcp.config.json` — working baseline config. The BugHunter harness overwrites it in its temp copy via `writeSurfaceMcpConfig`; the source baseline stays untouched and lets a developer run the fixture standalone.

**Negative requirement:** do NOT track `ecosystem.config.cjs` or `.env.example` from the working tree. Both are generated and contain user-specific paths.

---

## 2. Boundaries

**In scope:**
- Five new tracked files, one edited file (`page.tsx`).
- No `src/` changes.
- No test changes — SurfaceMCP's own test suite (`vitest run`, `vitest run --config vitest.e2e.config.ts`) covers SurfaceMCP-internal behaviour and does not exercise BugHunter.

**Out of scope:**
- Changing `conditional-404/route.ts` — it remains useful for `unknown`-confidence regression coverage.
- Adding new UI pages or modifying existing UI fixture pages other than `app/admin/users/page.tsx`.
- Server Actions extraction logic (`src/extract/nextjs/server-actions.ts`) — the existing extractor already handles function-level `'use server'` correctly.
- The repo-root `.gitignore` — already has `.env`, `.env.local`, `node_modules/`, `dist/`, `data/`, `*.log`, `.surfacemcp/`. Fixture-scoped additions live in `fixtures/nextjs-app/.gitignore`.

---

## 3. Acceptance criteria

After this spec lands and is checked out, with the BugHunter-side spec also implemented:

```bash
cd /root/SurfaceMCP
git status                                # clean working tree
npx tsc --noEmit                          # zero errors
npm run test                              # all green
```

In parallel, run the BugHunter e2e harness against this branch (the harness reads from `/root/SurfaceMCP/fixtures/nextjs-app/`):

```bash
cd /root/BugHunter
NODE_ENV=development npm --workspace packages/cli run test:e2e
```

Expected stdout:
```
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

with **no** `[skip]` or `[info] ... skipped` lines.

Per-fixture-change acceptance:

- **§1.1** `app/api/always-404/route.ts` exists, exports a `POST` handler with a Zod schema. SurfaceMCP `surface_list_tools` returns it with `inputSchemaConfidence: 'introspected'`. POST with any valid body returns 404.
- **§1.2** `app/admin/users/page.tsx` no longer has `'use server';` on line 1. Next.js dev compiles `/admin/users` without errors after a fresh `npm run dev`. Subsequent requests to `/api/journal-entries` continue to return 201 for valid bodies.
- **§1.3 / §1.4** `git status` in `SurfaceMCP/` shows nothing untracked under `fixtures/nextjs-app/` after running the BugHunter e2e harness end-to-end.

---

## 4. Files to touch

| Path | Change kind |
| --- | --- |
| `fixtures/nextjs-app/app/api/always-404/route.ts` | new file |
| `fixtures/nextjs-app/app/admin/users/page.tsx` | edit (drop line 1 `'use server';`) |
| `fixtures/nextjs-app/.gitignore` | new file (content in §1.3) |
| `fixtures/nextjs-app/tsconfig.json` | track existing |
| `fixtures/nextjs-app/next-env.d.ts` | track existing |
| `fixtures/nextjs-app/package-lock.json` | track existing |
| `fixtures/nextjs-app/surfacemcp.config.json` | track existing |

No new directories. No file deletions. No edits to anything outside `fixtures/nextjs-app/`.

---

## 5. Risk and sequencing

All four sub-changes are independent and can land in any order. Lowest-risk order:

1. `.gitignore` + tracked baseline files (§1.3, §1.4) — pure repo hygiene.
2. `app/admin/users/page.tsx` edit (§1.2) — single-line fixture fix.
3. `app/api/always-404/route.ts` new file (§1.1) — additive, doesn't break anything.

All three should land in a single commit on `spec/e2e-reliability`.

**Coordination with BugHunter:** the BugHunter-side changes (adapter `withTab` refactor, e2e harness assertion changes) consume the fixtures defined here. Land this SurfaceMCP branch first; then the BugHunter branch can merge against the updated fixture state.

---

## 6. Open questions

None. All decisions above are determined and verified with reproductions in `/tmp/jsonfix-test/`.
