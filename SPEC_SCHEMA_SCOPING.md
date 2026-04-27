# SPEC: Scope inputSchema to the route that actually validates the body

Status: ready-to-implement
Owner: @architect
Implementer: @coder (single PR)
Branch: `spec/schema-scoping`

---

## 1. Problem

The Express extractor (`src/extract/express/static.ts`) currently attaches an `inputSchema` to a route by calling `tryImportZodSchema(route.sourceFile)` once per route, with **only the source file path** as input. The function then walks the *whole file* looking for any `<ident>.parse(...)` or `<ident>.safeParse(...)` call and returns the *first* Zod schema it can resolve from that file.

For Next.js App Router this is harmless — each route handler lives in its own `route.ts` file, so "first schema in file" == "schema for this route". For Express, where one file frequently declares dozens or hundreds of routes via `app.get(...)`, `app.post(...)`, etc., this causes every route in the file to be stamped with the **same** schema.

### Concrete evidence — TraiderJo cluster `op5dlqbd2rnwnmwdr2gyflqa`

Run: `kegmchs2c787z2ubuaew4vek` (BugHunter on TraiderJo).

- File: `/tmp/TraiderJo/server/src/index.js` (9 282 lines, ≈ 252 routes).
- The first Zod schema that `extractZodSchema` can resolve in that file is the trade-creation schema referenced by line 3547:

  ```js
  app.post('/trades', auth, freeReadonlyGate, actorTradeLimiter,
           validateBody(schemas.tradeCreation), async (req, res) => { ... });
  ```

- Route under investigation (line 1168):

  ```js
  app.get('/auth/oauth/google/start', authLimiter, (req, res) => { ... });
  ```

  This is a `GET` with no body and no `validateBody` middleware. It cannot accept a JSON body.
- Outcome: SurfaceMCP stamped the trade-creation `inputSchema` onto the OAuth GET route. The smoke probe then mutated trade-shaped fields against `GET /auth/oauth/google/start`, which (combined with an unrelated 501) surfaced as a `network_5xx` cluster. **The cluster is a discovery artifact, not an app bug.**

The same misattribution is silently affecting an unknown number of other routes in TraiderJo and likely every other Express project of meaningful size. Routes that *should* report `inputSchemaConfidence: 'unknown'` are reporting `'introspected'` against an arbitrary, unrelated schema, and BugHunter's mutation engine then bombards them with mutated palette variants (`null`, `edge`, `out_of_bounds`) instead of the single happy-path call that `unknown` would trigger (`packages/cli/src/mutation/apply.ts:46`).

---

## 2. Root cause (verified)

### 2.1 `static.ts` calls a file-scoped extractor per route

`/root/SurfaceMCP/src/extract/express/static.ts:120-139`

```ts
for (const route of rawRoutes) {
  const { schema, confidence } = await tryImportZodSchema(route.sourceFile, zodAlias);
  ...
  tools.push({
    ...
    inputSchema: schema,
    inputSchemaConfidence: confidence,
    ...
  });
}
```

The route loop passes only `route.sourceFile`. The extractor has no way to know **which** route within the file is being processed.

### 2.2 `tryImportZodSchema` falls back to "first schema anywhere in the file"

`/root/SurfaceMCP/src/extract/nextjs/schemas.ts:443-470`

```ts
export async function tryImportZodSchema(filePath, zodAlias = 'z'): Promise<SchemaResult> {
  try {
    const mod = await import(filePath);                     // (a) runtime import
    const schemaNames = ['schema', 'bodySchema', 'inputSchema', 'requestSchema', 'Schema'];
    for (const name of schemaNames) {
      const candidate = mod[name];
      if (candidate && ... '_def' in candidate ...) {
        return { schema: zodSchemaToJsonSchema(candidate), confidence: 'introspected' };
      }
    }
  } catch { /* fall through */ }

  try {
    const sf = project.addSourceFileAtPath(filePath);
    return extractZodSchema(sf, zodAlias);                   // (b) AST scan
  } catch {
    return { schema: UNKNOWN_SCHEMA, confidence: 'unknown' };
  }
}
```

`extractZodSchema` (same file, lines 17-36) iterates every `CallExpression` in the source file looking for `*.parse(*)` / `*.safeParse(*)` and returns the first one it can resolve. **No association with any specific route is performed.** This is the misattribution.

### 2.3 Why GET routes get a body schema

The Express extractor doesn't gate schema lookup on HTTP method. The same file-scoped lookup is run for `GET`, `HEAD`, `OPTIONS` — methods that by HTTP semantics do not carry a body — so they too inherit whatever schema happens to be first in the file.

### 2.4 Other stacks — investigated, scope-bounded

| Stack    | File                                      | Affected? | Reason                                                                                  |
|----------|-------------------------------------------|-----------|------------------------------------------------------------------------------------------|
| Next.js  | `src/extract/nextjs/routes.ts`            | No        | One handler file per route (App Router `route.ts`, Pages Router `[name].ts`). File-scoped == route-scoped. |
| FastAPI  | `src/extract/fastapi/openapi-fetch.ts`    | No        | Per-operation `requestBody` from OpenAPI spec (lines 54-84). Already correctly scoped.  |
| Django   | `src/extract/django/ast-walk.ts`          | No        | Always emits `inputSchemaConfidence: 'unknown'` (line 256). No schema introspection.    |
| OpenAPI  | `src/extract/openapi/parse.ts`            | No        | Same per-operation model as FastAPI.                                                     |
| Vite     | n/a                                       | No        | Client-only stack; no API routes extracted.                                              |
| Express  | `src/extract/express/static.ts`           | **Yes**   | Many routes per file. Bug described above.                                               |

The fix is therefore **strictly scoped to the Express extractor and to the export shape of the schema-extraction helpers**. No other stack changes behaviour.

---

## 3. Fix design

### 3.1 Goal

For each Express route, attach an `inputSchema` only when SurfaceMCP can identify a Zod schema that is *referenced by middleware or `.parse`/`.safeParse` calls inside that specific route's handler chain*. For every other route, emit `inputSchemaConfidence: 'unknown'` with the permissive `{ type: 'object', additionalProperties: true }` schema.

### 3.2 Recognised patterns (authoritative list — implementer follows exactly)

For a route `app.<method>(<path>, ...handlers)` declared at AST node `routeCall`, a schema is *route-scoped* when **at least one** of the following is true:

| # | Pattern                                                     | Example (TraiderJo)                                                                              | Schema source                                                  |
|---|-------------------------------------------------------------|--------------------------------------------------------------------------------------------------|----------------------------------------------------------------|
| A | `validateBody(<schemaRef>)` middleware in the route's args  | `app.post('/auth/register', authLimiter, validateBody(schemas.userRegistration), handler)`       | `<schemaRef>` (resolved as below)                              |
| B | `<schemaRef>.parse(...)` or `<schemaRef>.safeParse(...)` called *inside* the route's handler function body | line 8784: `const parsed = schema.safeParse(req.body);` inside `app.post('/api/nl-trade-entry/record', ...)` | `<schemaRef>`                                                  |
| C | A `Schema = z.object({...})` (or chain) declared *inside* the route's handler body and used in pattern B | line 8778-8784 (block scope inside the handler)                                                  | The locally-declared schema                                    |

If none of A/B/C match, the route gets `inputSchemaConfidence: 'unknown'` and `inputSchema: { type: 'object', additionalProperties: true }`.

### 3.3 Schema-reference resolution (how `<schemaRef>` becomes JSON Schema)

When a `<schemaRef>` is found in patterns A/B, resolve it in this order, stopping at the first hit:

1. **Local declaration** — `<schemaRef>` is an identifier declared inside the same route handler (covers pattern C).
2. **File-level declaration** — top-level `const <name> = z.object({...})` or `const <name> = z.<chain>(...)` in the same source file. Use existing `tryResolveZodSchema` in `schemas.ts`.
3. **Member access on an imported namespace** — e.g. `schemas.userRegistration` where `schemas` is imported from `'./validation.js'`. Strategy: dynamic-import that module if possible (existing `tryImportZodSchema` runtime path) and look up the property; fall back to AST scan of the imported file for `export const schemas = { userRegistration: z.object({...}) }` or `export const userRegistrationSchema = ...`.
4. **Otherwise** — confidence `'inferred'` if SurfaceMCP found a `validateBody(...)` call but could not resolve the referenced schema (we still know the route validates *something*, just not what); schema is the permissive object.

Discriminated outcome shape for schema resolution:

```ts
type ResolvedSchema =
  | { kind: 'introspected'; schema: JsonSchema2020 }      // pattern A or B with full resolution
  | { kind: 'inferred';     schema: JsonSchema2020 }      // pattern A/B but schema variable could not be resolved
  | { kind: 'unknown'    ;  schema: JsonSchema2020 };     // patterns A/B/C all absent
```

`kind` maps 1:1 to `inputSchemaConfidence` (`introspected` | `inferred` | `unknown`). Note `partial` is **not** emitted by the Express extractor — that confidence level is reserved for Next.js manual-validation recovery.

### 3.4 AST traversal — exact algorithm (ts-morph)

In `extractRoutesFromFile` (or a new helper next to it), for each detected route `CallExpression` (the `app.<method>(...)` call):

1. **Locate the handler chain**.
   `args = routeCall.getArguments()` — already extracted. The first arg is the path. The last arg is conventionally the route handler. Middlewares are arguments in between.
2. **Method gate**.
   If method is one of `GET | HEAD | OPTIONS`, skip schema search entirely; mark `unknown`. (HTTP semantics — these methods have no request body. Express *can* accept a body here, but the smoke palette has no business sending one.)
3. **Pattern A — middleware scan**.
   Iterate args[1..end-1]. For each arg, check whether it is a `CallExpression` whose callee name is `validateBody` (configurable — see §5). If yes, capture the first argument as `schemaRef`.
4. **Pattern B/C — handler-body scan**.
   Take the last arg. If it is an `ArrowFunction` or `FunctionExpression`, walk its descendant `CallExpression`s and look for `<expr>.parse(*)` or `<expr>.safeParse(*)` where the LHS-of-`.parse` is an `Identifier` or `PropertyAccessExpression`. Capture as `schemaRef`. (Restrict the walk to descendants of the handler node — do **not** leave the handler — that is the entire point of the fix.)
5. **Resolve `schemaRef`** per §3.3.
6. **Emit ToolMeta** with the resolved schema and the corresponding confidence.

### 3.5 Why method-gating is correct

Express GET handlers can technically read `req.body` if the client sets `Content-Type: application/json` and the request has a body. In practice no Express GET handler ever validates body fields with Zod — and even if it did, sending a JSON body to a `GET` is a protocol-level oddity that the smoke palette is not designed to probe. Gating on method is safe and matches BugHunter's mutation expectations.

### 3.6 Configurable middleware names

Default-allowed middleware identifiers that mark "this route validates the body":

```
validateBody, validate, zValidate, zodValidate, validateRequest
```

Config knob: `surfaceConfig.schemaIntrospection.bodyValidatorNames?: string[]` (extend, not replace, the default list). Already wired through the chain via `SurfaceConfig.schemaIntrospection` (`src/types.ts:155-159`).

---

## 4. Confidence labelling — post-fix matrix

| Stack    | Condition                                                                         | `inputSchemaConfidence` |
|----------|-----------------------------------------------------------------------------------|--------------------------|
| Express  | Method ∈ {GET, HEAD, OPTIONS}                                                     | `unknown`                |
| Express  | Pattern A or B matched, schema fully resolved (zod-to-json-schema or text-parse)  | `introspected`           |
| Express  | Pattern A matched, schema reference unresolved                                    | `inferred`               |
| Express  | No A/B/C match                                                                    | `unknown`                |
| Next.js  | (unchanged) Zod schema in file                                                    | `introspected` / `inferred` |
| Next.js  | (unchanged) Manual if-guard validation                                            | `partial`                 |
| Next.js  | (unchanged) None of the above                                                     | `unknown`                 |
| FastAPI  | (unchanged) `requestBody` in OpenAPI op                                           | `introspected`            |
| FastAPI  | (unchanged) Query params present                                                  | `introspected`            |
| FastAPI  | (unchanged) Otherwise                                                             | `unknown`                 |
| Django   | (unchanged) Always                                                                | `unknown`                 |

---

## 5. Tests

All tests live under `/root/SurfaceMCP`. Run with `npm test`.

### 5.1 New unit tests — `src/extract/express/static.test.ts` (CREATE)

Use `Project({ useInMemoryFileSystem: true })` for inline source. Assert against the public output of `extractExpressRoutes` with a temp directory (use `tmpdir()` + `writeFileSync`, mirroring `schemas.test.ts:134-175`).

Cases (each must pass):

1. **Mixed validateBody — only validated routes get schemas.**
   Fixture: one file with two routes:
   ```js
   const userSchema = z.object({ name: z.string(), age: z.number() });
   app.post('/users', validateBody(userSchema), handler);
   app.get('/health', handler);
   ```
   Expected:
   - `POST /users` → `inputSchemaConfidence === 'introspected'`, `inputSchema.properties.name` defined.
   - `GET /health`  → `inputSchemaConfidence === 'unknown'`, `inputSchema === { type:'object', additionalProperties:true }`.

2. **GET-with-`:id` does NOT inherit body schema (TraiderJo regression).**
   ```js
   const tradeSchema = z.object({ symbol: z.string() });
   app.post('/trades', validateBody(tradeSchema), handler);
   app.get('/auth/oauth/google/start', handler);
   ```
   Expected: `GET /auth/oauth/google/start` → `unknown`. `POST /trades` → `introspected`.

3. **Inline safeParse inside the handler (pattern B/C).**
   ```js
   app.post('/api/nl-trade-entry/record', auth, async (req, res) => {
     const schema = z.object({ accountId: z.string() });
     const parsed = schema.safeParse(req.body);
     ...
   });
   ```
   Expected: `POST /api/nl-trade-entry/record` → `introspected`, schema has `accountId`.

4. **`validateBody` with unresolved member access → inferred.**
   ```js
   import { schemas } from './does-not-exist.js';
   app.post('/foo', validateBody(schemas.somethingWeCannotResolve), handler);
   ```
   Expected: `POST /foo` → `inferred`, permissive schema.

5. **Two routes in same file referencing different `schemas.*` keys.**
   When `validation.js` is present and importable, `schemas.userRegistration` and `schemas.tradeCreation` resolve to distinct schemas. Assert each route gets its *own* schema (no cross-contamination). This is the core regression that started the spec.

6. **HEAD and OPTIONS routes are always unknown** even if a `validateBody` is somehow present.

7. **Configurable middleware name.**
   With `bodyValidatorNames: ['zValidate']` extending the defaults, `app.post('/x', zValidate(s), handler)` produces a route with the schema.

### 5.2 Update existing fixture: `fixtures/express-app/src/app.ts`

Current state (verified `2026-04-27`):
```ts
const productSchema = z.object({...});
app.get('/api/products', ...);                    // currently mis-stamped with productSchema
app.post('/api/products', (req, res) => {
  const parsed = productSchema.parse(req.body);   // pattern B
});
app.get('/api/products/:id', ...);                // currently mis-stamped
app.put('/api/products/:id', (req, res) => {
  const parsed = productSchema.partial().parse(...);  // pattern B
});
app.delete('/api/products/:id', ...);             // currently mis-stamped
```

After fix, expected confidences:

| Route                         | Pre-fix    | Post-fix       | Reason                          |
|-------------------------------|------------|----------------|---------------------------------|
| `GET /api/products`           | introspected | **unknown**  | GET method                      |
| `POST /api/products`          | introspected | introspected | pattern B                       |
| `GET /api/products/:id`       | introspected | **unknown**  | GET method                      |
| `PUT /api/products/:id`       | introspected | introspected | pattern B                       |
| `DELETE /api/products/:id`    | introspected | **unknown**  | DELETE has no body validation  |

Add a new test in `extract.test.ts` under `describe('express route extraction', ...)`:

```ts
it('scopes inputSchema to routes that validate the body', async () => {
  const root = resolve(FIXTURES, 'express-app');
  const tools = await extractExpressRoutes(root);
  const get  = tools.find(t => t.method === 'GET'    && t.path === '/api/products');
  const post = tools.find(t => t.method === 'POST'   && t.path === '/api/products');
  const put  = tools.find(t => t.method === 'PUT'    && t.path === '/api/products/:id');
  const del  = tools.find(t => t.method === 'DELETE' && t.path === '/api/products/:id');
  expect(get!.inputSchemaConfidence).toBe('unknown');
  expect(post!.inputSchemaConfidence).toBe('introspected');
  expect(post!.inputSchema.properties?.name).toBeDefined();
  expect(put!.inputSchemaConfidence).toBe('introspected');
  expect(del!.inputSchemaConfidence).toBe('unknown');
});
```

Existing `discovers all must-discover routes` test stays green — only confidence changes, route count is identical.

### 5.3 nextjs-monorepo express fixture

`fixtures/nextjs-monorepo/apps/api/src/index.ts` has no Zod usage at all. Pre-fix and post-fix both emit `unknown` for both routes. No change needed; existing test stays green.

### 5.4 Other stacks

No fixture changes. Run the full `extract.test.ts` suite to confirm `nextjs-app`, `django-app`, `fastapi-app`, `nextjs-monorepo` (Next.js side) tests are all unchanged.

---

## 6. Risk

### 6.1 Fixture relying on buggy behaviour
`fixtures/express-app` currently relies on the bug — its `MUST_DISCOVER.json` is route-list-only (no schema-confidence asserts), so the existing tests will continue to pass. The only change required is the new test in §5.2. **No green test will break.**

### 6.2 Real projects whose smoke runs depend on the bug
TraiderJo and similar Express projects will see fewer mutated palette calls per smoke run because more routes will be `unknown` (single happy-path call only). This is **the desired outcome** — it suppresses the false-positive cluster. Tool count is unchanged (route discovery is independent of schema scoping); only the schema attached to each tool changes.

### 6.3 Unresolved-schema regressions
If pattern A's `validateBody(schemas.X)` cannot be resolved (e.g. dynamic import fails, target module is in a TS path that ts-morph cannot follow), we fall back to `inferred` rather than the previous `introspected` against an unrelated schema. This is strictly better — `inferred` triggers the smoke palette but with a permissive schema, while the old behaviour sent fields from a wrong schema.

### 6.4 Performance
Per-route AST walk vs current per-file. Each `index.js`-shaped file (~9 k lines, ~250 routes) means roughly 250 handler-scoped walks. Each handler is small (≤ ~80 lines on average), and the existing extractor already walks every CallExpression in the file once. Net cost: O(routes × handler-size) ≈ O(file-size) in the worst case — same order as today. No new per-file project builds (reuse the `Project` instance from `extractRoutesFromFile`).

### 6.5 ts-morph dependency
Already in use throughout the extractor; no new dep.

---

## 7. Acceptance criteria

A PR satisfies this spec when **all** of the following hold:

1. `cd /root/SurfaceMCP && npm test` exits with status 0. All existing tests in `src/extract/extract.test.ts`, `src/extract/nextjs/schemas.test.ts`, FastAPI/OpenAPI/Django/Next.js suites pass unchanged.
2. New `src/extract/express/static.test.ts` exists with cases §5.1.1 through §5.1.7. All pass.
3. New assertion in `extract.test.ts` (§5.2) passes.
4. Re-running BugHunter against TraiderJo on the same revision produces:
   - `GET /auth/oauth/google/start` → `inputSchemaConfidence: 'unknown'`, `inputSchema: { type:'object', additionalProperties:true }`.
   - `POST /trades` → `inputSchemaConfidence: 'introspected'` with the trade-creation schema (`symbol`, `entryPrice`, etc.).
   - `POST /auth/register` → `introspected` with the user-registration schema (`email`, `password`, etc.).
   - **No** route receives a schema whose fields it does not actually validate.
5. TraiderJo total tool count from `extractExpressRoutes` is unchanged (±0 — route detection is orthogonal to this fix). Acceptance band: ±5 tools (parser-AST corner cases). Measured via `npx tsx -e 'import("/root/SurfaceMCP/dist/extract/express/static.js").then(m=>m.extractExpressRoutes("/tmp/TraiderJo/server").then(t=>console.log(t.length)))'` before vs after.
6. `npx tsc --noEmit` passes with zero errors.
7. `npx eslint . --max-warnings 0` passes.
8. No new runtime dependencies added to `package.json`. ts-morph and zod-to-json-schema are already present.
9. No `any` introduced. No silent `catch` blocks. All catches log via existing `log` module or transform/return a discriminated result.

---

## 8. Files to touch

### Modify

- `src/extract/express/static.ts` — replace the per-route `tryImportZodSchema(route.sourceFile)` call with the new route-scoped resolver. Keep the existing route-discovery loop intact. Refactor the per-route loop to:
  1. Capture the route's `CallExpression` AST node alongside `method/path/sourceLine` in `RouteCall` (add `callNode: CallExpression` field — confined to extractor internals; not part of `ToolMeta`).
  2. After route discovery, run the new `resolveRouteSchema(callNode, sourceFile, sf, project, config)` helper for each route.

- `src/extract/nextjs/schemas.ts` — extend, do not break:
  - Add a new exported function `extractZodSchemaForNode(node: Node, sf: SourceFile, zodAlias?: string): SchemaResult` that takes an arbitrary AST node (e.g. a route's handler `ArrowFunction`) and runs the existing `extractZodSchema` logic but constrained to descendants of `node`. Implementation: copy the body of `extractZodSchema` but iterate `node.getDescendantsOfKind(SyntaxKind.CallExpression)` instead of `sf.getDescendantsOfKind(...)`.
  - Add `tryResolveSchemaIdentifier(identifier: Node, sf: SourceFile, zodAlias?: string): SchemaResult` that handles the four resolution steps from §3.3 (local → file-level → imported namespace member → unresolved/inferred).
  - Existing `tryImportZodSchema` and `extractZodSchema` keep their signatures and behaviour — Next.js routes continue to use them unchanged.

- `fixtures/express-app/MUST_DISCOVER.json` — **no change** (route list only).

### Create

- `src/extract/express/static.test.ts` — §5.1.

- `src/extract/express/schema-scope.ts` — new internal module:

  ```ts
  export function resolveRouteSchema(
    routeCall: CallExpression,
    sourceFile: SourceFile,
    project: Project,
    method: string,
    config?: { bodyValidatorNames?: string[] }
  ): { schema: JsonSchema2020; confidence: InputSchemaConfidence };
  ```

  Implements the algorithm in §3.4. Roughly 120-180 lines including the middleware-name matcher and the four-step identifier resolver. Pulls helpers from `nextjs/schemas.ts`.

  Default middleware list constant (single source of truth):

  ```ts
  export const DEFAULT_BODY_VALIDATOR_NAMES = [
    'validateBody', 'validate', 'zValidate', 'zodValidate', 'validateRequest',
  ] as const;
  ```

### Do NOT touch

- Any file under `src/extract/django/`, `src/extract/fastapi/`, `src/extract/openapi/`, `src/extract/vite/`, `src/extract/nextjs/routes.ts`, `src/extract/nextjs/server-actions*.ts`, `src/extract/pages/`.
- `src/types.ts` — `InputSchemaConfidence` discriminator already covers the four values needed.
- BugHunter (`/root/BugHunter`) — out of scope; mutation/apply.ts already does the right thing for `unknown`.
- Anything in `src/server/`, `src/auth/`, `src/probe/`, `src/classify/`, `src/samples/`, `src/cli/`, `src/e2e/`, `src/detect/`.

### Negative requirements

- No new runtime dependencies.
- No new top-level files.
- No `any`. No `as unknown as <T>` smuggling.
- Functions in new code: max 40 lines each. Files: max 300 lines.
- Do **not** change any function signature exported from `src/extract/nextjs/schemas.ts`. Only **add** new exports.
- Do **not** introduce a new `InputSchemaConfidence` value.
- Do **not** widen `ToolMeta`. The new `callNode` field stays inside the extractor — it is part of the internal `RouteCall`, not the public `ToolMeta`.

---

## 9. Implementation outline (for @coder, non-binding)

Pseudocode for `resolveRouteSchema`:

```ts
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function resolveRouteSchema(routeCall, sourceFile, project, method, config) {
  if (SAFE_METHODS.has(method.toUpperCase())) return UNKNOWN_RESULT;

  const validatorNames = new Set([
    ...DEFAULT_BODY_VALIDATOR_NAMES,
    ...(config?.bodyValidatorNames ?? []),
  ]);

  // Pattern A: middleware in the args (skip first=path, last=handler)
  const args = routeCall.getArguments();
  for (let i = 1; i < args.length - 1; i++) {
    const arg = args[i];
    if (!Node.isCallExpression(arg)) continue;
    const callee = arg.getExpression();
    const calleeName = Node.isIdentifier(callee) ? callee.getText()
                     : Node.isPropertyAccessExpression(callee) ? callee.getName()
                     : null;
    if (!calleeName || !validatorNames.has(calleeName)) continue;
    const schemaArg = arg.getArguments()[0];
    if (!schemaArg) continue;
    return resolveSchemaRef(schemaArg, sourceFile, project);  // introspected | inferred
  }

  // Pattern B/C: parse/safeParse inside the handler body (last arg)
  const handler = args[args.length - 1];
  if (handler && (Node.isArrowFunction(handler) || Node.isFunctionExpression(handler))) {
    for (const call of handler.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) continue;
      const m = expr.getName();
      if (m !== 'parse' && m !== 'safeParse') continue;
      const lhs = expr.getExpression();
      const resolved = resolveSchemaRef(lhs, sourceFile, project, handler);
      if (resolved.confidence !== 'unknown') return resolved;
    }
  }

  return UNKNOWN_RESULT;
}
```

`resolveSchemaRef` covers §3.3 steps 1-4. Step 1 (local) accepts an optional `scopeNode` — when present, walk only its descendants for variable declarations.

---

## 10. Open questions

None. The spec is implementable end-to-end as written.
