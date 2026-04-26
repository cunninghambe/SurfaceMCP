# SurfaceMCP — v0.1 spec

**Status:** Draft · **Author:** @architect (Opus) · **Date:** 2026-04-25 · **For implementation by:** @coder (Sonnet)

---

## 1. Problem Statement

Vibe-coded apps ship fast and bug-hunt slow. Agents that try to verify them either:
- Hit `/api` endpoints blindly without knowing the schema, or
- Drive the UI via Playwright/Camoufox, which is slow, brittle, and tells you nothing if the rendered HTML hides a 500 in a swallowed catch.

The cleanest fix is to give every agent a **typed, introspectable, role-aware programmatic surface** for any target app, derived directly from the codebase. SurfaceMCP scans the project, identifies the framework, extracts every route / server action / endpoint, and emits an HTTP MCP server with one tool per action — schemas included where the source allows. Auth is wired in so each call runs as a declared role.

Once that surface exists, BugHunter (separate repo), Claude Code, Hermes, Paperclip, or any other MCP-capable agent can systematically drive the app without writing per-project integration code.

## 2. Boundaries

**In scope (v0.1)**
- Stack detection by filesystem signal (Next.js, Express, FastAPI, Django, generic OpenAPI)
- Route extraction per stack
- Schema introspection where the source provides it (zod / OpenAPI / DRF serializers / Pydantic) — best-effort with `unknown` fallback when none available
- HTTP MCP server (Streamable HTTP transport), loopback-only, port 3102
- Auth handling: form-based session, JWT bearer, API key (header or query). OAuth deferred.
- Role configuration via `surfacemcp.config.json`
- Cookie / token cache per role
- File-watching: regenerate tools on source changes
- pm2-managed process
- CLI surface: `init`, `serve`, `tools`, `call`, `regenerate`

**Out of scope (v0.1)**
- OAuth / SAML / magic-link / OTP flows. User supplies bearer token via config if needed.
- Frontend-only state (Redux, Zustand, etc.) — that's the UI's problem; SurfaceMCP is for the API layer
- Stripe / SendGrid / external-service integration replay — too risky to replay; tools that hit those endpoints get marked `external_side_effect: true` and callers can opt in
- Mobile app surface (iOS/Android) — out of scope; web surfaces only
- WebSocket / SSE endpoints — v0.1 covers HTTP request/response only
- Multi-version routing (e.g. `/v1/...` and `/v2/...` simultaneously) — supported only if both versions live in the same codebase; cross-deployment versioning is out

**External dependencies**
- Node 20+, TypeScript strict
- Python 3.11+ (for Django/FastAPI introspection helpers)
- `@modelcontextprotocol/sdk` (Streamable HTTP transport)
- `express` for the HTTP layer
- `chokidar` for file watching
- `ts-morph` for TypeScript AST analysis (Next.js, Express)
- Per-stack helpers: `python -c "..."` shell-outs for FastAPI/Django introspection
- `zod` for input validation on the SurfaceMCP server itself

## 3. Architecture Decisions

### 3.1 HTTP transport, not stdio

SurfaceMCP is HTTP because:
- Multiple agents (Claude session + BugHunter + ad-hoc curl) can share one instance per project
- Auth state (cookies, tokens) persists across calls within a session
- Long-lived; pm2 restarts it. Doesn't fight stdio's per-spawn cost.

Loopback-only (`127.0.0.1:3102`) — same access boundary as ClaudeMCP. No bearer auth on the MCP itself; the access boundary is "you're on this host."

### 3.2 One SurfaceMCP per target project, not one global

Each project gets its own SurfaceMCP instance on its own port. Reasons:
- Each project has its own dev server, its own auth model, its own role fixtures
- Mixing projects in one MCP creates confusing tool namespacing
- pm2 per-project naming (`surfacemcp-spoonworks`, `surfacemcp-dash`) is cleaner

`surfacemcp init` writes a project-local config + ecosystem snippet. `surfacemcp serve` starts the project's instance. Port assigned at init time, stored in config.

### 3.3 Stack detection via filesystem signals

Detector pipeline (first match wins):

```
1. Has next.config.{js,ts,mjs} AND has package.json with "next" in deps → "nextjs"
2. Has manage.py AND has settings.py → "django"
3. Has package.json with "express" in deps AND scan finds app.{get,post,put,delete} → "express"
4. Has pyproject.toml or requirements.txt with "fastapi" → "fastapi"
5. Has openapi.{json,yaml} OR swagger.{json,yaml} → "openapi"
6. Else → "unknown" (init refuses; user can override with --stack)
```

Detection logged at init. Detection result stored in config so subsequent runs skip the scan.

### 3.4 Schema introspection — best effort, not heroics

For each detected route, SurfaceMCP tries (in order):

| Stack | Strategy |
|---|---|
| Next.js | Parse the route handler file with ts-morph; look for `body.parse(...)` calls referencing a zod schema; resolve the schema definition and emit JSON Schema |
| Next.js (server actions) | Parse for exported async functions with `'use server'`; treat declared params as the input shape; if zod is used inside, extract |
| Express | ts-morph scan for `req.body` consumer patterns + zod validators; identify path params from route string |
| FastAPI | Launch app with a special `--introspect` env var; fetch `/openapi.json`; parse |
| Django | Run `python manage.py show_urls` (django-extensions) or AST-walk `urls.py` files; for view inputs, look for DRF serializers and Pydantic models |
| OpenAPI | Read the spec file; emit tools directly |

When schema introspection finds nothing, the tool's input schema is `{ "additionalProperties": true }`. The agent calling it has to figure out shape from response, but the tool is still callable.

### 3.5 Auth handling

`surfacemcp.config.json` declares roles + login flow. Sample:

```json
{
  "stack": "nextjs",
  "baseUrl": "http://localhost:3000",
  "port": 3102,
  "auth": {
    "kind": "form",
    "loginPath": "/admin/login",
    "loginMethod": "POST",
    "loginFields": { "email": "email", "password": "password" },
    "successCheck": { "kind": "redirect", "to": "/admin" }
  },
  "roles": [
    { "name": "owner", "credentials": { "email": "owner@test.local", "password": "...changeme..." } },
    { "name": "controller", "credentials": { "email": "controller@test.local", "password": "...changeme..." } }
  ]
}
```

Other auth `kind`s:
- `bearer` — config supplies the token directly per role; SurfaceMCP attaches `Authorization: Bearer <token>`
- `api_key` — `{ kind: "api_key", header: "X-API-Key", value: "..." }` or `{ kind: "api_key", query: "api_key", value: "..." }`
- `none` — public app or explicitly unauthenticated tool surface

On startup, SurfaceMCP runs the login flow once per role; caches the resulting cookie/token in memory. Calls specify `role` parameter; SurfaceMCP attaches the right credential. Cookies refresh on 401.

Credentials in config — gitignore `surfacemcp.config.json` always; offer `surfacemcp.config.example.json` as a checked-in template.

### 3.6 File watching

`chokidar` watches the project's source directories (configurable). On change matching a route file pattern (per-stack), SurfaceMCP re-runs extraction for that file and updates the live tool catalog. Throttled to once per 500ms to handle save-bursts.

Tool catalog is versioned with a monotonically incrementing `revision` counter. The MCP `tools/list` response includes the revision so callers can detect catalog changes.

### 3.7 Tool naming

```
<method>_<sanitized_path>
```

Examples:
- `GET /api/users/[id]` → `get_api_users_id`
- `POST /api/admin/products` → `post_api_admin_products`
- Server action `createProduct` exported from `app/admin/products/page.tsx` → `serveraction_createProduct_app_admin_products`

Path params normalized to their parameter name (no brackets/colons in tool names). Collisions resolved with a numeric suffix (`...path_2`).

### 3.8 Side-effect classification

Each tool is annotated:

```ts
sideEffectClass: 'safe' | 'mutating' | 'external'
```

- `safe` — GET / HEAD / OPTIONS, no observable mutation
- `mutating` — POST / PUT / PATCH / DELETE on the app's own data
- `external` — touches external services (Stripe, SendGrid, S3, etc.). Detected via grep for known integration libraries in the handler. Caller (BugHunter, etc.) can opt out of `external` calls by default.

## 4. Interface Contract

### 4.1 MCP tool surface (always present)

```ts
surface_list_tools({ filter?: { method?: string; sideEffect?: string; pathPrefix?: string } })
  → { revision: number; tools: Array<{ name: string; method: string; path: string; inputSchema: any; sideEffectClass: string; sourceFile: string; sourceLine: number }> }

surface_describe_tool({ name: string })
  → { name; method; path; inputSchema; outputSchema?; sideEffectClass; sourceFile; sourceLine; rawHandler?: string }

surface_call({ name: string; role: string; input: any; timeoutMs?: number })
  → { ok: boolean; status?: number; body?: any; error?: { code: string; message: string }; durationMs: number; sourceTrace?: string }

surface_login_status({ role: string })
  → { authenticated: boolean; cachedAt?: string; cookieDomain?: string }

surface_relogin({ role: string })
  → { ok: boolean; error?: string }

surface_routes_for_page({ path: string })
  → { tools: string[] }   // best-effort: which tools are likely fired by visiting this UI page
```

Plus one auto-generated tool per discovered route, all named per § 3.7. Each generated tool is a thin wrapper around `surface_call` for that specific route.

### 4.2 CLI surface

```
surfacemcp init [--stack=<stack>] [--base-url=<url>]
  Creates surfacemcp.config.json, .gitignore entries, ecosystem.config.cjs entry.
  Detects stack unless --stack passed.
  Prompts for role credentials interactively unless --no-interactive.

surfacemcp serve
  Starts the HTTP MCP server. Auto-launches dev server if config has launchDevCommand.

surfacemcp tools [--filter=<pattern>]
  Prints discovered tools. For debugging.

surfacemcp call <tool> --role=<role> --input='<json>'
  Invokes a tool from CLI. For testing without an agent.

surfacemcp regenerate
  Force re-extraction. Useful if file watching missed something.

surfacemcp doctor
  Validates config, runs login flow per role, prints health summary.
```

### 4.3 Config schema (`surfacemcp.config.json`)

```ts
type Config = {
  stack: 'nextjs' | 'express' | 'fastapi' | 'django' | 'openapi';
  baseUrl: string;                    // http://localhost:3000
  port: number;                       // default 3102, allocated at init
  launchDevCommand?: string;          // optional: "npm run dev" — SurfaceMCP runs it if not already serving baseUrl
  watchPaths?: string[];              // default per-stack: ["app/", "src/", "pages/"] for Next.js, etc.
  auth: AuthConfig;
  roles: Array<{ name: string; credentials: Record<string, string> }>;
  schemaIntrospection?: {
    zodAlias?: string;                // if user imports zod as "z" or other
    pydanticBaseClass?: string;       // for FastAPI/Django
  };
  excludedRoutes?: string[];          // glob patterns; tools matching are not generated
  externalIntegrations?: string[];    // additional patterns to flag tools as `external`
};

type AuthConfig =
  | { kind: 'none' }
  | { kind: 'form'; loginPath: string; loginMethod: 'POST' | 'GET'; loginFields: Record<string,string>; successCheck: SuccessCheck }
  | { kind: 'bearer' }
  | { kind: 'api_key'; header?: string; query?: string };

type SuccessCheck =
  | { kind: 'redirect'; to: string }
  | { kind: 'cookie'; name: string }
  | { kind: 'status'; code: number };
```

## 5. Edge Cases

1. **Dev server not running.** If `launchDevCommand` is set, spawn it and wait for `baseUrl` to return any 2xx/3xx. Time out after 60s with a clear error.
2. **Login flow changes.** If a 401 surfaces during a `surface_call`, SurfaceMCP automatically re-runs login for the affected role once. If still 401, surfaces the error.
3. **Routes added/removed live.** Watcher fires; `revision` increments. Cached agent tool lists become stale; agents should re-fetch on `revision` mismatch.
4. **Route handler with dynamic registration** (e.g. routes loaded from a database, or `app.use(somePlugin)` that registers many at runtime). Static analysis can't see these. Falls back to runtime introspection where supported (Express introspection endpoint, FastAPI OpenAPI). Documented as a limitation for stacks without runtime introspection.
5. **Server actions called from a non-default file.** Next.js server actions are addressable by the URL of the page that imports them with a `Next-Action` header. SurfaceMCP records `actionId` + `invokerPagePath` and synthesizes the right POST.
6. **Routes that 5xx because the underlying service is unhealthy** (DB down, etc.). Distinct from a real bug. SurfaceMCP returns the actual response; downstream tools (BugHunter) decide what to do with 5xx.
7. **Routes that require a CSRF token.** Detected in form login flow (CSRF input rendered by login page); SurfaceMCP scrapes and includes. For non-form auth that uses CSRF, user adds a `csrf` field to auth config.
8. **Multi-tenant routes** where the URL embeds a tenant ID (`/api/tenants/:tenantId/users`). User declares tenant fixtures per role; SurfaceMCP substitutes them at call time.
9. **File-upload endpoints.** Tool input includes a `file` field; agent passes a base64-encoded blob; SurfaceMCP converts to multipart for the call.
10. **GraphQL.** Out of scope v0.1. (Worth noting since "Express + GraphQL" is a common stack.) Documented; user's escape hatch is generic OpenAPI if their GraphQL gateway emits a REST shim.

## 6. Acceptance Criteria

1. `npx tsc --noEmit` clean.
2. `npx vitest run` green. Tests cover:
   - Stack detection on a fixture project per stack
   - Route extraction on a fixture project per stack (asserting >80% of routes discovered)
   - Schema introspection: zod-using Next.js handler resolves correctly; FastAPI handler with Pydantic resolves; route without schema falls back to `additionalProperties: true`
   - Form-based login flow against a fixture server
   - Tool naming collision resolution
   - Side-effect classification correctly tags GET/POST/external integrations
3. Manual smoke against four real projects:
   - Spoonworks (Next.js) — discovers all routes under `app/api/admin/**`; calling `surface_call` with `role: "owner"` succeeds; logging in uses the existing form auth
   - Dash (Next.js) — same, with the password gate
   - A fixture Express + zod project (provided in the repo's `fixtures/` dir)
   - A fixture FastAPI + Pydantic project
4. File-watching regeneration: edit a route handler, observe `revision` increment within 2s, observe new tool exposed.
5. pm2 lifecycle: `surfacemcp serve` starts cleanly under pm2; survives reboot once `pm2 save` + linger is enabled.
6. CLI smoke: `surfacemcp doctor` runs login per role, prints OK/fail per role.

## 7. Files / Repo Layout

```
SurfaceMCP/
├── SPEC.md
├── README.md
├── package.json
├── tsconfig.json
├── ecosystem.config.cjs.template      # written into target project on `init`
├── surfacemcp.config.example.json
├── src/
│   ├── cli/
│   │   ├── init.ts
│   │   ├── serve.ts
│   │   ├── tools.ts
│   │   ├── call.ts
│   │   ├── regenerate.ts
│   │   └── doctor.ts
│   ├── detect/
│   │   ├── index.ts                   # detector pipeline
│   │   ├── nextjs.ts
│   │   ├── express.ts
│   │   ├── fastapi.ts
│   │   ├── django.ts
│   │   └── openapi.ts
│   ├── extract/                       # one extractor per stack
│   │   ├── nextjs/
│   │   │   ├── routes.ts
│   │   │   ├── server-actions.ts
│   │   │   └── schemas.ts
│   │   ├── express/
│   │   │   ├── static.ts              # ts-morph AST scan
│   │   │   └── runtime.ts             # /__surface__ injection helper
│   │   ├── fastapi/
│   │   │   └── openapi-fetch.ts
│   │   ├── django/
│   │   │   └── show-urls.ts           # python -c shell-out helper
│   │   └── openapi/
│   │       └── parse.ts
│   ├── auth/
│   │   ├── form.ts
│   │   ├── bearer.ts
│   │   ├── api-key.ts
│   │   └── csrf.ts
│   ├── server/
│   │   ├── http.ts                    # express + MCP SDK
│   │   ├── tools-meta.ts              # surface_list_tools etc.
│   │   ├── tools-generated.ts         # dynamically registered route tools
│   │   └── call.ts                    # surface_call orchestration
│   ├── watch/
│   │   └── chokidar-driver.ts
│   ├── config.ts                      # zod schema for surfacemcp.config.json
│   ├── log.ts                         # pino
│   └── types.ts
├── fixtures/                          # test projects per stack for vitest + manual QA
│   ├── nextjs-app/
│   ├── express-app/
│   ├── fastapi-app/
│   └── django-app/
└── scripts/
    └── helpers/
        └── django_show_urls.py
```

## 8. Definition of Done

A reviewer can:
```
cd /root/SurfaceMCP
npm ci
npm run build
npm test
cd /root/spoonworks
npx surfacemcp init
# (fills in roles in surfacemcp.config.json)
npx surfacemcp doctor   # passes
pm2 start ecosystem.config.cjs    # SurfaceMCP up on :3102
curl -s -X POST -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  http://127.0.0.1:3102/mcp
# returns 50+ tools, mix of meta + auto-generated
```

…and a sanity-check run from any Claude Code session can call `surface_call({ name: "get_api_admin_products", role: "owner", input: {} })` and get back a real product list.
