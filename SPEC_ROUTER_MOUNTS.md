# SPEC: Resolve `app.use(prefix, router)` Mounts in Express Extractor

Branch: `spec/router-mounts`
Owner: @architect (spec) → @coder (impl)
Status: spec for implementation. Not yet implemented.

---

## 1. Problem

SurfaceMCP's static Express extractor (`src/extract/express/static.ts`) finds
`app.METHOD(path, ...)` and `router.METHOD(path, ...)` calls by scanning every
source file in the project. It treats the literal first-string argument as the
final route path. It does **not** resolve `app.use(prefix, router)` mounts.

When a project mounts an imported `Router()` instance under a prefix, every
route inside that router is currently surfaced under its **bare** path — not
the mounted, externally-callable URL.

### Evidence — TraiderJo (BugHunt run `idva5golrvxxcac4rlwv8f3g`)

Two `network_4xx_unexpected` clusters had the same root cause:

| Cluster ID | Surfaced (wrong) URL | Real URL |
|------------|----------------------|----------|
| `byruz0xl6720k8ankm9pbw8g` | `POST /summaries/daily` → 403 | `POST /api/v1/summaries/daily` |
| `eu8b2m4ai4itjrbb3a4dclb0` | `POST /trades/batch` → 403 | `POST /api/v1/trades/batch` |

The 403 came from CSRF middleware fielding the request as an unmatched route.
BugHunter classified it as a server bug; it was a SurfaceMCP miss.

### Mount sites

`/tmp/TraiderJo/server/src/index.js`

```js
// L124
import { moneybotRouter, hashApiKey, generateApiKey, computeKeyLookupHash } from './moneybot/index.js';
// L125
import { mcpRouter } from './mcp/http.js';
// ...
// L594
app.use('/api/v1', moneybotRouter);
// L596
app.use('/mcp', mcpRouter);
```

`/tmp/TraiderJo/server/src/moneybot/index.js`

```js
export { default as moneybotRouter } from './routes.js';
```

`/tmp/TraiderJo/server/src/moneybot/routes.js`

```js
import { Router } from 'express';
const router = Router();
router.get('/health', ...);              // L53
router.post('/trades', ...);             // L79
router.post('/trades/batch', ...);       // L146
router.get('/trades/:trade_id', ...);    // L302
router.post('/summaries/daily', ...);    // L347
export default router;
```

`/tmp/TraiderJo/server/src/mcp/http.js`

```js
const router = express.Router();          // L24
router.post('/', mcpPreAuthLimiter, ...);  // L155
router.get('/', mcpPreAuthLimiter, ...);   // L286
router.delete('/', mcpPreAuthLimiter, ...);// L328
export { router as mcpRouter };
```

### Quantified impact (current SurfaceMCP `:3103` against TraiderJo)

Surfaced (wrong) routes from mounted routers:

```
GET  /health             -> src/moneybot/routes.js:53      (real: /api/v1/health)
POST /trades             -> src/moneybot/routes.js:79      (real: /api/v1/trades) *
POST /trades/batch       -> src/moneybot/routes.js:146     (real: /api/v1/trades/batch)
GET  /trades/:trade_id   -> src/moneybot/routes.js:302     (real: /api/v1/trades/:trade_id)
POST /summaries/daily    -> src/moneybot/routes.js:347     (real: /api/v1/summaries/daily)
```

\* `POST /trades` also appears as a separate, real top-level route at
`src/index.js:3547` — collision is data, not bug.

`mcp/http.js` adds three more (`POST/GET/DELETE /` → real `/mcp`).

**Total mis-stamped routes from mounted routers: 8.** The TraiderJo `/api/v1/*`
prefix happens to be partially "saved" by four `app.post('/api/v1/...', limiterOnly)`
middleware-registration calls at `index.js:589–592` that share the same URL,
which is why `POST /api/v1/trades`, `POST /api/v1/trades/batch`,
`GET /api/v1/trades/:trade_id`, `POST /api/v1/summaries/daily` are accidentally
present in the surface as well. They are duplicates of the bare-path entries,
not a fix. Without those handler-less rate-limiter shims, all eight routes
would be 100% missing from the correct URL.

---

## 2. Root Cause

`extractRoutesFromFile` in `src/extract/express/static.ts` has a single AST
predicate:

```ts
const methodMatch = /\.(get|post|put|patch|delete|head|options)\s*$/.exec(text);
```

It treats `app.get(...)` and `router.get(...)` interchangeably and stamps the
first string argument as the canonical path. The extractor has no notion of:

1. Mount edges — `app.use(prefix, identifier)` calls
2. Identifier-to-source-file resolution
3. Recursive `router.use(subPrefix, subRouter)` chains
4. Re-exports between barrel files (`./moneybot/index.js`)

Result: every router file's routes are surfaced under their **internal**
paths, missing the prefix the application actually mounts them under.

---

## 3. Fix Design

Add a mount-resolution pre-pass that builds a map from each
`router.METHOD(...)` call site to the prefix it is reachable under, then use
that map when stamping final route paths.

### 3.1 Data structures

```ts
type RouterBinding = {
  // Absolute path of the file where this Router() instance lives
  filePath: string;
  // Local identifier(s) in `filePath` that are bound to this Router instance
  // (e.g. `router` in routes.js). Multiple aliases allowed.
  localNames: Set<string>;
  // Export names this Router is exposed under from `filePath`
  // e.g. { '__default__': 'router', 'mcpRouter': 'router' }
  exportMap: Map<string, string>;
};

type MountEdge = {
  prefix: string;            // joined absolute prefix for THIS edge's parent
  routerKey: string;         // `${absFilePath}::${exportName}`
  parentFile: string;        // file containing the app.use / router.use call
  callLine: number;
};

type ResolvedRoute = {
  method: string;
  path: string;              // FINAL prefixed path
  sourceFile: string;        // file containing the router.METHOD call
  sourceLine: number;
  callNode: CallExpression;
  sf: SourceFile;
};
```

### 3.2 Algorithm

Pseudocode (to live in a new module `src/extract/express/mounts.ts`,
called from `static.ts`):

```
Step A — Per-file scan (single ts-morph Project, all files added once):
  For each file F:
    For each VariableDeclaration in F:
      If initializer is a CallExpression to `Router(...)` or `<x>.Router(...)`
      where the callee text matches /(^|\.)Router$/, record:
        bindings[F].push({ localName: decl.getName(), node: decl })
    Build F.exportMap:
      - default export of identifier  -> '__default__': identifier
      - `export { x as y }` / `export { x }` -> 'y' (or 'x'): x
      - `module.exports = x`           -> '__default__': x
      - `module.exports.y = x`         -> 'y': x
      - `export default Router()`      -> if the default-exported expression IS the Router() call itself,
                                           synthesize a localName '__default_inline__' bound to that node
    Build F.reexportMap (string -> { fromPath, srcExportName }):
      - `export { default as Y } from './p'` -> 'Y': { fromPath: './p', srcExportName: '__default__' }
      - `export { X } from './p'`            -> 'X': { fromPath: './p', srcExportName: 'X' }
      - `export { X as Y } from './p'`       -> 'Y': { fromPath: './p', srcExportName: 'X' }
      - `export * from './p'`                -> defer: lazily probe target file when a name is requested
    Build F.imports (importedLocalName -> { fromPath, srcExportName }):
      - ESM and CJS named/default forms
      - Bare path resolution via `resolvePath(F, fromPath)` (Section 3.3)

Step B — Resolve(filePath, exportName, stack) -> RouterBinding | null:
  key = `${filePath}::${exportName}`
  if key in stack: return null  // cycle; warn once
  stack.add(key)
  if reexportMap[exportName] exists:
    target = resolvePath(filePath, reexportMap[exportName].fromPath)
    return Resolve(target, reexportMap[exportName].srcExportName, stack)
  if exportMap[exportName] exists:
    localName = exportMap[exportName]
    if localName is a Router-bound local in filePath:
      return { filePath, localNames: aliasesOf(localName), exportMap }
  return null

Step C — Mount-edge collection:
  edges: MountEdge[] = []
  prefixByCallNode: Map<CallExpression, string>
  visited: Set<routerKey>     // for de-dup within a single root walk

  function walkMountedRouter(binding: RouterBinding, prefix: string, stack):
    fileKey = `${binding.filePath}::${[...binding.localNames].join(',')}`
    if fileKey in stack: return  // cycle
    stack.add(fileKey)
    For each CallExpression CE in binding.filePath:
      callee = CE.getExpression()
      if callee is `<localName>.METHOD` for any localName in binding.localNames:
        prefixByCallNode.set(CE, prefix)
      else if callee is `<localName>.use` for any localName in binding.localNames:
        args = CE.getArguments()
        // Two arg shapes:
        //   .use(subRouter)               -> subPrefix = ''
        //   .use(subPrefix, subRouter)    -> subPrefix = string literal
        //   .use(subPrefix, mw1, mw2, ..., subRouter)  -> subPrefix is first arg, subRouter is last identifier arg
        Detect subPrefix (string literal or '') and subRouter (Identifier).
        If subRouter is Identifier:
          Resolve subRouter -> RouterBinding via:
            (a) imports[binding.filePath][subRouter.name]  -> Resolve(fromPath, srcExportName)
            (b) same-file: if subRouter.name is a local Router-bound declaration in binding.filePath
        If resolved:
          walkMountedRouter(child, joinPath(prefix, subPrefix), stack)

  // Top-level seed: scan the index/server entry files for app.use(prefix, ident)
  For each CallExpression CE in any file:
    if CE matches `<id>.use(prefix, identifier)` AND <id> resolves to an Express app:
      — but we cannot reliably identify `app` vs `router` statically.
      — Heuristic: treat ANY `<id>.use(string, identifier)` call seen at the file's
        TOP LEVEL (not inside another walk) as a candidate mount.
    Actually: simplification — Step C runs in TWO modes:
      (1) seedScan: walk ALL files, find every `<id>.use(<string>, <identifier>)`
          whose <identifier> resolves to a RouterBinding. Treat the literal
          string as the absolute prefix (it is, by construction — it is being
          attached to the Express app).
      (2) recursion: from each seed, walk into the bound router file and
          process internal `router.use(subPrefix, subSubRouter)` recursively.

    To avoid double-walking when the same router is mounted twice:
      Each walkMountedRouter call gets its OWN visited stack and emits its OWN
      prefixByCallNode entries. If a call node already has a prefix recorded,
      add a SECOND entry to a `secondaryPrefixes` map so the route emitter can
      generate one ResolvedRoute per mount.

Step D — Final route emission (modifies extractRoutesFromFile site in static.ts):
  routes: ResolvedRoute[] = []
  For each `<x>.METHOD(path, ...)` CallExpression CE in any file:
    if prefixByCallNode has CE:
      basePrefix = prefixByCallNode.get(CE)
      // For each prefix this CE was mounted under (primary + secondaries):
      For prefix in [basePrefix, ...secondaryPrefixes.get(CE) ?? []]:
        routes.push({ method, path: joinPath(prefix, literal), ... })
    else:
      // Backwards-compat fallback: emit bare. This preserves existing behavior
      // for files like the current express-app fixture where routes are
      // attached directly to `app` (no mount).
      routes.push({ method, path: literal, ... })
```

### 3.3 Path resolution (`resolvePath(fromFile, spec)`)

```
1. If spec starts with '.': resolve(dirname(fromFile), spec)
2. Strip trailing slash; try in this order until a file exists:
     candidate
     candidate + '.ts'
     candidate + '.js'
     candidate + '.mjs'
     candidate + '.cjs'
     candidate + '/index.ts'
     candidate + '/index.js'
     candidate + '/index.mjs'
     candidate + '/index.cjs'
   (TraiderJo writes `.js` extensions in ESM imports — DO try the literal
   path first.)
3. If spec is non-relative ('express', 'lodash', etc.) — return null. We do
   not chase node_modules.
```

### 3.4 `joinPath(prefix, sub)`

```
- Treat empty/undefined prefix as ''
- Strip trailing '/' from prefix
- Ensure sub starts with '/'  (sub === ''  -> treat as '/')
- If sub === '/' AND prefix !== ''  -> return prefix
- Else return prefix + sub
- Collapse runs of '//' to '/' (defensive)
```

Examples:
- `joinPath('/api/v1', '/health')` = `/api/v1/health`
- `joinPath('/mcp',     '/')`      = `/mcp`
- `joinPath('',         '/x')`     = `/x`
- `joinPath('/a',       '')`       = `/a`
- `joinPath('/a/',      '/b')`     = `/a/b`

### 3.5 Cycle detection

Two cycle classes:
1. **Re-export cycles**: `Resolve()` carries a `Set<routerKey>` stack; on
   repeat, returns null and emits a `console.warn` once per process.
2. **Mount cycles**: `walkMountedRouter` tracks `Set<filePath::localNames>`;
   on repeat, stops descent (does not throw).

### 3.6 What we do NOT support (out of scope, document in code comments)

- **Dynamic mounts**: `app.use(prefix, await loadRouter())`, `app.use(getRouter())`
  (call expression as identifier) — skip silently. BugHunter will surface
  these as 404 on probe and we accept the false positive.
- **Re-export-all** (`export * from './p'`): mark as best-effort. If we hit
  one while resolving a name `Y`, we open `./p` and probe its
  `exportMap`/`reexportMap` for `Y`. If multiple `export *` chains compete,
  first match wins. If none match, return null. (A single `console.warn`
  per unresolved name.)
- **Spread-mounted routers**: `app.use(...arr)` — skip.
- **Conditional mounts**: `if (FLAG) app.use(...)` — extracted unconditionally.
  If the flag is false at runtime BugHunter probes the route, gets a 404, and
  classifies as `auth_or_route_404` (not a bug). Acceptable.
- **Class-based / decorator routers** (NestJS, etc.) — out of scope; this
  extractor remains Express-shaped.

### 3.7 JS vs TS

ts-morph natively parses both. Add JS files to the Project with
`addSourceFileAtPath(...)` — already happens. No type-checker dependency in
the new module; pure structural AST walking. This works on TraiderJo (`.js`
ESM) without changes.

---

## 4. Tests

Add to `src/extract/express/static.test.ts` (NEW cases — keep all 7 existing
cases passing):

### case 8 — simple mounted router (TraiderJo shape)

```js
// /tmp/.../routes.js
const router = require('express').Router();
router.get('/health', h);
router.post('/trades', h);
module.exports = router;

// /tmp/.../app.js
const app = require('express')();
const r = require('./routes');
app.use('/api/v1', r);
```

Assert:
- `GET /api/v1/health` exists, `inputSchema` is unknown
- `POST /api/v1/trades` exists
- `GET /health` does NOT exist
- `POST /trades` does NOT exist (no fallback when CE was matched to a mount)

### case 9 — nested router.use(subPrefix, subRouter)

```js
// /tmp/.../sub.js
const sub = require('express').Router();
sub.get('/list', h);
module.exports = sub;

// /tmp/.../parent.js
const parent = require('express').Router();
parent.get('/me', h);
parent.use('/items', require('./sub'));
module.exports = parent;

// /tmp/.../app.js
app.use('/api', require('./parent'));
```

Assert: `GET /api/me`, `GET /api/items/list`. Both bare paths absent.

### case 10 — inline same-file Router with mount

```js
const app = require('express')();
const r = require('express').Router();
r.get('/x', h);
app.use('/y', r);
```

Assert: `GET /y/x` exists. `GET /x` does NOT.

### case 11 — default export, mounted

```js
// sub.ts
import { Router } from 'express';
const router = Router();
router.get('/foo', h);
export default router;

// app.ts
import sub from './sub.js';
app.use('/api', sub);
```

Assert: `GET /api/foo`.

### case 12 — named export with rename

```js
// sub.js
const r = require('express').Router();
r.delete('/x', h);
module.exports = { mcpRouter: r };

// app.js
const { mcpRouter } = require('./sub');
app.use('/mcp', mcpRouter);
```

Assert: `DELETE /mcp/x`.

### case 13 — re-export barrel (TraiderJo's exact shape)

```js
// moneybot/routes.js
const router = require('express').Router();
router.post('/summaries/daily', h);
module.exports = router;

// moneybot/index.js — barrel
module.exports = { moneybotRouter: require('./routes') };

// app.js
const { moneybotRouter } = require('./moneybot');
app.use('/api/v1', moneybotRouter);
```

ESM variant (also test):

```js
// moneybot/index.js
export { default as moneybotRouter } from './routes.js';
```

Assert in both: `POST /api/v1/summaries/daily`.

### case 14 — same router mounted twice under different prefixes

```js
const r = require('express').Router();
r.get('/ping', h);
app.use('/v1', r);
app.use('/v2', r);
```

Assert: BOTH `GET /v1/ping` AND `GET /v2/ping` exist. The same source line
produces two ToolMeta entries. Tool naming dedupe is the existing
`nameCounts`-based suffixing — no change required.

### case 15 — mount with no prefix

```js
const r = require('express').Router();
r.get('/raw', h);
app.use(r);
```

Assert: `GET /raw` exists. (No prefix to apply; treated as `''`.)

### case 16 — circular re-export (cycle safety)

```js
// a.js
module.exports = require('./b');
// b.js
module.exports = require('./a');
// app.js
app.use('/x', require('./a'));
```

Assert: extraction completes without throwing. No routes added under `/x` are
acceptable; the test asserts `extractExpressRoutes(dir)` resolves and returns
an array (empty or otherwise) — i.e. **does not infinite-loop or crash**.

### case 17 — unresolved bare-import mount (negative)

```js
const r = require('some-third-party-lib');  // un-chaseable
app.use('/v1', r);
```

Assert: no routes are added under `/v1` (extractor cannot resolve), AND no
`/v1`-prefixed entries appear from random other files (i.e. no aliasing
across unrelated routers).

### case 18 — flat top-level routes still work (regression)

Re-run the existing `app.post('/users', ...)` fixture. Assert routes are
emitted unchanged (the bare-fallback path covers files where no mount was
detected).

---

## 5. Fixture Extension

### 5.1 Add a multi-router fixture mirroring TraiderJo

New layout under `/root/SurfaceMCP/fixtures/express-app-mounted/`:

```
package.json
MUST_DISCOVER.json
src/
  app.ts                # mounts moneybot under /api/v1, mcp under /mcp
  moneybot/
    index.ts            # re-exports default as moneybotRouter
    routes.ts           # router.get/post for /trades, /summaries/daily, /health
  mcp/
    http.ts             # named export mcpRouter; has router.use('/sub', subRouter)
    sub.ts              # subRouter.get('/list')
```

`src/moneybot/routes.ts`:

```ts
import { Router } from 'express';
const router = Router();
router.get('/health', (_req, res) => res.json({ ok: true }));
router.post('/trades', (req, res) => res.json({}));
router.post('/trades/batch', (req, res) => res.json({}));
router.get('/trades/:trade_id', (req, res) => res.json({}));
router.post('/summaries/daily', (req, res) => res.json({}));
export default router;
```

`src/moneybot/index.ts`:

```ts
export { default as moneybotRouter } from './routes.js';
```

`src/mcp/sub.ts`:

```ts
import { Router } from 'express';
const subRouter = Router();
subRouter.get('/list', (_req, res) => res.json([]));
export { subRouter };
```

`src/mcp/http.ts`:

```ts
import express from 'express';
import { subRouter } from './sub.js';
const router = express.Router();
router.post('/', (_req, res) => res.json({}));
router.get('/', (_req, res) => res.json({}));
router.delete('/', (_req, res) => res.json({}));
router.use('/sub', subRouter);
export { router as mcpRouter };
```

`src/app.ts`:

```ts
import express from 'express';
import { moneybotRouter } from './moneybot/index.js';
import { mcpRouter } from './mcp/http.js';
const app = express();
app.use(express.json());
app.use('/api/v1', moneybotRouter);
app.use('/mcp', mcpRouter);
export { app };
```

`MUST_DISCOVER.json`:

```json
{
  "routes": [
    "GET /api/v1/health",
    "POST /api/v1/trades",
    "POST /api/v1/trades/batch",
    "GET /api/v1/trades/:trade_id",
    "POST /api/v1/summaries/daily",
    "POST /mcp/",
    "GET /mcp/",
    "DELETE /mcp/",
    "GET /mcp/sub/list"
  ],
  "mustNotContain": [
    "GET /health",
    "POST /trades",
    "POST /trades/batch",
    "GET /trades/:trade_id",
    "POST /summaries/daily",
    "GET /sub/list",
    "POST /",
    "GET /",
    "DELETE /"
  ]
}
```

Note: `POST /mcp/` (trailing slash from the literal `'/'`) is the correct
joined output of `joinPath('/mcp', '/')`. Per Section 3.4 we collapse to
`/mcp`. Update fixture expectation to `POST /mcp` (no trailing slash) and
make `joinPath` deterministic on this case.

**Final corrected MUST_DISCOVER.routes:**

```json
{
  "routes": [
    "GET /api/v1/health",
    "POST /api/v1/trades",
    "POST /api/v1/trades/batch",
    "GET /api/v1/trades/:trade_id",
    "POST /api/v1/summaries/daily",
    "POST /mcp",
    "GET /mcp",
    "DELETE /mcp",
    "GET /mcp/sub/list"
  ],
  "mustNotContain": [
    "GET /health",
    "POST /trades",
    "POST /trades/batch",
    "GET /trades/:trade_id",
    "POST /summaries/daily",
    "GET /sub/list",
    "POST /",
    "GET /",
    "DELETE /"
  ]
}
```

### 5.2 Existing `fixtures/express-app/` — no behavioral change

The existing fixture has only `app.METHOD(...)` calls (no mounts). The
fallback branch in Step D (route 3.2) emits them unchanged. Existing
`MUST_DISCOVER.json` continues to pass.

### 5.3 Fixture-level test runner

A test (`fixtures/express-app-mounted/fixture.test.ts` — colocated, NOT
inside `src/`) loads the fixture via `extractExpressRoutes(absDir)`, asserts
every `routes[]` entry is present and every `mustNotContain[]` entry is
absent.

---

## 6. Risks

### 6.1 TraiderJo `app.post('/api/v1/...', limiterOnly)` shadow registrations

`/tmp/TraiderJo/server/src/index.js` lines 589–592 register four rate-limiter
middleware-only handlers at `/api/v1/trades`, `/api/v1/trades/batch`,
`/api/v1/trades/:trade_id`, `/api/v1/summaries/daily`. The current extractor
already surfaces these as routes. After the fix, the same paths will also be
emitted from the mounted-router walk.

**Behavior**: two `RouteCall` entries with identical method + path but
different `sourceFile`/`sourceLine`. The existing tool-name dedupe
(`nameCounts`) handles the collision by suffixing the second tool name
(`post_api_v1_trades_2`). Acceptable for now. **Future cleanup** (out of
scope for this spec): de-duplicate by `(method, normalizedPath)` and
prefer the entry with the richer schema confidence. Track in
`SPEC_CRAWL_SEED.md`-style follow-up.

### 6.2 Multiple mounts of the same router

Spec'd in case 14. Each mount produces an independent ToolMeta; the
`secondaryPrefixes` map ensures the same call node emits N routes (one per
mount). Tool-name suffixing handles collision-free naming.

### 6.3 Fallback (un-mounted) routes still emit

Files like the existing `express-app` fixture have no `app.use(...)` mount
anywhere. Their `app.METHOD` calls do NOT enter `prefixByCallNode`, so they
fall through to the bare-emit branch (Step D else clause). All seven
existing tests pass unchanged.

What about `router.METHOD` calls that we **could not** match to any mount
(e.g. router file is built but never wired up, or wired via an unresolvable
expression)? They currently surface as bare paths. After the fix, they STILL
surface as bare paths via the fallback branch. This preserves backwards
compatibility but does mean BugHunter might still probe a stale URL on a
genuinely-unmounted router. Risk accepted: this matches today's behavior, no
regression.

### 6.4 Cycle handling correctness

Cases 16 covers re-export cycles. Implementer must also confirm the
ts-morph `Project` itself does not eagerly resolve and crash on
self-referential modules. Mitigation: `Project({ useInMemoryFileSystem:
false, skipFileDependencyResolution: true })`. (TS-morph's
`addSourceFileAtPath` is already opt-in per file in current code.)

### 6.5 Performance

A mid-size project may have hundreds of files. Building `imports`/
`exportMap`/`reexportMap` for every file is O(N). Walking is O(M) over
mount edges. Acceptable. The current `extractExpressRoutes` already
re-instantiates a `Project` per file in `extractRoutesFromFile` — that is
wasteful. **Refactor as part of this work**: instantiate one `Project`
across the whole `extractExpressRoutes` call, add all files once, then run
both Step A (per-file scan) and Steps B–D over those SourceFile instances.
This is a net perf win, not a regression.

### 6.6 `.js` extension in ESM imports

TraiderJo writes `import ... from './routes.js'` even though the file is
ESM JS. The path resolver (Section 3.3) tries the literal first — passes.
TS source files written as `from './routes.js'` (NodeNext-style) also pass
because step 2 falls through to the `.ts` candidate when `.js` does not
exist on disk. Verified pattern.

---

## 7. Acceptance Criteria

A1. **All existing express tests pass** unchanged: `npx vitest run
src/extract/express/static.test.ts` reports 7+ existing cases green plus 11
new cases (cases 8–18) green. Zero regressions in
`src/extract/express/schema-scope.test.ts`, if it exists.

A2. **Existing `fixtures/express-app` MUST_DISCOVER passes** without changes
to its JSON.

A3. **New `fixtures/express-app-mounted` MUST_DISCOVER passes exactly** —
every `routes[]` entry emitted, every `mustNotContain[]` entry absent.

A4. **TraiderJo re-smoke**:
   - Restart the TraiderJo SurfaceMCP instance (port 3103) after rebuilding
     SurfaceMCP from `spec/router-mounts` branch.
   - `surface_list_tools` returns total tools >= the previous 252 count
     (mounted-router routes are added; some duplicates may collapse via the
     tool-name suffixing — net should be >= 252, likely 252 + 4 unique mcp
     routes = 256; the four existing ghost limiter-only `/api/v1/*`
     entries become real-handler duplicates, naming-suffixed).
   - At minimum these new entries MUST exist:
     - `GET /api/v1/health`
     - `POST /mcp` (with method POST)
     - `GET /mcp`
     - `DELETE /mcp`
   - These flat (wrong) entries MUST NOT exist:
     - `POST /summaries/daily` (only `/api/v1/summaries/daily` should remain)
     - `POST /trades/batch` (only `/api/v1/trades/batch`)
     - `GET /trades/:trade_id` from `moneybot/routes.js`
     - `POST /` from `mcp/http.js`

A5. **BugHunt clusters resolved**: A re-run of `/bughunt scan` against
TraiderJo no longer produces `network_4xx_unexpected` clusters at
`POST /summaries/daily` or `POST /trades/batch`. (BugHunter probes the
correctly-prefixed URLs; the legitimate auth/CSRF response is now matched
to a real handler and no longer flagged as unexpected 4xx.)

A6. **No new dependency added**. ts-morph remains the only AST library.
No `eslint-disable`, no `as any`, no implicit-return exports, max 40 lines
per function in new code.

A7. **Type discipline**: every public function in
`src/extract/express/mounts.ts` has explicit return type annotations. No
`any`. `unknown` narrowed at boundaries.

A8. **Cycle safety**: case 16 completes within 2 seconds (test timeout
default 5s) without OOM or hang.

---

## 8. Files to Touch

### Create

- `src/extract/express/mounts.ts` (new module: per-file scan, Resolve(),
  walkMountedRouter(), seed scan, returns `Map<CallExpression, string[]>`
  of prefixes per call node)
- `src/extract/express/mounts.test.ts` (focused unit tests for
  `joinPath`, `resolvePath`, `Resolve()` cycle behavior — these complement
  but do not duplicate the integration cases in `static.test.ts`)
- `fixtures/express-app-mounted/package.json`
- `fixtures/express-app-mounted/MUST_DISCOVER.json`
- `fixtures/express-app-mounted/src/app.ts`
- `fixtures/express-app-mounted/src/moneybot/index.ts`
- `fixtures/express-app-mounted/src/moneybot/routes.ts`
- `fixtures/express-app-mounted/src/mcp/http.ts`
- `fixtures/express-app-mounted/src/mcp/sub.ts`
- `fixtures/express-app-mounted/fixture.test.ts` (loads via
  `extractExpressRoutes`, asserts MUST_DISCOVER)

### Modify

- `src/extract/express/static.ts`:
  1. Refactor to instantiate ONE `Project` per `extractExpressRoutes` call
     (not per file).
  2. Call `buildMountIndex(project)` from `mounts.ts` to populate
     `prefixByCallNode` + `secondaryPrefixes`.
  3. In the route-emit loop, for each matched `<x>.METHOD` CallExpression,
     look up its prefix(es); if any, emit one ResolvedRoute per prefix; if
     none, emit bare (current behavior).
- `src/extract/express/static.test.ts`: append cases 8–18.

### Do not touch

- `src/extract/express/schema-scope.ts` (schema resolution is orthogonal —
  the prefixed path does not affect zod schema lookup; the schema scope
  follows the CallExpression's local file)
- Any non-Express extractor.
- `package.json` deps.

---

## 9. Open Questions

None blocking. Implementer notes:

- **Q9.1** (cosmetic): should `joinPath('/mcp', '/')` return `/mcp` or
  `/mcp/`? Spec says `/mcp` (Section 3.4). Express itself treats them
  identically when matching, so the canonical form is `/mcp`. Confirm at
  implementation.
- **Q9.2** (deferred): should we eventually de-duplicate `(method, path)`
  pairs across the whole project, preferring the entry with the higher
  `inputSchemaConfidence`? Out of scope — track separately. The current
  `nameCounts` suffixing keeps tool names unique, which is the only
  hard requirement.
