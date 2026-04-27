# SurfaceMCP E2E Harness Spec

Sister spec to `/root/BugHunter/SPEC_GAPS_AND_E2E.md`. The BugHunter-side e2e harness (that file § 5, § 6.C) reuses this repo's fixture Next.js app at `fixtures/nextjs-app/`. This spec adds the fixture extensions both harnesses need, plus a SurfaceMCP-side e2e test that asserts SurfaceMCP behaves correctly against the same fixture in isolation.

This spec lives on branch `spec/e2e-harness`, cut from `spec/probe-and-detection-tightening` (commit `0137af9`). It does **not** modify the work landed in `SPEC_PROBE_TIGHTENING.md`; it consumes it (the §§ A–D variants).

---

## 1. Problem statement

Two related needs:

1. **Fixture extensions for cross-repo e2e.** The fixture must exercise: a UI mutation triggered by a button click (for BugHunter Gap 1.B); a 404_for_linked_route producing path that BugHunter can also see as a surface_call_failed (for BugHunter Gap 1.A); and richer per-route assertions in `MUST_DISCOVER.json` so SurfaceMCP regressions are caught early.
2. **SurfaceMCP-side e2e gate.** Today's SurfaceMCP test suite is unit-level: `extract.test.ts`, `probe.test.ts`, `classify.test.ts`, etc. None of them exercises the full `init` → `serve` → `surface_routes_for_page` chain against a real fixture. Adding it provides a regression gate parallel to BugHunter's e2e.

---

## 2. Existing code map (read these before changing anything)

- `/root/SurfaceMCP/fixtures/nextjs-app/` — the fixture root. Already has 8 routes + 2 page components per `MUST_DISCOVER.json` and § 4 below.
- `/root/SurfaceMCP/fixtures/nextjs-app/MUST_DISCOVER.json` — currently lists `routes` + `serverActions` arrays. Will gain per-route assertions.
- `/root/SurfaceMCP/fixtures/nextjs-app/surfacemcp.config.json` — pre-baked SurfaceMCP config for the fixture. Used by `surfacemcp serve`.
- `/root/SurfaceMCP/fixtures/nextjs-app/package.json` — has `next` and `zod` as runtime deps; **no scripts**. The harness needs `dev` and `start`.
- `/root/SurfaceMCP/src/server/http.ts` — entrypoint for `surfacemcp serve`. Reads config, exposes MCP HTTP at `:3102` by default.
- `/root/SurfaceMCP/src/cli/serve.ts` — CLI wrapper for the HTTP server.
- `/root/SurfaceMCP/src/server/tools-naming.test.ts` (lines 22-35) — existing pattern for in-memory fixture-based tests; uses `extractNextjsRoutes` directly without spawning a server. Useful pattern to mirror for unit-level checks; the e2e adds a process-level layer on top.
- `/root/SurfaceMCP/vitest.config.ts` — `include: ['src/**/*.test.ts']`. The e2e test will live under `src/e2e/` to be co-located with source.

### Patterns to follow

- `child_process.spawn` for server orchestration. No new test framework.
- Spawn helpers use absolute paths (`/root/SurfaceMCP/dist/cli/main.js` — built artefact via `npm run build`).
- Default ports come from `getFreePort()` (a small helper using `node:net`).

### DO NOT

- Do not change SurfaceMCP source already covered by `SPEC_PROBE_TIGHTENING.md` § A-D. This spec consumes those variants.
- Do not add new runtime dependencies. The e2e is pure Node + existing deps.
- Do not modify `surfacemcp.config.json` shape. Adding a `port` field for the new fixture variant is fine (it's already supported per § 6.D of the prior spec).

---

## 3. Boundaries

### 3.1 What changes

| File | Change |
|---|---|
| `fixtures/nextjs-app/package.json` | Add `"dev"` and `"start"` scripts. Add `"build"` for `next build`. Stays private. |
| `fixtures/nextjs-app/app/dom-test/page.tsx` | NEW. Client component for BugHunter Gap 1.B coverage. |
| `fixtures/nextjs-app/app/api/missing-route-link/page.tsx` | NEW. Page with anchor pointing at non-existent endpoint — produces a 404_for_linked_route AND a surface_call_failed under BugHunter. |
| `fixtures/nextjs-app/MUST_DISCOVER.json` | EDIT. Add per-route `inputSchemaConfidence` assertions; add a `suggestedExternalIntegrations` block listing what SHOULD and SHOULD NOT match. |
| `src/e2e/surfacemcp-e2e.test.ts` | NEW. SurfaceMCP-side e2e. |
| `src/e2e/helpers/spawn.ts` | NEW. `startSurfaceMcpServer(cwd, port)`, `stopAll()`. |
| `src/e2e/helpers/free-port.ts` | NEW. `getFreePort()`. |
| `src/e2e/helpers/fixture-load.ts` | NEW. Loads the fixture's `surfacemcp.config.json`; helper to overlay a free port. |
| `vitest.config.ts` | EDIT. `exclude: ['src/e2e/**']` so default `npm test` skips e2e. |
| `vitest.e2e.config.ts` | NEW. Mirror config; `include: ['src/e2e/**/*.test.ts']`. |
| `package.json` | EDIT. Add `"test:e2e": "node_modules/.bin/vitest run --config vitest.e2e.config.ts"`. |

### 3.2 What does NOT change

- `src/server/http.ts`, `src/cli/serve.ts`, `src/extract/**`, `src/classify/**`, `src/probe/**`. The e2e exercises these as black boxes.
- The `MUST_DISCOVER.json` JSON shape's existing `routes` and `serverActions` keys. New keys are additions.
- The fixture's existing routes (`/api/users`, `/api/products`, `/api/journal-entries`, `/api/orders`, `/api/users/[id]`). They are kept as-is and gain assertions.
- `surfacemcp.config.json` schema. Adding the `port` field is allowed but optional.

### 3.3 Cross-repo coupling

The BugHunter e2e harness consumes this fixture via filesystem path (`/root/SurfaceMCP/fixtures/nextjs-app/`). Any change to the fixture that breaks BugHunter's e2e fails BugHunter's `npm run test:e2e`. **This is intentional.** The cross-repo gate forces the two repos to stay in sync. If/when monorepoed, the coupling is trivially correct.

---

## 4. Fixture extensions

### 4.A `fixtures/nextjs-app/package.json` — add scripts

```json
{
  "name": "nextjs-app-fixture",
  "private": true,
  "scripts": {
    "dev": "next dev -p ${PORT:-3010}",
    "start": "next start -p ${PORT:-3010}",
    "build": "next build"
  },
  "dependencies": {
    "next": "15.0.0",
    "zod": "3.25.76"
  }
}
```

The `${PORT:-3010}` form is a shell-expansion convention readable by Next.js' devserver via the `PORT` env var (Next reads `PORT` natively). The `-p` flag is preserved for SurfaceMCP § D port detection (which is the `package.json scripts.dev` parser added in `SPEC_PROBE_TIGHTENING.md`).

The fixture's `node_modules` already has `next` per the existing structure. If `npm install` is needed, the harness runs it once (cached on subsequent runs).

### 4.B `fixtures/nextjs-app/app/dom-test/page.tsx` — UI mutation fixture

```tsx
'use client';

import { useState } from 'react';

export default function DomTestPage() {
  const [toggled, setToggled] = useState(false);
  return (
    <main>
      <h1>DOM Test</h1>
      <button
        type="button"
        data-testid="toggle"
        onClick={() => {
          setToggled(t => !t);
          if (typeof document !== 'undefined') {
            document.body.dataset.toggled = toggled ? 'off' : 'on';
          }
        }}
      >
        Toggle
      </button>
      <div data-toggled={toggled ? 'on' : 'off'}>State: {toggled ? 'on' : 'off'}</div>
    </main>
  );
}
```

The button click produces:
- A React state update → DOM re-render → `MutationObserver` fires `attributes` mutation on the `<div>`.
- A direct `document.body.dataset.toggled` update → `MutationObserver` fires `attributes` mutation on `<body>`.

Either is sufficient for `mutationObserverWindowMs > 0`. The `data-testid` selector lets the BugHunter walker find it deterministically.

### 4.C `fixtures/nextjs-app/app/api/missing-route-link/page.tsx` — 404 link source

```tsx
export default function MissingRouteLinkPage() {
  return (
    <main>
      <h1>Missing Route Link</h1>
      <a href="/api/missing-route-target">Click me (target does not exist)</a>
    </main>
  );
}
```

When BugHunter's UI walker visits `/missing-route-link` and follows the anchor, it fetches `/api/missing-route-target` which returns 404 → produces `404_for_linked_route` with `targetPath = '/api/missing-route-target'`.

There is intentionally no corresponding `app/api/missing-route-target/route.ts`. The 404 is the desired behaviour.

For Gap 1.A coverage, BugHunter also needs a `surface_call_failed` cluster on the same toolId as the 404. **Approach:** since `/api/missing-route-target` does not exist, SurfaceMCP cannot expose it as a tool — there's no toolId. The 404 falls back to path-based keying (`path:/api/missing-route-target`). To exercise the toolId-keyed branch, we need an existing route that:

1. Is exposed by SurfaceMCP as a tool (toolId T).
2. Returns 404 when called via the BugHunter API path (toolMap path → 404 from the handler).
3. ALSO produces a `404_for_linked_route` from a UI walker that hit a link to it.

Add a third fixture file:

### 4.D `fixtures/nextjs-app/app/api/conditional-404/route.ts` — deliberate 404 returner

```ts
import { NextRequest, NextResponse } from 'next/server';

// This route deliberately returns 404 when called without an `?ok=1` query param.
// It exists in the route table (so SurfaceMCP discovers it as a tool) but its
// happy-palette body produces a 404 response — exercising surface_call_failed
// AND its sibling 404_for_linked_route from the page that links to it.
export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  if (url.searchParams.get('ok') !== '1') {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
```

And the page that links to it:

### 4.E `fixtures/nextjs-app/app/dual-404-link/page.tsx`

```tsx
export default function Dual404LinkPage() {
  return (
    <main>
      <h1>Dual 404 Source</h1>
      {/* BugHunter UI walker may follow this; the GET-as-link returns 404 (POST-only route). */}
      <a href="/api/conditional-404">Conditional 404</a>
    </main>
  );
}
```

BugHunter then produces:
- `surface_call_failed` for the POST tool on `/api/conditional-404` (404 response from the handler) — has `action.toolId = T`.
- `404_for_linked_route` from the UI walker following the link (GET to a POST-only route → 404) — `targetPath = '/api/conditional-404'`. Under the smoke's API-driven path the targetPath would be the toolId, but here the UI walker provides the actual path.

**Limitation acknowledged:** under Option C of BugHunter's spec, the 404_for_linked_route's `routeKeyOf` returns null (no toolId on the occurrence — UI walker doesn't set one), and falls back to `path:/api/conditional-404`. The surface_call_failed's `routeKeyOf` returns `tool:T`. They don't match. Section § 5.A.7 of BugHunter's spec calls this out as a documented limitation. **For the e2e to actually verify Gap 1.A linking, we need both clusters to share a toolId.** The cleanest way: add a UI test that POSTs (form submit) to `/api/conditional-404` (which then 404s) so the resulting `surface_call_failed` and the resulting `404_for_linked_route` BOTH emit with the same `action.toolId = T` (because BugHunter's network classifier keys 404s on `req.path = tc.action.toolId` when running via the API path — see `BugHunter/packages/cli/src/phases/execute.ts:376`).

So the actual fixture for Gap 1.A linking is **purely API-driven** and does not require a UI page:

- `/api/conditional-404` returns 404 on the happy-palette POST.
- The same toolId is exercised twice in one BugHunter run: once with palette `happy` (returns 404, classifies as `network_4xx_unexpected` — but at the API executor at `execute.ts:373-381` `classifyNetworkRequests` is called with the response status; status 404 produces BOTH `network_4xx_unexpected` AND `404_for_linked_route` per `classify/network.ts:24-46`). Once produces both detection kinds for the same occurrence — different testIds per palette but same toolId.

Result: both clusters carry `occurrences[*].action.toolId = T`. Option C links them. ✓

### 4.F `fixtures/nextjs-app/MUST_DISCOVER.json` — assertion expansion

```json
{
  "routes": [
    "GET /api/users",
    "POST /api/users",
    "GET /api/users/:id",
    "PUT /api/users/:id",
    "DELETE /api/users/:id",
    "GET /api/products",
    "POST /api/journal-entries",
    "POST /api/orders",
    "POST /api/conditional-404"
  ],
  "serverActions": [],
  "perRoute": {
    "POST /api/users": { "inputSchemaConfidence": "introspected" },
    "PUT /api/users/:id": { "inputSchemaConfidence": "introspected" },
    "POST /api/journal-entries": { "inputSchemaConfidence": "partial", "requiredFields": ["amount", "memo"] },
    "POST /api/orders": { "inputSchemaConfidence": "partial", "requiredFields": ["amount"] },
    "POST /api/conditional-404": { "inputSchemaConfidence": "unknown" }
  },
  "suggestedExternalIntegrations": {
    "include": ["app/api/orders/route.ts"],
    "exclude": [
      "app/policies/privacy/page.tsx",
      "app/components/CheckoutButton.tsx"
    ]
  }
}
```

The `perRoute` assertions exercise SurfaceMCP § A (`'partial'` exists), § B (manual-validation analyser produces `requiredFields`), and the existing Zod path. The `suggestedExternalIntegrations.exclude` exercises § C (page-component skip + `'use client'` skip).

The SurfaceMCP-side e2e test reads this file and asserts the live `surfacemcp serve` output matches.

### 4.G `app/dom-test/page.tsx` does not create a route in `MUST_DISCOVER.json`

`MUST_DISCOVER.json` covers API routes (route handlers). `dom-test` is a page component, not an API route; it does not appear in `routes`. The fixture-load helper for the BugHunter e2e knows the page's path to drive the walker.

---

## 5. SurfaceMCP-side e2e test

### 5.1 Layout

```
src/e2e/
  surfacemcp-e2e.test.ts
  helpers/
    spawn.ts
    free-port.ts
    fixture-load.ts
```

### 5.2 `surfacemcp-e2e.test.ts` — required assertions

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startSurfaceMcpServer, stopAll, type SpawnedServer } from './helpers/spawn.js';
import { loadFixtureMustDiscover } from './helpers/fixture-load.js';
import * as path from 'node:path';

describe('SurfaceMCP e2e against fixtures/nextjs-app', () => {
  let server: SpawnedServer;
  const fixtureRoot = path.resolve(__dirname, '../../fixtures/nextjs-app');
  const must = loadFixtureMustDiscover(fixtureRoot);

  beforeAll(async () => {
    server = await startSurfaceMcpServer(fixtureRoot);
  }, 30_000);

  afterAll(async () => {
    await stopAll();
  });

  it('discovers all expected routes', async () => {
    const tools = await server.listTools(); // wraps mcpCall('tools/list', {})
    const routeStrings = tools
      .filter(t => /^(get|post|put|patch|delete)_/i.test(t.name))
      .map(t => `${t.method} ${t.path}`);
    for (const expected of must.routes) {
      expect(routeStrings).toContain(expected);
    }
  });

  it('reports inputSchemaConfidence per MUST_DISCOVER.perRoute', async () => {
    const tools = await server.listTools();
    for (const [route, expected] of Object.entries(must.perRoute ?? {})) {
      const tool = tools.find(t => `${t.method} ${t.path}` === route);
      expect(tool, `tool ${route} missing`).toBeDefined();
      expect(tool!.inputSchemaConfidence).toBe(expected.inputSchemaConfidence);
      if (expected.requiredFields) {
        expect(tool!.inputSchema.required ?? []).toEqual(
          expect.arrayContaining(expected.requiredFields)
        );
      }
    }
  });

  it('_suggestedExternalIntegrations matches include/exclude', async () => {
    const config = await server.getEffectiveConfig(); // server endpoint exposing the in-memory surface[0].externalIntegrations + _suggested
    const suggested: string[] = config.surfaces[0]._suggestedExternalIntegrations ?? [];
    for (const inc of must.suggestedExternalIntegrations.include) {
      expect(suggested.some(s => s.includes(inc)), `expected ${inc} in suggested`).toBe(true);
    }
    for (const exc of must.suggestedExternalIntegrations.exclude) {
      expect(suggested.some(s => s.includes(exc)), `expected ${exc} NOT in suggested`).toBe(false);
    }
  });

  it('surface_routes_for_page returns the journal-entries tool for its file', async () => {
    const result = await server.callTool('surface_routes_for_page', {
      sourceFile: 'app/api/journal-entries/route.ts',
    });
    expect(result.tools.length).toBeGreaterThan(0);
  });
});
```

### 5.3 Helpers

- `helpers/free-port.ts` — `export async function getFreePort(): Promise<number>;` using `net.createServer()`.
- `helpers/fixture-load.ts` — `export function loadFixtureMustDiscover(fixtureRoot: string): MustDiscover;` — synchronous JSON read with type assertion via Zod.
- `helpers/spawn.ts` — owns child process orchestration:
  - `startSurfaceMcpServer(cwd: string)` — spawns `node /root/SurfaceMCP/dist/cli/main.js serve` with `SURFACEMCP_CONFIG=<cwd>/surfacemcp.config.json` and `PORT=<freePort>`. Returns `{baseUrl, port, listTools, callTool, getEffectiveConfig, kill}`.
  - `stopAll()` — calls `kill` on all tracked processes; awaits exit; verifies via `process.kill(pid, 0)`.

The `listTools`, `callTool`, `getEffectiveConfig` methods are thin JSON-RPC wrappers that POST to `${baseUrl}/mcp` with the corresponding MCP method calls. Reuse the envelope-parsing pattern from `/root/BugHunter/packages/cli/src/adapters/surface-mcp.ts:81-126`.

### 5.4 Build prerequisite

The e2e spawns `dist/cli/main.js`. `npm run build` must run before `npm run test:e2e`. Document in `package.json`:

```json
{
  "scripts": {
    "test:e2e": "npm run build && node_modules/.bin/vitest run --config vitest.e2e.config.ts"
  }
}
```

---

## 6. Edge cases

| Case | Expected outcome |
|---|---|
| Fixture's `node_modules` missing | The harness does NOT auto-install. CI is responsible for `npm install --prefix fixtures/nextjs-app` before invoking. Document in README. |
| Free port grab races with another process | Vanishingly rare; `net.createServer().listen(0)` returns the actual bound port; the SurfaceMCP server binds to it within milliseconds. If a race does occur, the server's `listen` errors are surfaced and the test fails with a clear message. |
| `dist/cli/main.js` not built | `test:e2e` runs `npm run build` first. |
| `MUST_DISCOVER.json` and live SurfaceMCP disagree | The whole point of the assertion. Test fails with a diff. |
| Fixture page imports something not installed | `next dev` errors at first request; SurfaceMCP doesn't depend on Next compilation, only on AST parsing of the source files. Source-only errors surface during the `extractNextjsRoutes` pass. |
| `'partial'` confidence not yet implemented (sister-spec § B not landed) | The `MUST_DISCOVER.json` `perRoute` assertions for `'partial'` will fail. That's the correct sequencing signal — § B must land before this spec's e2e test passes. |

---

## 7. Acceptance criteria

- `npm run test` (existing) still green; no e2e tests run.
- `npm run test:e2e` green:
  1. `dist/cli/main.js` builds.
  2. SurfaceMCP server spawns against the fixture and is reachable within 10s.
  3. All four `it(...)` blocks in `surfacemcp-e2e.test.ts` pass.
  4. Spawned process is killed on `afterAll`; verified via `process.kill(pid, 0)`.
- `MUST_DISCOVER.json` is the canonical fixture spec. Adding new routes to the fixture requires updating it; the e2e enforces.
- Fixture `package.json` has `dev`, `start`, `build` scripts. `next dev -p ${PORT:-3010}` is parseable by SurfaceMCP § D's port detector.
- BugHunter's e2e harness (`/root/BugHunter/packages/cli/tests/e2e/`) consumes this fixture and passes (cross-repo gate verified).

---

## 8. Files to touch

| File | Type |
|---|---|
| `fixtures/nextjs-app/package.json` | EDIT |
| `fixtures/nextjs-app/app/dom-test/page.tsx` | NEW |
| `fixtures/nextjs-app/app/api/missing-route-link/page.tsx` | NEW |
| `fixtures/nextjs-app/app/api/conditional-404/route.ts` | NEW |
| `fixtures/nextjs-app/app/dual-404-link/page.tsx` | NEW |
| `fixtures/nextjs-app/MUST_DISCOVER.json` | EDIT |
| `src/e2e/surfacemcp-e2e.test.ts` | NEW |
| `src/e2e/helpers/spawn.ts` | NEW |
| `src/e2e/helpers/free-port.ts` | NEW |
| `src/e2e/helpers/fixture-load.ts` | NEW |
| `vitest.config.ts` | EDIT (`exclude: ['src/e2e/**']`) |
| `vitest.e2e.config.ts` | NEW |
| `package.json` | EDIT (add `test:e2e`) |
| `SPEC.md` | EDIT (single paragraph documenting the e2e and MUST_DISCOVER conformance) |

---

## 9. Risk & sequencing

### 9.1 Sequencing relative to `SPEC_PROBE_TIGHTENING.md`

This spec **depends on** sister spec §§ A–D having landed (those provide `'partial'` confidence + manual-validation analyser + `_suggestedExternalIntegrations` precision). The probe-tightening branch's commits up to `0137af9` are sufficient; this spec consumes that work.

### 9.2 Sequencing relative to BugHunter's `SPEC_GAPS_AND_E2E.md`

| Step | Repo | Note |
|---|---|---|
| 1 | SurfaceMCP | Land fixture extensions (§ 4) on `spec/e2e-harness`. |
| 2 | SurfaceMCP | Land `src/e2e/surfacemcp-e2e.test.ts` and helpers; verify `npm run test:e2e` green. |
| 3 | BugHunter | Land Gap 1.A + Gap 1.B fixes on `spec/gaps-and-e2e`. |
| 4 | BugHunter | Land BugHunter e2e harness consuming SurfaceMCP fixture. |

Each step is independently verifiable. Step 4 requires Steps 1, 2, 3.

### 9.3 Risk

- **Fixture deps shift.** If `next` 15.0.0 changes its `dev` server output format, the harness's port-readiness probe (HTTP fetch of `/`) needs to handle different shapes. Mitigated: the probe just checks for any 200/404/500 response within 30s, not specific content.
- **`'partial'` field not yet exposed via the MCP `tools/list` envelope.** The probe-tightening spec (§ A) extends the type but doesn't say where it surfaces in the MCP response. The e2e test calls `tools/list` and reads each tool's metadata; if `inputSchemaConfidence` isn't in the wire envelope, the test fails with a clear error. Mitigation: review `src/server/tools-meta.ts` after § A lands; add to wire envelope if missing.
- **Cross-repo coupling.** Acknowledged and intentional (§ 3.3).

---

## 10. Definition of done

- All files in § 8 land per § 9.2 sequencing.
- `npm run test` clean.
- `npm run test:e2e` green.
- `MUST_DISCOVER.json` reflects the new routes and per-route confidence.
- `fixtures/nextjs-app/package.json` has `dev`, `start`, `build` scripts.
- BugHunter's e2e (sister spec) consumes this fixture and passes.

---

## 11. Open questions

None requiring user input. All decisions deterministic given:
- The probe-tightening spec's `'partial'` decision (§ A).
- The fixture's existing `app/components/CheckoutButton.tsx` and `app/policies/privacy/page.tsx` for § C exclusions.
- BugHunter's Option C decision documented in `/root/BugHunter/SPEC_GAPS_AND_E2E.md` § 2.A.1.
