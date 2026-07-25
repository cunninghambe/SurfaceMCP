# SPEC — tRPC stack

Status: implemented (`feat/trpc-stack`). Adds tRPC as the 10th supported stack.

Like GraphQL, tRPC is **not** path-per-operation: a tRPC server mounts one router at a
single HTTP path and addresses each procedure by a **dotted path** appended to it
(`/api/trpc/post.byId`). Every downstream assumption that keys a tool on `method:path`
therefore has to be revisited, exactly as it was for GraphQL — this stack follows that
precedent shape (operation-keyed `toolId`, a per-tool descriptor, a call-path adapter).

What tRPC gives us that no REST stack here does: procedures carry **zod schemas for
both input and output** (`.input(z.object({…}))`, `.output(…)`), declared next to the
handler. Where those schemas resolve statically, a tool ships fully typed I/O.

## Discovery

- **Source:** the router itself — a ts-morph walk of the project's TypeScript, no
  runtime and no import of target code. `src/extract/trpc/router.ts`
  (`extractTrpcRouter`).
- **Detection** (`src/detect/trpc.ts`, `isTrpc`): requires **both**
  1. a direct `@trpc/server` (dev)dependency in `package.json`, and
  2. a source file that actually *builds* a router — an `initTRPC` reference, or a
     `publicProcedure`/`protectedProcedure` binding **and** a
     `router({ … })` / `createTRPCRouter({ … })` call in the same file
     (depth-bounded ≤4 walk, `node_modules`/`dist`/`.next`/… skipped).

  Both signals are required because a Next.js client that merely *consumes* someone
  else's tRPC API routinely lists `@trpc/server` for its `AppRouter` type import. The
  dependency alone would false-positive on every such app; the router source signal is
  what distinguishes a host from a consumer.

### Detection order — tRPC runs FIRST, ahead of `nextjs`

`detect/index.ts` calls `isTrpc` before `isNextjs`. This is a deliberate inversion of
the GraphQL precedent (which sits *after* the framework detectors) and is the one
genuinely contentious decision in this spec.

- **Why.** tRPC is overwhelmingly deployed *inside* a Next.js app (the T3 stack). In
  such an app the entire programmatic surface **is** the tRPC router; the only Next
  route handler is `app/api/trpc/[trpc]/route.ts`, an opaque catch-all adapter.
  Detecting `nextjs` first would surface that single catch-all — one useless tool with
  an unknowable input — instead of every procedure with its zod-typed I/O. Ordering
  tRPC after Next.js would make the stack near-unreachable in practice.
- **Why it is safe.** The detector requires the server dependency *and* a
  router-building source signal, so a Next.js app that only calls a remote tRPC API is
  still classified `nextjs` (pinned by a test), and an app with no `@trpc/server` at
  all is untouched. No existing fixture changes classification.
- **The cost (honest limitation).** A *hybrid* app that hosts a tRPC router **and**
  hand-written REST route handlers is classified `trpc`, and its REST routes are not
  surfaced. Multi-stack-per-root is out of scope repo-wide (the same limitation the
  GraphQL spec records for `@nestjs/graphql` + `@Controller`). The workaround today is
  to declare two surfaces in `surfacemcp.config.json` with an explicit `stack`.

### Root-router selection

A tRPC project declares many routers but mounts exactly one. `pickRootRouter`:

1. Collect every router literal bound to a variable, project-wide, plus every name
   used as a property *value* inside some router literal (i.e. a sub-router).
2. Roots = variable-bound routers never referenced as a sub-router.
3. `appRouter` (the near-universal convention) wins any tie; otherwise ordered by
   (file path, line), so the pick is deterministic.
4. If no router is bound to a variable at all (e.g. `createHTTPServer({ router:
   router({…}) })`), fall back to the outermost router literals — those not nested
   inside another.
5. Candidates are walked best-first and the **first that yields procedures** wins, so a
   same-shaped non-tRPC `router({…})` call can't shadow the real root by sorting
   earlier.

Recognized router constructors: `router(…)`, `t.router(…)`, `createTRPCRouter(…)`
(matched on the callee text, so any `<x>.router(…)` alias works). `createRouter(…)` is
deliberately **not** matched — that is Vue Router's constructor, and it also takes an
object literal; tRPC has no `createRouter({…})` form to lose.

### Procedure recognition

Each property of the root router literal is classified:

- **inline sub-router** (`user: router({ … })`) → recurse with the key as a prefix;
- **sub-router by name** (`post: postRouter`, including a shorthand `{ postRouter }`) →
  resolve the name against the project-wide router map and recurse, so a router
  declared in **another file** composes correctly (the T3 `routers/*.ts` layout).
  Cycle-guarded per branch and depth-capped at `MAX_ROUTER_DEPTH` (8);
- **procedure** (`publicProcedure.use(mw).input(A).output(B).mutation(fn)`) → walk the
  property-access chain outermost → innermost. The outermost `query`/`mutation`/
  `subscription` call names the kind; `.input`/`.output` anywhere in the chain supply
  the schemas; any other link (`.use`, `.meta`, `.concat`) is ignored.

Keys must be identifier-like (`/^[A-Za-z_$][A-Za-z0-9_$]*$/`). The dotted path is
interpolated into the call URL, so an exotic quoted key (`'a/b?x'`) is **skipped**
rather than allowed to inject path or query syntax.

## Procedure → tool mapping

One MCP tool per procedure, keyed by its full dotted path under the mounted root
router. That is how the tRPC HTTP adapter itself dispatches.

| Procedure      | tool `name`                | `method` | `path`     | `sideEffectClass` |
| -------------- | -------------------------- | -------- | ---------- | ----------------- |
| `query`        | `query_<dotted_path>`      | `GET`    | `trpcPath` | `safe`            |
| `mutation`     | `mutation_<dotted_path>`   | `POST`   | `trpcPath` | `mutating`        |
| `subscription` | — (skipped)                | —        | —          | —                 |

- **name:** `procedureToolName` — `<procedureType>_<dotted path with `.`→`_`>`, e.g.
  `query_post_byId`, `mutation_post_create`. Path-based `pathToToolName` cannot express
  this (all procedures share one path), the same reason GraphQL has
  `operationToolName`. Dots become underscores because MCP tool names may not contain
  `.`.
- **method:** `query` → `GET`, `mutation` → `POST`. Not a convention we invented — it
  is how the tRPC HTTP adapter serves them.
- **path:** the configured mount point (`surface.trpcPath`, default `/api/trpc`),
  threaded through `extractRaw` in `tools-meta.ts`.
- **subscriptions are out of scope.** A subscription is a long-lived SSE/WebSocket
  stream, not a request/response call the MCP call surface models. They are recognized
  during the walk and dropped, so they never appear as a dead tool.

### toolId scheme

`toolId` **cannot** be `sha1(method:path)` — every query shares `GET <trpcPath>` and
every mutation `POST <trpcPath>`, which would collapse all queries onto one id and all
mutations onto another. Mirroring the GraphQL precedent:

```
toolId = sha1('trpc:' + procedureType + ':' + dottedPath).slice(0, 12)   // raw / extractor level
```

Pinned in `fixtures/trpc-app/MUST_DISCOVER.json` and asserted in
`src/extract/trpc/router.test.ts`. Because they key on the procedure, not the path,
they are stable across a `trpcPath` change (also pinned by a test).

**Catalog level:** `prefixedToolId` in `tools-meta.ts` re-derives a surface-scoped id
for every tool. It gained a `tool.trpc` branch keying on
`surface:trpc:procedureType:procedurePath`, alongside the existing `tool.graphql`
branch. REST tools keep `surface:method:path` **byte-for-byte** unchanged.

## Schemas (`.input()` / `.output()` → JSON Schema)

Resolution goes through the **shared static zod reader**,
`tryResolveSchemaIdentifier` from `src/extract/nextjs/schemas.ts` — the same code path
Express uses. It handles an inline `z.object({…})` argument and a file-level
`const Schema = z.object({…})` identifier, and yields property types plus the common
constraints (`.min`/`.max` → `minLength`/`maxLength`/`minimum`/`maximum`, `.email()`/
`.uuid()`/`.url()` → `format`, `.optional()`/`.nullable()` → not required).

**No dynamic import.** `nextjs/schemas.ts` also has a `tryImportZodSchema` path that
`import()`s target code to read a live zod object; this extractor deliberately does not
use it. Target code is never executed to discover a schema.

`inputSchemaConfidence` has three cases:

| Case                                     | `inputSchema`                                          | confidence     |
| ---------------------------------------- | ------------------------------------------------------ | -------------- |
| `.input(X)` resolves to a zod object     | the derived JSON Schema                                 | `introspected` |
| `.input(X)` present but unresolvable     | `{ type: 'object', additionalProperties: true }`         | `unknown`      |
| no `.input()` at all                     | `{ type: 'object', properties: {}, additionalProperties: false }` | `introspected` |

The third row is a small, deliberate extension of "introspected when the zod schema
resolves, else unknown": the *absence* of `.input()` is itself authoritative — the
procedure provably takes no input — so publishing a closed empty object with
`introspected` is more accurate than claiming ignorance.

`outputSchema` is populated from `.output(...)` by the same resolver and left absent
when the procedure declares no output schema or it doesn't resolve. (`outputSchema`
carries no confidence field, so an unresolved output is simply omitted.)

## Callability

REST `executeCall` posts `inputSchema` as a JSON body to `path`; that is wrong for
tRPC, where the procedure lives in a **path suffix** and a query's input rides in a
single `input` query parameter.

- **Descriptor.** `RawToolMeta`/`ToolMeta` gains an optional
  `trpc?: TrpcToolDescriptor` (`{ procedureType, procedurePath }`). Optional, so REST
  and GraphQL tools are unaffected.
- **Request build** (`src/server/trpc-request.ts`, `buildTrpcRequest`) implements the
  single-call form of the tRPC HTTP protocol:

  ```
  query    → GET  <baseUrl><trpcPath>/<dotted.path>?input=<encodeURIComponent(JSON)>
  mutation → POST <baseUrl><trpcPath>/<dotted.path>   body = <JSON input>
  ```

  The caller's `input` object **is** the procedure input (it maps 1:1 onto the
  published `.input(z.object({…}))` schema), so it is sent verbatim. An empty input
  omits the `input` parameter / body entirely rather than sending `{}` — that is how a
  no-input procedure is invoked.
- **Batching not used.** tRPC also supports `?batch=1` with an index-keyed envelope
  (`input={"0":{…}}` and an array response). The single-call form is the simpler wire
  shape, every HTTP adapter accepts it, and one MCP tool call is exactly one procedure
  call — batching would buy nothing but a response-unwrapping step. Documented choice,
  not an oversight.
- **executeCall branch** (`src/server/call.ts`). When `tool.trpc` is set, the URL and
  body come from `buildTrpcRequest` and the request goes out with the tool's own
  method. The branch is guarded strictly on `tool.trpc` and sits *after* the
  `tool.graphql` branch; the REST GET/query-string and POST/body paths are untouched
  (pinned by a REST regression case in `trpc-call.test.ts`).

Everything else on the call path works unchanged: auth headers, role sessions,
auto-relogin, the `Set-Cookie` strip, redirect-manual SSRF guard, body-size/stream
limits, revision pinning.

## Side-effect classification (call-graph note)

Unlike GraphQL, tRPC needs **no** exemption in `regenerateCatalog`. GraphQL had to
preserve the extractor's class because every GraphQL tool is `POST` and
`classifyByCallGraph` would force every Query to `mutating`. tRPC queries really are
`GET`, so the classifier already returns `safe` for them and `mutating` for mutations —
it agrees with the extractor, and it can still promote a mutation to `external` when
the router file imports an external integration (Stripe, SendGrid, …). That is a
feature: `classifyByCallGraph` keys on the tool's `sourceFile`, which for tRPC is the
specific router module the procedure was declared in.

## Config

`SurfaceConfig` / the Zod `SurfaceConfigSchema` gain an optional `trpcPath?: string`
(default `/api/trpc`, trpc stack only), following how `graphqlPath` was added. Config
types are inferred via `z.infer`, so adding it to the schema is sufficient — no
parallel type edit, and `surfacemcp schema` picks it up automatically. `init.ts` seeds
trpc defaults (baseUrl `http://localhost:3000` — tRPC usually rides inside a Next.js
app — launch `npm run dev`, watch `['src', '.']`).

## OpenAPI export

`buildOpenApiResult` skips tRPC tools for the same reason it skips GraphQL ones: they
share a mount path and would collapse onto a single OpenAPI entry, silently dropping
all but one procedure. The result field was renamed `skippedGraphql` →
`skippedNonRest` and the `surfacemcp export` note now names both stacks. Re-expressing
a tRPC surface as OpenAPI (one path per procedure) is a possible follow-up.

## What works vs. deferred

- **Fully working:** detection (dep + router source signal, ahead of Next.js);
  root-router selection; nested routers, inline and cross-file; dotted procedure paths;
  procedure-keyed toolIds at both the raw and catalog level; `.input()`/`.output()` zod
  → JSON Schema with confidence; query/mutation → GET/POST + safe/mutating; end-to-end
  callability verified against a throwaway HTTP server.
- **Deferred / limits:**
  - *Zod resolution is file-scoped and static.* A schema `import`ed from another module
    (`import { SearchInput } from './schemas.js'`) does not resolve → `unknown`
    confidence and an open input object. This is the shared reader's existing limit,
    inherited rather than worked around; it is pinned by a fixture case
    (`search`) so a future improvement will show up as a test diff. Deeply nested
    `z.object` inside `z.object`, `z.union`, `z.discriminatedUnion`, `.transform()`,
    and `z.array(z.object(...))` element types are likewise only partially read.
  - *Non-object `.input()`.* A procedure whose input is a scalar or array
    (`.input(z.string())`) yields an open object with `unknown` confidence, and the
    call sends the caller's object verbatim — there is no way to express a bare scalar
    input through the MCP object-shaped tool input today. Object inputs (the
    overwhelming majority) are exact.
  - *Repeated `.input()` calls are not merged.* tRPC merges them; we take the outermost
    declaration.
  - *Subscriptions ignored.*
  - *Hybrid tRPC + REST apps* surface only the procedures (see detection order).
  - *Dynamically built routers* — a router assembled in a loop, from a spread, or via
    `mergeRouters(a, b)` — is not followed; only object-literal composition is.
  - *Response envelope not unwrapped.* tRPC replies `{ result: { data: … } }` (or
    `{ error: … }` with HTTP 200 in some adapters); `executeCall` returns the body as
    received. `outputSchema` describes `result.data`, not the envelope.
  - *superjson / custom data transformers not modelled.* A router configured with
    `transformer: superjson` expects `input` wrapped as `{ json: … }`; we send the raw
    JSON form. Discovery is unaffected; calls against a superjson server would need a
    transformer-aware encoder.

## Tests & fixture

- `fixtures/trpc-app/` — `src/trpc.ts` (`initTRPC.create()` + `router`/
  `publicProcedure` bindings), `src/routers/post.ts` (a cross-file sub-router: a
  no-input query, an inline-`z.object` query, and a mutation with `.input()` **and**
  `.output()` by identifier), `src/router.ts` (`appRouter` with a top-level query, an
  unresolvable cross-module input, the named sub-router, an inline nested sub-router,
  and a subscription that must not surface), `src/schemas.ts`, `package.json`,
  `surfacemcp.config.json` (`stack: "trpc"`, `trpcPath: "/api/trpc"`),
  `MUST_DISCOVER.json` (pinned procedure-keyed toolIds). Parsed as source text; no deps
  installed, as elsewhere in this repo.
- `src/extract/trpc/router.test.ts` — must-discover set + exact count + id uniqueness,
  the pinned hashing formula, naming, query/mutation → GET+safe / POST+mutating, nested
  (inline and cross-file) flattening, subscription skip, `trpcPath` threading without
  id drift, all three `inputSchemaConfidence` cases, `outputSchema`, posix `sourceFile`,
  and `[]` for a non-tRPC project.
- `src/detect/detect.test.ts` — detects `trpc` for the fixture; wins over `nextjs` for a
  T3-style app; does **not** claim a Next.js tRPC *client*; does not claim a project
  with router-shaped source but no `@trpc/server`.
- `src/server/trpc-request.test.ts` — query/mutation URL + body shapes, input-less
  forms, reserved-character encoding, trailing-slash tolerance.
- `src/server/trpc-call.test.ts` — `executeCall` against a throwaway server proving the
  GET hits `<trpcPath>/<dotted.path>?input=…`, the POST body is the raw input, custom
  mount paths work, inputs never leak as loose query params, and a plain REST tool is
  unaffected by the branch.
- `src/server/tools-naming.test.ts` — surface-scoped ids don't collide across
  procedures sharing the mount path, side-effect classes survive the call-graph pass,
  and `surface.trpcPath` threads through without changing ids.
- `src/export/openapi.test.ts` — tRPC tools are skipped, not collapsed onto
  `/api/trpc`.
