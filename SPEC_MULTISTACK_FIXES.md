# SPEC: Multi-Stack Discovery Fixes

Branch: `spec/multistack-fixes`
Status: Ready for implementation
Owner: @architect (spec) → @coder (impl)

## 1. Problem Statement

Discovery extractors and the HTTP server have five validated bugs and two related cleanups:

- **Bug 1**: Django route discovery emits 8 routes for the django-app fixture instead of 5 — three false positives caused by a malformed `viewRef` falling through into a permissive method scan over combined `urls.py` + `views.py`.
- **Bug 2**: Django tool names contain raw `:` (e.g. `get_api_items_:pk`), which is invalid for MCP tool identifiers (must be alphanumeric / underscore).
- **Bug 3**: `src/server/http.ts` runs its "entry point" startup code unconditionally at module load. When `cli/serve.ts` imports `createApp`, the side-effect block fires a second `createApp` + `listen`, doubling catalog regen and racing on the port.
- **Bug 4**: FastAPI extractor requires a live server. If the OpenAPI fetch fails it throws and the catalog stays empty — even when an `openapi.json` is sitting on disk in `root`.
- **Bug 5**: The django route-extraction test only asserts expected routes are *present*; it never asserts the discovered set's size, so Bug 1's three false positives are invisible to CI.
- **Cleanup A**: `src/extract/express/runtime.ts` exports `surfaceMiddleware()` that always returns `{routes: [], note: 'Configure...'}`. It is never wired and produces no useful output. Dead code.
- **Cleanup B**: `cli/init.ts` only emits `launchDevCommand` for the `nextjs` stack; express/fastapi/django scaffolds get `undefined`, leaving operators to hand-edit the config.

## 2. Root Causes (verified against current code)

### Bug 1 — `src/extract/django/ast-walk.ts:75-108` (`guessMethodsFromViewRef`)

`parseUrlsFile` line 54 uses regex `/path\s*\(\s*['"`]([^'"` ]*)['"`]\s*,\s*(.+?)[\s,)]/`. The non-greedy `(.+?)` plus the `[\s,)]` stop character means input like `path('items/', views.ItemListView.as_view(), name='item-list')` captures `viewRef = "views.ItemListView.as_view("` (trailing `(` survives because the regex stops at the closing `)`).

Then in `guessMethodsFromViewRef`:
- Line 76: `name = "as_view("`, `nameLower = "as_view("`.
- Lines 80-86: none of the `listcreate`/`retrieve`/`list`/`create`/`update`/`destroy`/`delete` heuristics match `"as_view("`.
- Lines 89-104: falls through to scanning `combinedContent` (urls.py + views.py concatenated, set up at `walkUrlsFile` line 153). The regex `/^\s+def get\s*\(/m` matches **any** view in views.py — for the fixture, both `ItemListView` and `ItemDetailView` contribute methods, so both URL prefixes (`/api/items/` and `/api/items/:pk`) get the union `[GET, POST, PUT, DELETE]`.

Net result for the django-app fixture: `2 paths × 4 methods = 8` discovered routes; expected 5 (`GET/POST /api/items/`, `GET/PUT/DELETE /api/items/:pk`).

### Bug 2 — `src/extract/django/ast-walk.ts:18-25` (`pathToToolName`)

After `normalizeDjangoPath` (line 32-36), `<int:pk>` becomes `:pk`. The cleanup regex on line 21 is `/[/<>]/g` — it replaces `/`, `<`, `>` with `_`, but **not** `:`. The colon survives into the tool name. Express extractor and OpenAPI extractor handle this by including `:` in the strip set (or by emitting `{...}` syntax that converts cleanly).

### Bug 3 — `src/server/http.ts:368-389`

Lines 369-389 are top-level (no guard). When `cli/serve.ts:5` does `import { createApp } from '../server/http.js'`, ESM evaluates the entire module — `loadConfig`, `loadEnvFiles`, and `createApp(...).then(app => app.listen(...))` all run. `cli/serve.ts:62` then calls `createApp` *again* and binds the same port. Symptom: `regenerateCatalog` runs twice and the second `listen` throws `EADDRINUSE`.

### Bug 4 — `src/extract/fastapi/openapi-fetch.ts:84-94`

`fetchFastApiSchema` does a single `fetch(`${baseUrl}/openapi.json`)`. On failure it throws. `tools-meta.ts:53` catches and logs `'extraction error — catalog unchanged'` — meaning a transient dev-server outage leaves the catalog at zero tools forever (until next change-event triggers another regen with the server now up). The fastapi-app fixture *has* an `openapi.json` on disk; the existing `extractOpenApiRoutes` (`src/extract/openapi/parse.ts`) already knows how to parse it, but `fetchFastApiSchema` never falls back to it.

`fetchFastApiSchema` also has no unit tests — only `extractOpenApiRoutes` is exercised.

### Bug 5 — `src/extract/extract.test.ts:139-156`

Lines 146-154 build `discovered = new Set(...)` then loop through `must.routes` asserting `discovered.has(route) || discovered.has(withSlash) || discovered.has(withoutSlash)`. There is no assertion on `discovered.size`, so any number of unexpected routes passes. The bidirectional trailing-slash normalization is also a code smell — the discovered path format should be deterministic.

### Cleanup A — `src/extract/express/runtime.ts`

The exported `surfaceMiddleware()` returns a stub handler that always sends `{routes: [], note: 'Configure...'}`. Grep across `src` shows no caller imports it. Dead.

### Cleanup B — `src/cli/init.ts:87`

`launchDevCommand: stack === 'nextjs' ? 'npm run dev' : undefined,` — only nextjs gets a default. There is already a `defaultBaseUrl` and `defaultWatchPaths` lookup table pattern (lines 48-68); a `defaultLaunchCommand` lookup is the obvious shape.

## 3. Fix Design

### Bug 1 — Strip call-suffix from viewRef, scan only the target class

In `parseUrlsFile`, before pushing the entry, normalize the captured viewRef:

```ts
// rest = pathMatch[2].trim()
// Strip a trailing '(...)' (Django's `as_view()` invocation) so we keep just the dotted path.
const cleanedRest = rest.replace(/\s*\(.*$/, '').replace(/[,\s].*$/, '');
```

And in `guessMethodsFromViewRef`, replace the combined-content fallthrough (lines 88-105) with a *class-scoped* method scan:

```ts
function methodsForClass(className: string, viewsContent: string): string[] {
  // Find `class <className>(...):` and extract the body (until next top-level def/class)
  const re = new RegExp(`class\\s+${className}\\b[^:]*:`, 'm');
  const m = re.exec(viewsContent);
  if (!m) return [];
  // Body starts right after the match. Take everything until the next `^class ` or `^def ` (column 0)
  // — these terminate the class's indented block.
  const after = viewsContent.slice(m.index + m[0].length);
  const end = after.search(/^\s*(?:class|def)\s+/m);
  const body = end === -1 ? after : after.slice(0, end);
  const methods: string[] = [];
  if (/^\s+def\s+get\s*\(/m.test(body)) methods.push('GET');
  if (/^\s+def\s+post\s*\(/m.test(body)) methods.push('POST');
  if (/^\s+def\s+put\s*\(/m.test(body)) methods.push('PUT');
  if (/^\s+def\s+patch\s*\(/m.test(body)) methods.push('PATCH');
  if (/^\s+def\s+delete\s*\(/m.test(body)) methods.push('DELETE');
  return methods;
}
```

The class name is `viewRef.split('.').pop()` after the trailing-paren strip. If `methodsForClass` returns at least one method, use it. If empty, fall back to the existing name-based DRF heuristics, then to `['GET','POST']`.

Pass `viewsContent` (not `combinedContent`) into `guessMethodsFromViewRef` so the scan window is the views file only. Drop the `combinedContent` variable in `walkUrlsFile`.

Note: `http_method_names = [...]` detection (line 90) is class-attribute style — keep that, but scope it to the class body too.

### Bug 2 — Extend the strip pattern in Django `pathToToolName`

```ts
function pathToToolName(method: string, path: string): string {
  const normalized = path
    .replace(/^\//, '')
    .replace(/[/<>:]/g, '_')   // add ':' to the strip class
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `${method.toLowerCase()}_${normalized || 'root'}`;
}
```

For consistency, do the same in `src/extract/openapi/parse.ts:30-38` and `src/extract/fastapi/openapi-fetch.ts:33-41`. Today they only emit `:param` if their input already used `:` — but that *will* happen if a future `Express`-style path slips through, and there's no reason to leave the bug shape lurking. Strip `:` everywhere `pathToToolName` exists.

### Bug 3 — Guard the http.ts entry block

Wrap lines 368-389 in the standard ESM script-detection guard:

```ts
import { fileURLToPath, pathToFileURL } from 'node:url';

// Entry point when run directly (e.g. `node dist/server/http.js`)
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  const configPath = process.env.SURFACEMCP_CONFIG ?? findConfigPath(process.cwd());
  const config = loadConfig(configPath);
  const projectRoot = process.cwd();

  loadEnvFiles(projectRoot);

  const surface = config.surfaces[0]!;
  const resolvedRoot = resolve(projectRoot, surface.root);

  createApp(surface, resolvedRoot).then((app) => {
    app.listen(surface.port, '127.0.0.1', () => {
      log.info(
        { port: surface.port, endpoint: `http://127.0.0.1:${surface.port}/mcp` },
        `SurfaceMCP ${surface.name} listening`
      );
    });
  }).catch((err: unknown) => {
    log.error({ err }, 'Failed to start SurfaceMCP');
    process.exit(1);
  });
}
```

This preserves `node dist/server/http.js` direct-run behavior while making `import { createApp }` side-effect free.

### Bug 4 — FastAPI static fallback + tests

Modify `fetchFastApiSchema` to accept an optional `root` and fall back to `extractOpenApiRoutes(root)` on fetch failure:

```ts
export async function fetchFastApiSchema(baseUrl: string, root?: string): Promise<ToolMeta[]> {
  const openApiUrl = `${baseUrl.replace(/\/$/, '')}/openapi.json`;

  let spec: OpenApiSchema | null = null;
  try {
    const res = await fetch(openApiUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    spec = await res.json() as OpenApiSchema;
  } catch (err) {
    log.warn({ openApiUrl, err: String(err) }, 'FastAPI live fetch failed; trying static fallback');
  }

  if (!spec) {
    if (root) {
      const fallback = extractOpenApiRoutes(root);
      if (fallback.length > 0) {
        log.info({ count: fallback.length }, 'FastAPI catalog from static openapi.json');
        return fallback;
      }
    }
    log.warn({ openApiUrl }, 'FastAPI catalog empty: no live server, no static spec');
    return [];
  }

  // ...existing parsing path unchanged
}
```

Update the call site in `src/server/tools-meta.ts:44`:

```ts
case 'fastapi':
  tools = await fetchFastApiSchema(surface.baseUrl, root);
  break;
```

Replace the `throw` on fetch failure with a soft warning + empty/fallback result so transient dev-server outages do not silently zero the catalog (the call site already does `try/catch` around extraction, but the new behavior is *also* the right semantics: the catch in `tools-meta.ts:53` discards results and keeps the *previous* catalog; we want *new* extraction with the static spec).

Add unit tests at `src/extract/fastapi/openapi-fetch.test.ts`:
- `success`: `vi.stubGlobal('fetch', ...)` returning a small valid OpenAPI doc → expect routes.
- `live-fail-with-static`: stub fetch to throw; call with `root` pointing at a fixture dir containing `openapi.json` → expect static routes.
- `live-fail-no-static`: stub fetch to throw; call with `root` pointing at an empty tmp dir → expect `[]` and a warn log.
- `live-fail-no-root`: stub fetch to throw; call without `root` → expect `[]`.

Use `vitest`'s `vi.stubGlobal` and restore in `afterEach`.

### Bug 5 — Tighten the django assertion

Replace lines 139-156 with:

```ts
describe('django route extraction', () => {
  it('discovers exactly the must-discover route set (no false positives)', () => {
    const root = resolve(FIXTURES, 'django-app');
    const tools = extractDjangoRoutes(root);
    const must = loadMustDiscover('django-app');

    const discovered = new Set(tools.map((t) => `${t.method} ${t.path}`));
    const expected = new Set(must.routes ?? []);

    // Every expected route present
    for (const route of expected) {
      expect(discovered.has(route), `Missing route: ${route}`).toBe(true);
    }
    // No extras
    expect(
      [...discovered].filter((r) => !expected.has(r)),
      'Unexpected routes discovered'
    ).toEqual([]);
    expect(discovered.size).toBe(expected.size);
  });

  it('emits no invalid characters in tool names', () => {
    const root = resolve(FIXTURES, 'django-app');
    const tools = extractDjangoRoutes(root);
    for (const t of tools) {
      expect(t.name, `bad tool name: ${t.name}`).toMatch(/^[a-z0-9_]+$/);
    }
  });
});
```

The second test gates Bug 2's fix.

Drop the bidirectional trailing-slash matching. If there is a discovered/expected mismatch on trailing slashes after Bug 1's fix lands, fix the *discovered path format* (or the fixture's `MUST_DISCOVER.json`) — do not paper over with normalization. Recommended: keep Django's natural trailing-slash convention in `MUST_DISCOVER.json` (already the case: `"GET /api/items/"`, `"GET /api/items/:pk"` mixed — the detail route has no trailing slash because `<int:pk>` is the last URL segment). Verify by running the test after Bug 1 lands; if the discovered set differs only by trailing slash, update `MUST_DISCOVER.json` to match the discovered output.

### Cleanup A — Delete `src/extract/express/runtime.ts`

Delete the file. Grep confirms no production importers (only `src/extract/express/runtime.ts` itself appears). Verify after removal:

```bash
grep -r "surfaceMiddleware\|express/runtime" src/
```

Should return zero hits.

### Cleanup B — Per-stack `launchDevCommand`

Add a lookup in `src/cli/init.ts` mirroring `defaultBaseUrl`:

```ts
function defaultLaunchCommand(stack: string): string | undefined {
  const cmds: Record<string, string> = {
    nextjs: 'npm run dev',
    express: 'npm run dev',
    fastapi: 'uvicorn main:app --reload',
    django: 'python manage.py runserver',
  };
  return cmds[stack];
}
```

And in `buildSurfaceConfig`:

```ts
launchDevCommand: defaultLaunchCommand(stack),
```

`openapi` stack stays `undefined` — there's no canonical dev command for a static spec.

## 4. Test Plan

| Bug | Test command | Pass criterion |
|-----|-------------|----------------|
| 1 + 5 | `npx vitest run src/extract/extract.test.ts` | django suite passes; discovered size === 5; tool-name suite passes |
| 2 | same as above | the second new test (`emits no invalid characters in tool names`) passes |
| 3 | `npx tsc --noEmit && node dist/cli/serve.js` (with a valid config in cwd) | exactly one `catalog updated` log; one `listening` log; no `EADDRINUSE` |
| 4 | `npx vitest run src/extract/fastapi/openapi-fetch.test.ts` | all four cases pass |
| Cleanup A | `npx tsc --noEmit && grep -r 'surfaceMiddleware\|express/runtime' src/` | tsc clean; grep empty |
| Cleanup B | `cd /tmp/test-init && surfacemcp init --stack=express` then inspect `surfacemcp.config.json` | `launchDevCommand: "npm run dev"` present; same for fastapi/django |

Final gate (mandatory):

```bash
npx tsc --noEmit
npx eslint . --max-warnings 0
npx vitest run
npm run build
```

All four must pass with zero errors / zero warnings.

## 5. Files to Touch

**Modify**:
- `src/extract/django/ast-walk.ts` — Bugs 1, 2 (regex strip + class-scoped method scan + pathToToolName)
- `src/extract/openapi/parse.ts` — Bug 2 consistency (extend `pathToToolName` strip set)
- `src/extract/fastapi/openapi-fetch.ts` — Bug 2 consistency + Bug 4 fallback signature
- `src/server/http.ts` — Bug 3 (entry-point guard, add `pathToFileURL` import)
- `src/server/tools-meta.ts` — Bug 4 call site (pass `root` to `fetchFastApiSchema`)
- `src/extract/extract.test.ts` — Bug 5 (tighten django assertion + tool-name regex test)
- `src/cli/init.ts` — Cleanup B (`defaultLaunchCommand`)

**Create**:
- `src/extract/fastapi/openapi-fetch.test.ts` — Bug 4 unit tests

**Delete**:
- `src/extract/express/runtime.ts` — Cleanup A

## 6. Sequencing

1. **Bug 5 + Bug 1 land together** — Bug 5 is the test that gates Bug 1. Sequence: write the tightened test first (it should fail against current code with "Unexpected routes discovered"), then land the Bug 1 fix in the same commit. This proves the test catches the bug *and* the fix passes the test.
2. **Bug 2** — independent, but bundle with Bug 5's tool-name regex test in the same commit (so both halves of the test land with their fix).
3. **Bug 3** — independent. One-file change.
4. **Bug 4** — independent. New test file plus signature change at the single call site.
5. **Cleanup A** — independent.
6. **Cleanup B** — independent.

Recommended commit shape (all on `spec/multistack-fixes`):
- `commit 1`: Tighten django test + fix viewRef regex / class-scoped scan (Bugs 1, 5)
- `commit 2`: Strip `:` in tool-name normalization across stacks (Bug 2 + Bug 5 tool-name test)
- `commit 3`: Guard http.ts entry block (Bug 3)
- `commit 4`: FastAPI static fallback + unit tests (Bug 4)
- `commit 5`: Delete dead express/runtime.ts (Cleanup A)
- `commit 6`: Per-stack launchDevCommand defaults (Cleanup B)

Each commit must independently pass the full verification suite (tsc / eslint / vitest / build).

## 7. Risk

- **Bug 1**: The previous false-positive logic happened to populate methods for views that *would* match the name-based DRF heuristic. After fixing, any view class that uses neither `def get/post/...` nor a recognized DRF naming convention (e.g. mixin-only views: `class FooView(ListCreateAPIView)`) will fall through to `['GET','POST']`. That is the existing default and matches today's behavior for those cases — no regression expected. **Validate**: rerun the django fixture and confirm exactly 5 routes; if any real-world Django consumer relied on the bug's permissive behavior, surface it as a follow-up rather than reverting.
- **Bug 2**: Tool names will change for Django routes containing path params (`get_api_items_:pk` → `get_api_items_pk`). If any external caller (test, MCP client) hard-codes a Django tool name, it breaks. Acceptable: tool names are extractor-derived and not part of the stable contract; `toolId` (sha1) is the stable handle.
- **Bug 3**: If anything in the codebase imported `http.ts` *for the side effect* of starting a server, it will stop working. Grep confirms only `cli/serve.ts` imports `createApp`, and `cli/serve.ts` does its own `listen`. Safe.
- **Bug 4**: Behavior change: a fetch failure now returns `[]` (or static fallback) instead of throwing. `tools-meta.ts:53` will *not* hit the catch, so the catalog updates to the new (possibly empty) result instead of preserving the previous one. For the `fastapi` stack with no live server and no static spec, this means the catalog goes empty on the first regen instead of staying at zero forever — net same effect but observable via the `'FastAPI catalog empty'` warn log. Acceptable.
- **Cleanup A**: None — verified zero callers.
- **Cleanup B**: None — additive; only fills `undefined` slots.

## 8. Acceptance Criteria

Each item is concrete and testable. Implementation is "done" when all are green.

1. **Bug 1**: `extractDjangoRoutes(fixtures/django-app)` returns exactly 5 ToolMeta entries with method/path pairs `{GET /api/items/, POST /api/items/, GET /api/items/:pk, PUT /api/items/:pk, DELETE /api/items/:pk}` (or whichever trailing-slash form the discovered set settles on, mirrored in `MUST_DISCOVER.json`).
2. **Bug 2**: For every tool emitted by `extractDjangoRoutes`, `pathToToolName` output matches `/^[a-z0-9_]+$/`. Same invariant holds for `openapi/parse.ts` and `fastapi/openapi-fetch.ts` outputs.
3. **Bug 3**: Importing `createApp` from `src/server/http.ts` (the path `cli/serve.ts` takes) does *not* trigger `loadConfig`, `loadEnvFiles`, `createApp`, or `listen` at module load. Running `node dist/server/http.js` directly *does* trigger them (single startup path preserved).
4. **Bug 4**: `fetchFastApiSchema` returns the static `openapi.json` routes when (a) live fetch fails and (b) `root` contains `openapi.json`. Returns `[]` when no live server and no static spec. Has the four unit tests listed in §3 Bug 4 and they pass.
5. **Bug 5**: `extract.test.ts` django suite asserts `discovered.size === expected.size` and asserts no extras. Without Bug 1's fix applied, the test fails with a clear "Unexpected routes discovered" message naming the false positives. With both fixes applied, it passes.
6. **Cleanup A**: `src/extract/express/runtime.ts` is gone. `grep -r 'surfaceMiddleware\|express/runtime' src/` returns zero hits. `npx tsc --noEmit` and `npm run build` succeed.
7. **Cleanup B**: After `surfacemcp init --stack=express` (resp. fastapi, django), the generated `surfacemcp.config.json` contains `launchDevCommand: "npm run dev"` (resp. `"uvicorn main:app --reload"`, `"python manage.py runserver"`). nextjs unchanged. openapi remains `undefined`.
8. **Final gate**: `npx tsc --noEmit && npx eslint . --max-warnings 0 && npx vitest run && npm run build` all succeed with zero errors and zero warnings on every commit on the branch.
