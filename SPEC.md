# SurfaceMCP — v0.1 spec (revised)

**Status:** Draft, post-review · **Author:** @architect (Opus) · **Reviewer:** @architect (independent Opus pass) · **Date:** 2026-04-25 · **For implementation by:** @coder (Sonnet)

This revision incorporates the architect review of the original draft. See [`REVIEW.md`](REVIEW.md) for the full review and the resolution table.

---

## 1. Problem Statement

Vibe-coded apps ship fast and verify slow. Agents that try to drive them either hit `/api` blindly without knowing the schema, or operate the UI via a browser MCP that is slow and tells you nothing if a 500 is swallowed in a catch.

The cleanest fix is to give every agent a **typed, introspectable, role-aware programmatic surface** for any target app, derived directly from the codebase. SurfaceMCP scans the project, identifies the framework, extracts every route / server action / endpoint, and emits an HTTP MCP server with one tool per action — Draft 2020-12 JSON Schema included where the source allows it. Auth is wired in so each call runs as a declared role.

Once that surface exists, BugHunter, Claude Code, Hermes, Paperclip, or any other MCP-capable agent can systematically drive the app without writing per-project integration code.

## 2. Boundaries

**In scope (v0.1)**
- Stack detection by filesystem signal (Next.js, Express, FastAPI, Django, generic OpenAPI). Multi-surface monorepos via `surfaces[]` config.
- Route extraction per stack
- Schema introspection per stack, emitting **Draft 2020-12 JSON Schema** with `format`, `enum`, `min/maxLength`, `min/maximum`, `multipleOf`, `format: binary` (multipart files), plus an `inputSchemaConfidence` flag
- `surface_probe` tool for extracting schemas from validation-error responses on unknown-schema endpoints
- `surface_sample_inputs` tool that pulls fixture inputs from co-located `*.test.ts` / `*.spec.ts`
- HTTP MCP server (Streamable HTTP transport), loopback-only, port auto-allocated in `3102–3199`
- Auth: `none`, `form` (with optional `preLogin` step), `nextauth` (Auth.js v5 convenience), `bearer`, `api_key` (header or query). OAuth deferred to v0.2.
- Per-role cookie/token cache + per-role refresh mutex
- File-watching with debounced regeneration, default ignore set, monotonic `revision` counter
- pm2-managed process per project
- CLI: `init`, `serve`, `tools`, `call`, `regenerate`, `probe`, `doctor`
- Server actions: **form-action submissions only** (`<form action={fn}>` shape, action exported from a non-component file). Closure-bound RPC actions deferred to v0.2.

**Out of scope (v0.1)**
- OAuth / SAML / OTP / magic-link login flows. User can pre-fetch a token and supply via `bearer` config.
- Closure-bound Next.js server actions (the action is invoked via JS `fn(args)` from a client component, addressed by build-time `actionId` + per-page POST). Deferred to v0.2 — tracking the build manifest for actionId resolution is non-trivial and we don't want the v0.1 acceptance bar held hostage to it.
- WebSocket / SSE endpoints (HTTP request/response only). Streaming HTTP responses are read-bounded — see § 5.
- Frontend-only state, mobile apps, GraphQL gateways without a REST shim, multi-version routing.
- Stripe / SendGrid / external-service integration replay — flagged via side-effect classification; callers opt in.
- Unified host-level project registry that consolidates ClaudeMCP / SurfaceMCP / BugHunter configs. Deferred to v0.2.

**External dependencies**
- Node 20+, TypeScript strict
- Python 3.11+ (helpers for FastAPI / Django introspection)
- `@modelcontextprotocol/sdk` (Streamable HTTP transport)
- `express` for the HTTP layer
- `chokidar` for file watching
- `ts-morph` for TypeScript AST analysis
- `zod-to-json-schema` (constraint-preserving) for Next.js / Express schema extraction
- `zod` for SurfaceMCP's own input validation
- `pino` for logging

## 3. Architecture Decisions

### 3.1 HTTP transport, loopback-only

HTTP because:
- Multiple agents (a Claude session + BugHunter + ad-hoc curl) can share one instance per project
- Auth state (cookies, tokens) persists across calls within an instance
- Long-lived; pm2 restarts it; doesn't fight stdio's per-spawn cost

Loopback-only (`127.0.0.1:<port>`). No bearer auth on the MCP itself; the access boundary is the host.

### 3.2 One SurfaceMCP per target project, port auto-allocated

Each project gets its own SurfaceMCP instance. Reasons:
- Each project has its own dev server, auth model, role fixtures
- Mixing projects in one MCP creates confusing tool namespacing
- pm2 per-project naming (`surfacemcp-spoonworks`, `surfacemcp-dash`) is cleaner

**Port allocation**: at `init`, the CLI scans `/root/*/surfacemcp.config.json` (and any path declared via `SURFACEMCP_REGISTRY_GLOB` env) for taken ports, then picks the first free port in `3102–3199`. Result is written to `surfacemcp.config.json`. If the configured port is taken at `serve` time, fail with a clear error and instruct the user to re-run `init`.

The architect-review alternative — single daemon at 3102 routing `/mcp/<projectName>` — is intentionally deferred. Per-project pm2 isolation is more important than per-host port conservation: if SurfaceMCP-spoonworks crashes, SurfaceMCP-dash should keep running.

### 3.3 Stack detection, multi-surface aware

Detection is per-directory. The CLI's `init` defaults to cwd but accepts `--project-root <path>`. The detector pipeline inside that root (first match wins):

```
1. next.config.{js,ts,mjs} + package.json with "next" → "nextjs"
2. manage.py + settings.py → "django"
3. package.json with "express" + AST-detected app.{get,post,put,delete} → "express"
4. pyproject.toml or requirements.txt with "fastapi" → "fastapi"
5. openapi.{json,yaml} or swagger.{json,yaml} → "openapi"
6. Else → "unknown" (init refuses; --stack overrides)
```

For monorepos / hybrid stacks (e.g. `apps/web` Next + `apps/api` Express, or `frontend/` + `backend/`), `surfacemcp.config.json` supports a `surfaces[]` array; one entry per detected stack root. Each entry gets its own port and ecosystem entry. `init --multi-surface` walks one level of subdirectories and runs detection in each.

### 3.4 Schema introspection — Draft 2020-12, with confidence tier

For each detected route, the extractor produces a Draft 2020-12 JSON Schema. The extractor preserves: `type`, `format`, `enum`, `minLength`/`maxLength`, `minimum`/`maximum`, `multipleOf`, `pattern`, `properties`, `required`, `items`, plus the binary marker `{ "type": "string", "format": "binary" }` for file-upload fields.

| Stack | Strategy | Yields constraints? |
|---|---|---|
| Next.js (App / Pages Router) | ts-morph parse for `<schema>.parse(req.body)` patterns; `zod-to-json-schema` with `target: "jsonSchema2020-12"` and constraint preservation enabled | yes |
| Next.js server actions | Form-action only in v0.1: parse the page that imports the action, find the `<form action={fn}>` JSX node, extract sibling `<input>` field names + types as the schema | partial — types from input attrs only |
| Express | ts-morph scan for `req.body` + zod usage; same `zod-to-json-schema` path | yes (when zod) |
| FastAPI | Launch app with introspect env var; fetch `/openapi.json`; convert OpenAPI 3.1 → JSON Schema 2020-12 (1:1, OpenAPI 3.1 IS Draft 2020-12 superset) | yes |
| Django | AST-walk `urls.py` (root + per-app) for URL patterns. View input schemas: scan for DRF `Serializer` classes and Pydantic models. `django-extensions show_urls` is an optional fallback if installed in the target's venv | yes (DRF/Pydantic), partial (plain views) |
| OpenAPI | Read spec, emit tools directly | yes |

**`inputSchemaConfidence`** field on every tool description, three values:
- `introspected` — schema came from a typed definition (zod, Pydantic, DRF, OpenAPI). Trustworthy.
- `inferred` — schema came from heuristics (e.g. JSX form fields, plain `req.body.foo` accesses). Use with caution.
- `unknown` — no schema could be derived. Tool's `inputSchema` is `{ "type": "object", "additionalProperties": true }`.

For `unknown` tools, the new `surface_probe` tool issues a minimal POST with empty body, captures the validation error, and tries to recover the schema from common error formats (zod's flattened errors, Pydantic's `loc`/`msg`, DRF's field dict, FastAPI's `detail` array). Returns the recovered schema and an updated `confidence` of `inferred`.

### 3.5 Auth handling

`surfacemcp.config.json` declares roles + login flow. v0.1 supports five auth kinds:

```json
{
  "auth": {
    "kind": "nextauth",
    "csrfPath": "/api/auth/csrf",
    "callbackPath": "/api/auth/callback/credentials",
    "cookieName": "next-auth.session-token",
    "fields": { "email": "email", "password": "password" }
  }
}
```

Other variants:

```json
{ "auth": { "kind": "form",
            "preLogin": { "method": "GET", "path": "/csrf", "captureBodyFieldAs": "csrf" },
            "loginMethod": "POST",
            "loginPath": "/admin/login",
            "loginFields": { "email": "email", "password": "password", "csrf": "_csrf" },
            "successCheck": { "kind": "redirect", "to": "/admin" } } }

{ "auth": { "kind": "bearer" } }
{ "auth": { "kind": "api_key", "header": "X-API-Key" } }
{ "auth": { "kind": "none" } }
```

The `preLogin` step is generic: `GET <path>`, capture either a body field (regex or JSON path) or a cookie, then make it available to the main login POST as a substitution variable. Covers CSRF-double-submit, hidden-form-field tokens, and Auth.js's CSRF dance (though `kind: "nextauth"` is the convenience preset).

**Role credentials in config**: support `.env` indirection so the config can be checked in:

```json
{
  "roles": [
    { "name": "owner",
      "credentials": { "email": "owner@test.local", "password": "$env:SPOONWORKS_OWNER_PASSWORD" } }
  ]
}
```

`init` writes `.env.example` with the referenced keys; `surfacemcp serve` loads `.env.local` first, then `.env`. `surfacemcp.config.json` is **not** gitignored anymore.

**Per-role cookie cache + refresh mutex**: on startup, run login per declared role, cache result in memory. Each call takes a `role` parameter. Refreshes are mutex'd per role — concurrent calls during a refresh queue on the lock.

**Auto-relogin policy**: by default, refresh on response that contains BOTH (a) a 401/403 status AND (b) a session-clear signal (any of: `Set-Cookie` clearing the session cookie name, a `WWW-Authenticate` header with `error="invalid_token"`, an explicit auth-error JSON body shape from common frameworks). Bare 401s with no clear signal are returned as-is — they're often correct outcomes of negative tests. Callers can opt out entirely with `surface_call({ noAutoRelogin: true })`.

**Login rate-limit collision warning**: many target apps rate-limit login. SurfaceMCP logs in once per role at startup and caches; agents calling thousands of `surface_call` per second hit the cached cookie path, not login. But if `noAutoRelogin: false` AND the target is misbehaving (returning 401 on every call), every call would re-login. The mutex prevents storms; `surfacemcp doctor` warns if the cached cookie has been refreshed > 10× / minute as a heuristic alarm.

### 3.6 File watching

`chokidar` watches the project's source directories. Default ignore set:

```
.next, node_modules, .git, dist, build, __pycache__, *.log,
.bughunter, .surfacemcp, .gitnexus, .vercel, coverage
```

User extends via `watchIgnore` in config. Debounce **1500ms** — Next.js / Vite hot-saves multiple files in flight; 500ms causes thrash.

Tool catalog has a monotonic `revision` counter. `surface_list_tools` and the catalog metadata in `surface_describe_tool` include the revision. When a watcher event fires a regen, revision increments by 1.

**Tool naming under regen**: each tool has a stable hashed `toolId` (`sha1(method + ':' + normalizedPath).slice(0, 12)`) used internally for cluster-keying and audit. The user-facing `name` per § 3.7 may renumber on collision (`...path_2` if `...path` exists). Cluster keys (BugHunter etc.) must use `toolId`, not `name`.

### 3.7 Tool naming

`<method>_<sanitized_path>` for HTTP routes. Server actions: `serveraction_<actionName>__<sanitizedInvokerPagePath>` (double-underscore separator for clarity). Path params normalized to their parameter name. Collisions resolved with numeric suffix (`...path_2`).

Both name and `toolId` are exposed on every `surface_describe_tool` response.

### 3.8 Side-effect classification

Each tool tagged:

```ts
sideEffectClass: 'safe' | 'mutating' | 'external'
```

- `safe` — GET / HEAD / OPTIONS, no observable mutation
- `mutating` — POST / PUT / PATCH / DELETE on the app's own data
- `external` — touches an external service (Stripe, SendGrid, EasyPost, Cloudinary, AWS SDK, etc.)

**Detection** — two-phase, neither one alone is reliable:

1. **`init`-time grep** scans the codebase for known integration libraries. Result is written to config as `_suggestedExternalIntegrations: ["lib/stripe.ts", "app/api/checkout/**"]`. The user reviews and confirms / edits this list. Saved to `externalIntegrations` in config.

2. **Runtime classification** uses the user-confirmed `externalIntegrations` paths plus a one-hop call-graph check via ts-morph (does the handler's import chain reach an integration symbol within one module hop?). Two-hop or transitive reach is left as `mutating`, not `external` — explicitly conservative; it's safer to test something marked `mutating` than to silently fire a real Stripe charge marked `external` that someone overrode.

`surface_call` against an `external` tool requires `{ allowExternal: true }` in the call payload. Default rejects.

## 4. Interface Contract

### 4.1 MCP tool surface (always present)

```ts
type ToolMeta = {
  name: string;
  toolId: string;                       // stable hash, see § 3.6
  method: string;                       // for routes
  path: string;                         // normalized, e.g. /api/users/:id
  inputSchema: JsonSchema2020;
  inputSchemaConfidence: 'introspected' | 'inferred' | 'unknown';
  outputSchema?: JsonSchema2020;
  sideEffectClass: 'safe' | 'mutating' | 'external';
  sourceFile: string;
  sourceLine: number;
  sourceFunctionName?: string;
  isServerAction: boolean;
};

surface_list_tools({ filter?: { method?: string; sideEffect?: string; pathPrefix?: string; confidence?: string } })
  → { revision: number; tools: ToolMeta[] }

surface_describe_tool({ name?: string; toolId?: string })
  → ToolMeta & { rawHandlerSnippet?: string }

surface_call({
  name?: string;
  toolId?: string;
  role: string;
  input: any;
  timeoutMs?: number;
  allowExternal?: boolean;            // required to call sideEffectClass='external'
  noAutoRelogin?: boolean;            // negative-test mode
  pinRevision?: number;               // abort if catalog has changed
})
  → {
      ok: boolean;
      status?: number;
      headers?: Record<string,string>;
      body?: any;
      bodyTruncated?: boolean;        // true if response > 64KB or stream timeout
      error?: { code: string; message: string };
      durationMs: number;
      revisionAtCall: number;         // for revisionChanged detection
    }

surface_probe({ name?: string; toolId?: string; role: string })
  → { recoveredSchema?: JsonSchema2020; confidence: 'inferred' | 'unknown'; rawError?: any }

surface_sample_inputs({ name?: string; toolId?: string })
  → { samples: Array<{ source: string; input: any }> }
  // Reads co-located *.test.ts / *.spec.ts that import the route handler;
  // pulls request body literals or fixture-loader patterns. Best-effort.

surface_login_status({ role: string })
  → { authenticated: boolean; cachedAt?: string; cookieDomain?: string; lastRefreshAt?: string; refreshCount: number }

surface_relogin({ role: string })
  → { ok: boolean; error?: string }

surface_routes_for_page({ pagePath: string })
  → { tools: Array<{ toolId: string; name: string; sourceLocation: string }> }
  // Static scan: parses the page component (and its direct imports), finds string-literal URL
  // arguments to fetch / useSWR / useMutation / useQuery, normalizes to route patterns,
  // matches against the catalog. Best-effort; documented as such.
```

Plus one auto-generated tool per discovered route, all named per § 3.7. Each generated tool is a thin wrapper around `surface_call` for that specific name.

**Outbound calls** to the target server include header `X-Surface-Origin: surfacemcp/<projectName>` so handlers can detect and log / short-circuit if needed. Handlers that themselves call ClaudeMCP can use this header to break recursion.

### 4.2 Streaming response handling

Per § 5: `surface_call` reads up to **64 KB** of the response body or **5 seconds**, whichever comes first. If the response is larger or slower:
- `bodyTruncated: true` in the response
- `body` contains the captured prefix
- `headers` are still complete

This handles SSE, chunked transfer, and large JSON dumps without hanging the MCP.

### 4.3 CLI surface

```
surfacemcp init [--stack=<stack>] [--base-url=<url>] [--project-root=<path>] [--multi-surface]
  Detects stack(s), allocates port(s), writes surfacemcp.config.json + ecosystem.config.cjs entry.
  Prompts for role credentials interactively unless --no-interactive.
  Generates _suggestedExternalIntegrations for user review.
  Adds .gitignore entries: .surfacemcp/, .env.local

surfacemcp serve
  Starts the HTTP MCP server. Auto-launches dev server if launchDevCommand is set
  and baseUrl is unreachable.

surfacemcp tools [--filter=<pattern>] [--confidence=<level>]
  Prints discovered tools.

surfacemcp call <tool> --role=<role> --input='<json>' [--allow-external]
  Invokes a tool from CLI for testing.

surfacemcp probe <tool> --role=<role>
  Run surface_probe on an unknown-schema tool, print recovered schema.

surfacemcp regenerate
  Force re-extraction.

surfacemcp doctor
  - Validates config
  - Runs login per role; reports refresh counts
  - Confirms _suggestedExternalIntegrations vs externalIntegrations
  - Warns on stale pm2 save
  - Validates dev server reachability
  - Prints port + revision
```

### 4.4 Config schema

```ts
type Config = {
  surfaces: SurfaceConfig[];                  // 1+ entries; multi-surface monorepo support
};

type SurfaceConfig = {
  name: string;                               // 'web', 'api', etc — used in pm2 name
  stack: 'nextjs' | 'express' | 'fastapi' | 'django' | 'openapi';
  root: string;                               // relative to repo root
  baseUrl: string;
  port: number;                               // auto-allocated at init
  launchDevCommand?: string;
  watchPaths?: string[];                      // default per-stack
  watchIgnore?: string[];                     // extends the default ignore list
  auth: AuthConfig;
  roles: Array<{ name: string; credentials: Record<string,string> }>;
  schemaIntrospection?: {
    zodAlias?: string;
    pydanticBaseClass?: string;
  };
  excludedRoutes?: string[];
  externalIntegrations?: string[];            // canonical at runtime
  _suggestedExternalIntegrations?: string[];  // written by init for user review
};

type AuthConfig =
  | { kind: 'none' }
  | {
      kind: 'form';
      preLogin?: { method: 'GET'|'POST'; path: string;
                   captureBodyFieldAs?: string;     // capture from JSON or HTML attribute
                   captureBodyRegex?: string;       // for HTML: regex with one capture group
                   captureCookieAs?: string };
      loginMethod: 'POST' | 'GET';
      loginPath: string;
      loginFields: Record<string,string>;     // values can include $captured.<name>
      successCheck: SuccessCheck;
    }
  | {
      kind: 'nextauth';                       // Auth.js v5 convenience
      csrfPath?: string;                      // default '/api/auth/csrf'
      callbackPath?: string;                  // default '/api/auth/callback/credentials'
      cookieName?: string;                    // default 'next-auth.session-token' (with __Secure- prefix detection)
      fields: Record<string,string>;          // typically { email, password }
      callbackUrl?: string;                   // default '/'
    }
  | { kind: 'bearer' }                        // role.credentials must include token
  | { kind: 'api_key'; header?: string; query?: string };

type SuccessCheck =
  | { kind: 'redirect'; to: string }
  | { kind: 'cookie'; name: string }
  | { kind: 'status'; code: number };
```

## 5. Edge Cases

1. **Dev server not running.** If `launchDevCommand` is set, spawn it; wait for `baseUrl` to return any 2xx/3xx. 60s timeout.
2. **Login flow changes.** A 401 with session-clear signal triggers one auto-relogin; if still 401, surface the error.
3. **Routes added/removed live.** Watcher fires; `revision` increments; agents detect via revision mismatch.
4. **Dynamic route registration** (routes loaded from DB, plugin-registered at runtime). Static analysis can't see these. Express has an injectable `/__surface__` introspection helper users can opt into. Other stacks have no fallback — documented limitation.
5. **Server actions invoked via closure / not via `<form action>`.** Out of scope v0.1. Documented.
6. **Routes that 5xx because the underlying service is unhealthy.** SurfaceMCP returns the actual response; downstream tools (BugHunter) decide what to do.
7. **CSRF.** The generic `preLogin` covers GET-token-then-POST-back. The `nextauth` variant covers Auth.js. Bespoke CSRF flows that hide the token in JS state are out of scope.
8. **Multi-tenant routes** (`/api/tenants/:tenantId/...`). User declares `tenantFixtures` per role; SurfaceMCP substitutes at call time.
9. **File-upload endpoints.** Schema field is `{ "type": "string", "format": "binary" }`. Caller passes base64; SurfaceMCP converts to multipart.
10. **Streaming / chunked responses.** Read-bounded per § 4.2 (64 KB or 5s, `bodyTruncated: true`).
11. **GraphQL.** Out of scope v0.1.
12. **Hot-reload during a BugHunter run.** Caller passes `pinRevision` on calls. If `surface_call` detects the catalog has revved, returns `error: { code: "revision_changed" }` and aborts the call. Caller decides abort-vs-requeue.
13. **Concurrent calls during a per-role refresh.** Mutex'd; calls queue, do not bypass.
14. **`X-Surface-Origin` header recursion.** Outbound header lets a downstream Claude/ClaudeMCP handler short-circuit if it detects it's serving its own caller. Documented; not enforced by SurfaceMCP itself.

## 6. Acceptance Criteria

1. `npx tsc --noEmit` clean.
2. `npx vitest run` green. Tests cover:
   - Stack detection on a fixture project per stack, plus a multi-surface monorepo fixture (`apps/web` + `apps/api`)
   - Route extraction yields 100% of a per-fixture **must-discover** route list (hand-curated). May discover more — extras logged but don't fail.
   - Schema introspection emits constraints: zod with `.email()` produces `format: "email"`; zod with `.min(8).max(64)` produces `minLength: 8, maxLength: 64`; Pydantic `EmailStr` and `Field(ge=0, le=100)` produce equivalents
   - `inputSchemaConfidence` correctly classified across introspected / inferred / unknown fixtures
   - `surface_probe` recovers schema from a zod validation error response shape
   - `surface_sample_inputs` reads a fixture-loader test file and returns the input
   - `auth.kind: "form"` with `preLogin` runs against a fixture CSRF-double-submit server
   - `auth.kind: "nextauth"` runs against a real Spoonworks dev server
   - Per-role refresh mutex: simulate a refresh in flight + 50 concurrent calls; assert all observed exactly one refresh
   - Auto-relogin policy: bare 401 does NOT trigger relogin; 401 + cleared session cookie does
   - Streaming response: 100KB body returns `bodyTruncated: true` with first 64KB
   - Tool naming collision: two routes resolving to same `name` get distinct `toolId` and `name_2` user-facing
   - Side-effect classification: a handler that imports `stripe` is `external`; a handler that imports a helper that imports `stripe` is `mutating` (one-hop conservative)
3. **Manual smoke against four real codebases:**
   - **Spoonworks** (Next.js + Auth.js v5): full route discovery; `auth.kind: "nextauth"` logs in as owner; `surface_call` against `get_api_admin_products` returns the live product list
   - **Dash** (Next.js with password gate + per-feature OAuth): route discovery succeeds; password-gate `auth.kind: "form"` with `preLogin` works
   - **Fixture Express + zod project** (in `fixtures/express-app`)
   - **Fixture FastAPI + Pydantic project** (in `fixtures/fastapi-app`)
4. File-watching regen: edit a route handler; observe revision increment within 2s; observe new tool exposed.
5. pm2 lifecycle: `surfacemcp serve` starts under pm2, survives reboot once `pm2 save` + linger.
6. CLI smoke: `surfacemcp doctor` runs login per role, prints OK/fail, refresh counts, suggested-vs-confirmed external integrations.

### 6.1 Per-fixture must-discover sets

Each fixture has a hand-curated `MUST_DISCOVER.json`:

```json
{
  "routes": [
    "GET /api/users",
    "POST /api/users",
    "GET /api/users/:id",
    "PUT /api/users/:id",
    "DELETE /api/users/:id"
  ],
  "serverActions": ["createUser_app_admin_users_page"]
}
```

The test asserts `surface_list_tools` contains each must-discover entry. Extras allowed.

## 7. Files / Repo Layout

```
SurfaceMCP/
├── SPEC.md
├── REVIEW.md                           # the architect review pass + resolution table
├── README.md
├── package.json
├── tsconfig.json
├── ecosystem.config.cjs.template       # written into target on `init`
├── surfacemcp.config.example.json
├── .env.example
├── src/
│   ├── cli/
│   │   ├── init.ts
│   │   ├── serve.ts
│   │   ├── tools.ts
│   │   ├── call.ts
│   │   ├── probe.ts
│   │   ├── regenerate.ts
│   │   └── doctor.ts
│   ├── detect/
│   │   ├── index.ts
│   │   ├── nextjs.ts
│   │   ├── express.ts
│   │   ├── fastapi.ts
│   │   ├── django.ts
│   │   ├── openapi.ts
│   │   └── monorepo.ts                 # multi-surface walker
│   ├── extract/
│   │   ├── nextjs/
│   │   │   ├── routes.ts               # app/api/**, pages/api/**
│   │   │   ├── server-actions.ts       # form-action only
│   │   │   └── schemas.ts              # zod-to-json-schema
│   │   ├── express/
│   │   │   ├── static.ts
│   │   │   └── runtime.ts              # /__surface__ injection helper
│   │   ├── fastapi/
│   │   │   └── openapi-fetch.ts
│   │   ├── django/
│   │   │   ├── ast-walk.ts             # default
│   │   │   └── show-urls.ts            # fallback if django-extensions installed
│   │   └── openapi/
│   │       └── parse.ts
│   ├── auth/
│   │   ├── form.ts
│   │   ├── nextauth.ts
│   │   ├── bearer.ts
│   │   ├── api-key.ts
│   │   ├── prelogin.ts
│   │   ├── refresh-policy.ts           # session-clear-signal detection
│   │   └── role-mutex.ts
│   ├── server/
│   │   ├── http.ts
│   │   ├── tools-meta.ts
│   │   ├── tools-generated.ts
│   │   └── call.ts                     # surface_call orchestration
│   ├── probe/
│   │   ├── zod-error.ts
│   │   ├── pydantic-error.ts
│   │   ├── drf-error.ts
│   │   └── fastapi-error.ts
│   ├── samples/
│   │   └── fixture-loader.ts           # surface_sample_inputs reader
│   ├── classify/
│   │   ├── grep-init.ts                # init-time _suggestedExternalIntegrations
│   │   └── call-graph.ts               # runtime one-hop classifier
│   ├── watch/
│   │   ├── chokidar-driver.ts
│   │   └── debounce.ts                 # debounce, not throttle
│   ├── port/
│   │   └── allocator.ts                # scan registry, pick free port
│   ├── env/
│   │   └── indirection.ts              # $env:VAR resolution
│   ├── config.ts                       # zod schema for surfacemcp.config.json
│   ├── log.ts
│   └── types.ts                        # JsonSchema2020 etc — no `any`
├── fixtures/
│   ├── nextjs-app/
│   │   └── MUST_DISCOVER.json
│   ├── nextjs-monorepo/
│   │   └── MUST_DISCOVER.json
│   ├── express-app/
│   │   └── MUST_DISCOVER.json
│   ├── fastapi-app/
│   │   └── MUST_DISCOVER.json
│   ├── django-app/
│   │   └── MUST_DISCOVER.json
│   └── csrf-double-submit-server/      # for preLogin tests
└── scripts/
    └── helpers/
        └── django_show_urls.py         # optional fallback
```

## 8. Definition of Done

A reviewer can:
```
cd /root/SurfaceMCP
npm ci && npm run build && npm test                 # all green
cd /root/spoonworks
npx surfacemcp init                                  # detects nextjs, allocates 3102, writes config
# (fills in role passwords in .env.local)
npx surfacemcp doctor                                # all OK
pm2 start ecosystem.config.cjs                       # SurfaceMCP up
curl -s -X POST -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  http://127.0.0.1:3102/mcp | jq '.result.tools | length'
# >= 30 (depending on Spoonworks's actual route count post-refactor)

# Probe an unknown-schema tool:
npx surfacemcp probe post_api_admin_products --role=owner
# returns recovered schema with at least name + price required
```

…and a Claude Code session in the project can call `surface_call({ toolId: "...", role: "owner", input: {...} })` and get a real product list back.
