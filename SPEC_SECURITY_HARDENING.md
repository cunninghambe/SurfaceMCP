# SurfaceMCP — MCP endpoint security hardening

**Status:** Implemented · **Author:** @security (Opus) · **Date:** 2026-07-18 · **Branch:** `security/mcp-hardening`

This spec covers a focused security-hardening pass over the SurfaceMCP HTTP surface and the `surface_call` / `surface_describe_auth` / `surface_routes_for_page` tool handlers. It closes seven findings from a prior review: an unauthenticated `/mcp` endpoint, plaintext credential disclosure, an SSRF redirect pivot, path traversal, cookie header injection, `set-cookie` leakage, and inline literal credentials.

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
