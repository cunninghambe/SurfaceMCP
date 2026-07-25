# SurfaceMCP — MCP endpoint security hardening

**Status:** Implemented · **Author:** @security (Opus) · **Date:** 2026-07-18 · **Branch:** `security/mcp-hardening`
**Pass 2:** Implemented · 2026-07-25 · Branch `security/hardening-pass-2` · see §9

This spec covers a focused security-hardening pass over the SurfaceMCP HTTP surface and the `surface_call` / `surface_describe_auth` / `surface_routes_for_page` tool handlers. It closes seven findings from a prior review: an unauthenticated `/mcp` endpoint, plaintext credential disclosure, an SSRF redirect pivot, path traversal, cookie header injection, `set-cookie` leakage, and inline literal credentials.

**Pass 2 (§9)** extends the model from *"the MCP caller is untrusted"* to *"the TARGET PROJECT is untrusted input too"* — covering GraphQL operation-text injection and extraction-time code execution.

---

## 1. Problem Statement

SurfaceMCP binds an MCP endpoint to `127.0.0.1` and proxies tool calls into a target app, carrying the target's session credentials. The loopback bind was the *only* boundary: any local process (including a browser page performing a DNS-rebinding attack, or a co-tenant process) could reach `POST /mcp` with no per-caller authentication, enumerate tools, call authenticated routes, and read back plaintext credentials via `surface_describe_auth`. Several tool handlers also trusted caller-supplied input (`pagePath`, `extraCookie`) and target responses (`set-cookie`, `3xx Location`) more than they should.

This pass adds a per-caller auth gate + DNS-rebinding protection, redacts credentials by default, and tightens the tool handlers — while keeping the loopback bind and not breaking the existing unit/e2e suites.

## 2. Threat Model

| Threat | Before | After |
|---|---|---|
| **DNS rebinding** — a web page the user visits resolves a hostname to `127.0.0.1` and POSTs to `/mcp` from the browser | Accepted (no Host/Origin check) | Rejected: `Host` must be a known loopback authority; any request carrying an `Origin` header is rejected (empty origin allowlist) |
| **Local unauthorized caller** — another local process hits the port | Accepted (no auth) | Rejected unless it presents `Authorization: Bearer <token>` (default ON) |
| **Credential exfiltration** — caller reads role secrets via `surface_describe_auth` | Plaintext values returned to any loopback caller | Redacted by default (names + shape only); plaintext requires explicit `revealSecrets: true` and passes the loopback + token gate |
| **SSRF pivot** — target replies `3xx` to an attacker host; the proxied, authenticated request follows it | `redirect: 'follow'` silently chased it | `redirect: 'manual'`; the `3xx` status + `Location` are surfaced, never followed |
| **Path traversal** — `surface_routes_for_page` reads an arbitrary file via `../` or an absolute path | `resolve(root, pagePath)` then read | Containment enforced: absolute inputs and any escape of `resolvedRoot` are rejected with `bad_path` |
| **Cookie header injection** — `extraCookie` smuggles `;`/CRLF to inject headers or extra cookies | Forwarded verbatim | Validated as a single well-formed `name=value`; `bad_cookie` otherwise |
| **Session leak** — target `set-cookie` (a freshly minted session) is handed back to the caller | Returned in `headers` | Stripped from returned headers (after the internal auto-relogin decision reads it) |
| **Secret sprawl** — inline literal credentials in the committed config | Silent | Warned at `loadConfig` and in `doctor` |

**Out of scope:** TLS (loopback only), rate limiting, multi-tenant token scoping, rotating tokens at runtime, and OAuth for the MCP endpoint itself. The bind stays `127.0.0.1`.

## 3. Decisions

### 3.1 DNS-rebinding protection via Express middleware (not the SDK transport options)

The review suggested the SDK transport options `enableDnsRebindingProtection` / `allowedHosts` / `allowedOrigins`. Those option names **do exist** in `@modelcontextprotocol/sdk@1.29.0`, but they are marked `@deprecated` in the type definitions (`WebStandardStreamableHTTPServerTransportOptions`), explicitly directing implementers to *"Use external middleware for host validation instead."* We therefore implement the equivalent check as Express middleware (`createMcpSecurityMiddleware`), which also composes cleanly with the bearer-token gate and is directly unit-testable. Behaviour matches the SDK intent: `allowedHosts = ['127.0.0.1:<port>', 'localhost:<port>', '[::1]:<port>']`, `allowedOrigins = []`.

- **Host check:** the `Host` header must be one of the loopback authorities we actually listen on (port comes from `getMcpPort(config)`). Missing Host → reject (403 `forbidden_host`).
- **Origin check:** with an empty allowlist, a request that carries *any* `Origin` header is rejected (403 `forbidden_origin`); a request with no `Origin` (a non-browser MCP client) passes. This is the DNS-rebinding-relevant signal: browsers always attach `Origin` on cross-context `fetch`.

### 3.2 Shared-secret bearer token (default ON, explicit opt-out)

- The token is resolved once at startup by `resolveTokenState(process.env)`:
  - `SURFACEMCP_AUTH_DISABLED` truthy (`1`/`true`/`yes`/`on`) → gate **disabled** (`token: null`). DNS-rebinding protection stays on.
  - `SURFACEMCP_TOKEN` set → that value is the shared secret.
  - otherwise → a random 32-byte hex token is generated and **logged once** at startup so the operator can copy it.
- Incoming `Authorization: Bearer <token>` is compared with `timingSafeEqualStr` — both sides are SHA-256-hashed to a fixed width, so the comparison is constant-time and never throws or leaks length on a mismatch. Failure → 401 `unauthorized`.
- The token value is only ever logged at startup (generated case). It is never logged per-request.
- The `/health` readiness endpoint is intentionally **not** gated (it exposes only revision + tool count and is used by readiness probes / the e2e spawn helper).

### 3.3 Credential redaction by default

`buildDescribeAuth(auth, role, revealSecrets = false)`:
- Default: returns `fields` (credentialKey → domFieldName), `valueMeta` (per-field `{ present, length, source }` where `source ∈ 'env' | 'literal' | 'missing'`), and `redacted: true`. No plaintext.
- `revealSecrets: true`: additionally returns the plaintext `values` map and `redacted: false`.
- The `surface_describe_auth` handler still enforces loopback (`isLoopbackRemote`), and the whole `/mcp` endpoint is token-gated, so the reveal path is loopback + token gated.

### 3.4 Tool-handler tightening

- **`surface_call`** validates `extraCookie` with `validateExtraCookie` before it reaches the outbound `Cookie` header; a bad value returns a `SurfaceCallResult`-shaped `{ ok:false, error:{ code:'bad_cookie' } }`.
- **`surface_routes_for_page`** resolves `pagePath` through `resolveContainedPath(resolvedRoot, pagePath)`; anything absolute or escaping the root returns `bad_path`.
- **`executeCall`** uses `redirect: 'manual'` and strips `set-cookie` from the returned headers (the strip happens *after* the auto-relogin decision, which needs to read `set-cookie`).

## 4. Config / Env Surface

| Name | Type | Default | Meaning |
|---|---|---|---|
| `SURFACEMCP_TOKEN` | env string | *(generated)* | Shared bearer secret for `POST /mcp`. If unset (and gate enabled), a random token is generated and logged once at startup. Set it to pin a stable value across restarts. |
| `SURFACEMCP_AUTH_DISABLED` | env flag | *(unset ⇒ gate ON)* | When truthy (`1`/`true`/`yes`/`on`), disables the bearer-token gate for trusted local dev. DNS-rebinding (Host/Origin) protection remains ON. |
| `revealSecrets` | `surface_describe_auth` tool input | `false` | When `true`, include plaintext credential values (loopback + token gated). |

No new config-file keys. No new npm dependencies (uses `node:crypto`, `node:path`, `express`).

## 5. Interface Contract

### 5.1 `POST /mcp` middleware (`createMcpSecurityMiddleware`)
Rejections use a JSON-RPC-shaped envelope `{ jsonrpc:'2.0', error:{ code:-32600, message:'<code>: <msg>' }, id:null }`:
- 403 `forbidden_host` — `Host` not an allowed loopback authority (or missing).
- 403 `forbidden_origin` — `Origin` header present and not allowlisted.
- 401 `unauthorized` — missing/invalid bearer token (only when the gate is enabled).

### 5.2 `surface_describe_auth`
Input adds `revealSecrets?: boolean`. Output form/nextauth variants gain `valueMeta: Record<string, { present: boolean; length: number; source: 'env'|'literal'|'missing' }>` and `redacted: boolean`; `values` is now **optional** and present only when `revealSecrets` was requested.

### 5.3 `surface_call`
`extraCookie` must be a single `name=value` pair: no `;`, no CR/LF/control chars, non-empty RFC-6265 name token, safe value octets. Otherwise `{ ok:false, error:{ code:'bad_cookie', message } }`.

### 5.4 `surface_routes_for_page`
`pagePath` must resolve within `resolvedRoot`. Absolute inputs, NUL bytes, and `..` escapes return `toolError('bad_path', ...)`.

## 6. Files Touched

```
SurfaceMCP/
├── SPEC_SECURITY_HARDENING.md          # NEW — this file
├── README.md                           # MODIFIED — Security model section
├── src/
│   ├── types.ts                        # MODIFIED — CredentialFieldMeta; DescribeAuthResult redaction fields
│   ├── config.ts                       # MODIFIED — findLiteralCredentialPaths + loadConfig warning
│   ├── cli/doctor.ts                   # MODIFIED — literal-credential warning
│   ├── auth/describe-auth.ts           # MODIFIED — redact by default; revealSecrets
│   ├── auth/describe-auth.test.ts      # MODIFIED — redaction + reveal tests
│   ├── config.test.ts                  # MODIFIED — findLiteralCredentialPaths tests
│   ├── e2e/helpers/spawn.ts            # MODIFIED — thread SURFACEMCP_TOKEN + bearer header
│   └── server/
│       ├── http.ts                     # MODIFIED — security middleware; describe_auth revealSecrets; path guard; extraCookie guard
│       ├── call.ts                     # MODIFIED — redirect: manual; strip set-cookie
│       ├── security.ts                 # NEW — token/host/origin helpers + middleware
│       ├── security.test.ts            # NEW
│       ├── path-guard.ts               # NEW — resolveContainedPath
│       ├── path-guard.test.ts          # NEW
│       ├── cookie-guard.ts             # NEW — validateExtraCookie
│       └── cookie-guard.test.ts        # NEW
```

Explicitly **not** touched: `src/server/tools-generated.ts` (owned by a parallel change). The loopback bind in `serve.ts` / `http.ts` entrypoint is unchanged.

## 7. Acceptance Criteria

1. `npm run typecheck` clean. ✓
2. `npm run build` clean. ✓
3. `npm test` (unit suite) green, including new `security.test.ts`, `path-guard.test.ts`, `cookie-guard.test.ts`, and the updated `describe-auth`/`config` tests. ✓
4. `POST /mcp` returns 401 without a token and 200 with the correct bearer token; `/health` stays open. ✓ (verified manually and via the e2e routerless spawn test, which threads the token through `spawn.ts`).
5. The e2e spawn helper supplies `SURFACEMCP_TOKEN` and the bearer header so server-spawning tests still authenticate. ✓

## 8. Notes / Edge Cases

- The generated token is per-process. Restarting `serve` mints a new one unless `SURFACEMCP_TOKEN` is set — pin it for stable clients.
- `set-cookie` is preserved through the internal auto-relogin decision (`shouldAutoRelogin` reads it) and only stripped from the final caller-facing headers.
- With `redirect: 'manual'`, Node/undici surfaces the real `3xx` status and `Location` header (unlike browser fetch, which opaque-redirects). All existing auth flows already use `manual`, so behaviour is consistent across the codebase.
- The vite-app e2e fixture launches a dev server (`launchDevCommand`) and blocks startup on it; that is unrelated to this change and unaffected by the token gate (`/health` is ungated).

---

# 9. Pass 2 — the target project as untrusted input

**Date:** 2026-07-25 · **Branch:** `security/hardening-pass-2`

Pass 1 modelled the MCP *caller* as the adversary. Pass 2 covers the other input SurfaceMCP consumes in bulk: the **target project's source**. ~5.9k lines landed since pass 1 — the GraphQL stack (schema-first SDL + code-first decorators), `crossSurface`, and the OpenAPI export.

The operative question is *"what can a string in the target's source do to us?"*. A target repo is not fully operator-authored in practice: it has dependencies, generated code, and (for the BugHunter use case) is often the very code under investigation.

## 9.1 Threat model additions

| Threat | Before | After |
|---|---|---|
| **GraphQL operation injection** — a decorator literal (`@Query({ name: 'me { password } query evil' })`, `@Arg('a) { … } query z(')`) or a hostile property name is concatenated into the operation text, splicing a *second* operation that runs with an authenticated role session | Emitted verbatim; produced a valid 2-operation document | Every fragment is validated against the GraphQL name / type-ref / selection grammar at **both** discovery and call time. Invalid operations and arguments are skipped at extraction (`warn`); a bad descriptor reaching `executeCall` fails `bad_graphql_descriptor` with **no request sent**; an unusable selection degrades to `__typename` |
| **Extraction-time code execution** — schema introspection `await import(...)`s a target file, executing it (and its imports) in-process, on every extraction and every watcher regen | Unbounded: the express path resolved an import specifier from target source, so `'/tmp/evil.js'` or `'../../..'` executed from anywhere on disk; nothing was logged | Confined to the surface root via realpath on both sides (symlink escapes refused); every executed module logged once at `warn`; per-surface opt-out `schemaIntrospection.dynamicImport: false`. **Still not a sandbox** — see §9.3 |
| **Target-controlled RegExp** — a Django view class name is interpolated into a `new RegExp` | Unescaped: metacharacters threw (crashing extraction) or built a pathological pattern | Escaped as a literal |
| **`surface_sample_inputs` directory read** — driven by a catalog `sourceFile` | `resolve(root, sourceFile)` unguarded | Routed through `resolveContainedPath` (defense in depth; not caller-reachable) |

## 9.2 Decisions

### 9.2.1 Two gates for GraphQL, not one

Validation lives in `src/graphql-names.ts` (pure, no deps) and is applied twice:

1. **Discovery** (`src/extract/graphql/code-first.ts`) — an operation whose `field` is not a GraphQL `Name` is skipped entirely; an argument whose name or mapped type is invalid is dropped from **both** `args` and `inputSchema` (so the two never disagree); a property whose name is not a `Name` is dropped from the selection and the output schema.
2. **Call time** (`src/server/graphql-request.ts`) — `buildGraphqlOperation` re-validates and throws `GraphqlDescriptorError`. This is the backstop that also covers a hand-written or persisted catalog, and any future extractor.

Schema-first descriptors (`src/extract/graphql/parse.ts`) come from the `graphql` library, which already constrains names and type strings; the guards are a no-op there and were verified not to change any existing output.

Grammar accepted, deliberately narrow — exactly what the two extractors emit:
- **Name**: `/^[_A-Za-z][_0-9A-Za-z]*$/` (spec §2.1.9; ASCII only).
- **Type ref**: names, `!`, and `[…]` nesting only (`ID!`, `[String!]!`). Max 256 chars.
- **Selection set**: field names and nested `{ … }` blocks only. Arguments, aliases, directives, fragments, spreads, string literals and comments are all **refused** — none are ever generated, and each is a viable breakout primitive. Max depth 16, max 64 KB.

Selection is the one field that degrades rather than fails (`__typename`), because it is cosmetic to the call's identity and `__typename` discloses only the type name.

### 9.2.2 Dynamic import stays ON by default

`schemaIntrospection.dynamicImport` defaults to **`true`** — current behaviour, unchanged. Turning it off silently would downgrade `inputSchemaConfidence` for every schema resolvable only through a re-export, which is exactly the case the feature exists for. The mitigation is containment + visibility, not removal:

- `src/extract/dynamic-import.ts` is the single choke point. Both former inline `await import(...)` sites now route through it.
- Containment is `realpathSync` on the root **and** the target, then a prefix check — so a symlink inside the project that points at `/etc/…` is refused, not just a literal `../`.
- The specifier handed to `import()` is deliberately **not** converted to a `file://` URL. A bare `C:\…` specifier has always thrown `ERR_UNSUPPORTED_ESM_URL_SCHEME`, i.e. dynamic import has never fired on Windows; converting it would newly *enable* target-code execution there. Behaviour is preserved exactly.
- Every executed module is logged once per process at `warn` (deduped by path so a watcher regen loop cannot drown the log, never silenced).
- A missing policy means **no import**: a caller that does not opt in cannot trigger execution by omission.

### 9.2.3 `crossSurface` is not an authorization boundary — accepted

`surface_routes_for_page`'s `crossSurface` lets a caller attribute matched tools to other surfaces. This grants **no new authority**:

- `surface_list_surfaces` and `surface_list_tools` already aggregate across every surface unconditionally, with no surface filter required.
- All surfaces sit behind the *same* `/mcp` endpoint and the *same* bearer token — there is no per-surface principal to cross.
- Filesystem access is unchanged: `resolveRoutesForPage` still receives `root: rt.resolvedRoot` (the *resolved* surface's root) and still runs every branch through `resolveContainedPath`. `crossSurface` widens only the in-memory tool list that page source is matched against.

Per-surface token scoping remains explicitly out of scope (§2).

### 9.2.4 `surfacemcp export --out` — accepted with cheap guards

`--out` is a destination the operator types on their own CLI, running with their own privileges; writing outside the project root (`--out ../api.json`, or an absolute path) is intended, and silent overwrite matches shell-redirection expectations. Only the two *surprising* outcomes are guarded: a NUL byte in the path, and a path naming a directory (which previously surfaced a raw `EISDIR` stack). The exported document carries no credentials and no host filesystem paths — only tool ids, methods, paths, schemas and `baseUrl`.

## 9.3 Trust assumption (explicit)

**The target project's source is trusted to the level of "code you would run locally".** With `dynamicImport` enabled (the default), a hostile file *inside the surface root* still executes with the SurfaceMCP process's privileges — containment stops the path from escaping the root, not the code from running. Everything else about the target is treated as untrusted data: it is parsed, never evaluated (`ts-morph` for nestjs/fastify/express/nextjs/graphql-code-first, the `graphql` library for SDL, regex/AST walks for django), and every string that reaches an emitted GraphQL operation is grammar-checked.

Operators who cannot make that assumption should set `schemaIntrospection.dynamicImport: false`.

## 9.4 Files touched (pass 2)

```
SurfaceMCP/
├── SPEC_SECURITY_HARDENING.md              # MODIFIED — this section
├── README.md                               # MODIFIED — "The target project is trusted input"
├── fixtures/graphql-codefirst-hostile/     # NEW — decorator-injection fixture
├── src/
│   ├── graphql-names.ts                    # NEW — Name / type-ref / selection grammars
│   ├── graphql-names.test.ts               # NEW
│   ├── config.ts                           # MODIFIED — schemaIntrospection.dynamicImport
│   ├── samples/fixture-loader.ts           # MODIFIED — path guard
│   ├── cli/export.ts                       # MODIFIED — NUL + directory guards
│   ├── extract/
│   │   ├── dynamic-import.ts               # NEW — containment + opt-out + audit log
│   │   ├── dynamic-import.test.ts          # NEW
│   │   ├── django/ast-walk.ts              # MODIFIED — escapeRegExp
│   │   ├── express/{static,schema-scope}.ts # MODIFIED — thread the policy
│   │   ├── nextjs/{routes,schemas}.ts      # MODIFIED — thread the policy
│   │   └── graphql/code-first.ts           # MODIFIED — skip invalid names/types/selections
│   └── server/
│       ├── graphql-request.ts              # MODIFIED — validate; GraphqlDescriptorError
│       ├── call.ts                         # MODIFIED — bad_graphql_descriptor
│       ├── path-guard.ts                   # MODIFIED — isContainedPath
│       └── tools-meta.ts                   # MODIFIED — pass dynamicImport through
```

## 9.5 Regression check on pass-1 controls

Each pass-1 control was re-verified against current `main` (`f6fdb94`), with attention to the new code paths:

| Control | Verdict |
|---|---|
| `/mcp` bearer gate + Host/Origin middleware | **Holds.** Every `server.tool(...)` registration — meta tools and generated tools alike — happens *inside* the `app.post('/mcp', securityMiddleware, …)` handler. The only other routes are `GET`/`DELETE /mcp` (405, no data) and the intentionally-open `/health`. Nothing landed outside the gate. |
| `redirect: 'manual'`, body-size limit, stream timeout, `set-cookie` strip, auth headers | **Holds for GraphQL too.** The `tool.graphql` branch only chooses `fetchBody`; it shares the one `makeRequest` closure, so it inherits `buildHeaders`, `redirect: 'manual'`, `AbortSignal.timeout`, `readBodyWithLimit`, and the post-relogin `stripSetCookie`. No control is bypassed. |
| `surface_routes_for_page` path traversal | **Holds on every branch, including `crossSurface`.** `resolveContainedPath(root, scanRelPath)` sits *after* the route-vs-file fork and before any `existsSync`/`readFileSync`; `crossSurface` changes only the tool list, never `root`. |
| `surface_describe_auth` redaction | **Holds.** `values` is still emitted only when `reveal` is true; `redacted: !reveal`; loopback check intact. |
| `extraCookie` validation | **Holds.** Validated in the `surface_call` handler before `executeCall`. |
| Literal-credential warning | **Holds.** `findLiteralCredentialPaths` still runs at `loadConfig` and in `doctor`. |

## 9.6 Acceptance criteria (pass 2)

1. `npm run typecheck` clean. ✓
2. `npm run build` clean. ✓
3. `npm test` green: **579 tests / 52 files** (from 543 / 50). ✓
4. New hostile-input coverage proves no breakout: `graphql-names.test.ts`, the injection block in `graphql-request.test.ts`, the `graphql-codefirst-hostile` fixture tests, `bad_graphql_descriptor` in `graphql-call.test.ts`, and `dynamic-import.test.ts`. ✓
5. `npm audit`: 6 transitive advisories (2 high, 2 moderate, 2 low), none in `graphql` and none directly reachable — see §9.7. ✓

## 9.7 Dependency notes

- **`graphql@16.11.0`** — exact-pinned, no advisories, and used for **parsing only**: `buildSchema` plus type predicates in `src/extract/graphql/parse.ts`, and `parse` in tests. `graphql()` / `execute()` are never imported, so no target schema is ever executed in-process.
- `npm audit` reports 6 advisories, all transitive and none directly reachable: `@hono/node-server` `serve-static` path traversal (pulled in by `@modelcontextprotocol/sdk`; SurfaceMCP serves HTTP via Express and never mounts Hono's static handler), `body-parser` limit DoS (Express 5; our `/mcp` body limit is a valid `'4mb'` string), and `brace-expansion` / `fast-uri` / `esbuild` in the dev tree (vitest, tsx). Left unpatched in this pass because fixing them means bumping the pinned SDK/Express majors, which is a dependency change rather than a security-hardening change.
