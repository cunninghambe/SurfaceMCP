# SurfaceMCP v0.3 — `surface_describe_auth(role)` tool + UI-login config fields

**Status:** Draft · **Author:** @architect (Opus, ultrathink) · **Date:** 2026-04-27 · **For implementation by:** @coder (Sonnet)

This is PR 2 of 3 for the BugHunter browser-login chain. PR 1 = `camofox-mcp/spec-cookies` (must merge first); PR 3 = BugHunter `loginInBrowser` consumer (depends on this PR).

---

## 1. Problem Statement

BugHunter v0.2.1 crawls SPA routes from `/`, but every interesting route on auth-walled SaaS apps (TraiderJo, Spoonworks) sits behind a login. SurfaceMCP holds login credentials and drives a programmatic login for `surface_call`, but it does not expose them to consumers. BugHunter cannot drive the login form in the browser without (a) reading the auth config (login URL, field names, success check) and (b) reading the role's resolved credentials.

This spec adds **one new MCP tool** — `surface_describe_auth(role)` — that returns the structured auth configuration for the requested role, with credentials resolved (`$env:VAR` substituted) and field names mapped for both the existing API login flow and the new browser flow. It also adds **three optional config fields** to the `auth` discriminated union to support apps where the UI login form lives at a different URL, takes different field names, or sits behind a trigger element (modal, drawer, accordion).

The tool is localhost-only (matching the existing SurfaceMCP HTTP bind to `127.0.0.1`). Credentials cross the wire only on a loopback socket.

## 2. Boundaries

### In scope
- New optional fields on `AuthConfig`:
  - `uiLoginPath?: string` — UI route to navigate to. Defaults to `loginPath` (form auth) or `/api/auth/signin` (nextauth). For SPAs whose login modal is on `/` (TraiderJo), set this to `/`.
  - `uiLoginFields?: Record<string, string>` — form-field-name overrides for the UI when they differ from the API field names. Maps the **same credential keys** as `loginFields` / `fields`, but to the **DOM input name/id/placeholder** strings instead of POST body field names. Defaults to `loginFields` (form) or `fields` (nextauth) when unset.
  - `uiTriggerSelector?: string` — optional CSS selector clicked before form discovery. Used when the login form is hidden behind a button (TraiderJo's "Sign in" navbar button opens a modal). Default: none.
  - `uiSubmitSelector?: string` — optional CSS selector for the submit button. Default: none (consumer falls back to text-based discovery).
- New MCP tool: `surface_describe_auth(role)`. Returns structured config including resolved credentials, with sentinel responses for non-browseable kinds (`bearer`, `api_key`, `none`).
- Loopback-only access: validated by binding (existing `app.listen(port, '127.0.0.1', ...)`) plus a defense-in-depth check on the request socket.
- Adapter type updates in `src/types.ts` (the discriminated union) and the corresponding extractor / config validator.
- Tests for the tool with mocked `RoleMutex` / config fixtures.
- Documentation update in `README.md` for the new fields.

### Out of scope
- Caching the resolved credentials beyond the response. Each call re-resolves from `process.env`.
- Per-call rate limiting. Loopback bind is the boundary.
- Returning credentials for a role that has no `credentials` map (the anonymous role). The tool returns a sentinel for those (see § 4.1).
- Driving the login itself in SurfaceMCP. This tool only describes — BugHunter (PR 3) does the driving.
- A `surface_set_browser_session` round-trip — out of scope; v0.4 might add a tool to import cookies from BugHunter back into the SurfaceMCP role session (so `surface_call` and BugHunter share auth), but we are NOT doing that here.
- Generalising to other auth schemes (OAuth2 PKCE, SAML, OIDC). Form + nextauth + the no-op cases is the v0.3 surface.
- Backwards-incompatible removals from `AuthConfig`. All new fields are optional; existing configs continue to work unchanged.

### External dependencies
- No new npm dependencies.
- The existing `resolveCredentials` helper in `src/env/indirection.ts`.
- The existing `RoleMutex` for role lookup.

## 3. Existing Code to Reuse

### Files you MUST read before writing any code
- `src/types.ts` lines 118–155 — the `AuthConfig` discriminated union and `RoleConfig` shape. Extend the `'form'` and `'nextauth'` variants with the new optional fields. **Do NOT** introduce a separate `BrowserAuthConfig` type — that splits the source of truth.
- `src/server/http.ts` lines 91–344 — `registerMetaTools`. Add `surface_describe_auth` here, between `surface_relogin` and `surface_list_pages` (the natural alphabetical-ish slot).
- `src/auth/role-mutex.ts` — `RoleMutex.getSession(roleName)` and `roles: RoleConfig[]`. Use the same `roles` array the mutex was constructed with for credential lookup; do NOT re-read the config file.
- `src/env/indirection.ts` — `resolveCredentials(creds: Record<string, string>)`. Use this verbatim for `$env:VAR` substitution.
- `src/auth/form.ts` — read this to confirm the existing `loginFields` semantics. Note: in `form.ts`, `loginFields[credentialKey] = postFieldName`. The new `uiLoginFields[credentialKey] = domFieldName` follows the SAME orientation (key = credential, value = field name on the wire/DOM).
- `src/auth/nextauth.ts` — same review for the nextauth path. Note `auth.fields` here is keyed `[postFieldName] = credentialKey`. **This is the opposite orientation from form.** When mapping to `uiLoginFields`, normalize to the **form orientation** in the response: `{ credentialKey → domFieldName }`. See § 4.1 normalization rules.
- `src/auth/auth.test.ts` — existing auth test pattern. Add a new `auth/describe-auth.test.ts` next to it.
- `src/config.ts` — config loader. Verify the loader does not reject unknown fields (Zod schemas with `passthrough` or no schema). If it does reject, extend it; new fields must round-trip.
- `/tmp/TraiderJo/surfacemcp.config.json` — concrete real-world example for testing. The TraiderJo case is a good fixture target: it has `loginPath: '/auth/login'` (API) but the UI form lives in a modal on `/`, with `<input id="auth-identifier">` (note: NOT `email`!) and `<input id="auth-password">`.

### Patterns to follow
- **Tool registration**: see existing `surface_login_status` (lines 218–235). Copy the shape verbatim for the new tool's skeleton — Zod input schema, `roleMutex` lookup pattern, `toolOk` / `toolError` responses.
- **Logging**: `import { log } from '../log.js';` — call `log.info({ role, kind: auth.kind }, 'describe_auth requested')` so the loopback access is auditable.
- **Type discipline**: this is strict TS. The discriminated union variants must each handle the new optional fields with `?:` (optional). Do not break narrowing.
- **Test patterns**: match the existing `auth.test.ts` structure — `describe('describeAuth', () => { it('...', () => {...}) })`.
- **Loopback check**: pull from the existing pattern in `/root/.openclaw/extensions/camofox-browser/server.js` lines 184–192 — `req.socket?.remoteAddress` against `isLoopbackAddress`. Implement a tiny helper (`isLoopbackRemote(req)`) under `src/server/`. Returns `true` for `127.x.x.x`, `::1`, `::ffff:127.x.x.x`. Approx 10 LOC.

### DO NOT
- Do NOT add new top-level keys to `SurfaceConfig` for browser login. UI flags belong inside the existing `auth` object — that's the source of truth for "how to log in".
- Do NOT split `AuthConfig` into multiple types. One discriminated union, additive fields.
- Do NOT expose plaintext credentials in `surface_describe_self` (the existing self-introspection tool). Credentials live behind `surface_describe_auth(role)` only — discoverable but role-scoped.
- Do NOT change the existing `loginFields` / `fields` semantics for either auth kind. Compatibility is non-negotiable.
- Do NOT add `auth_kind: 'oauth2'` or any new variant. Spec is additive within existing variants.
- Do NOT add a tool that returns SurfaceMCP's role session cookies. That is a different security tradeoff and a different spec.
- Do NOT write the consumer adapter — BugHunter PR 3 handles its own adapter wiring. Keep this PR strictly server-side.
- Do NOT add file-based credential resolution beyond the existing `$env:VAR` indirection.
- Do NOT ship without a loopback enforcement test.

## 4. Interface Contract

### 4.1 Tool: `surface_describe_auth(role: string)`

**Input schema** (Zod):
```ts
{ role: z.string().min(1).describe("Role name from surfacemcp.config.json roles[]") }
```

**Description string** (verbatim, used by MCP introspection):
> Describe the auth configuration for a role, including resolved credentials, in a shape suitable for driving the in-browser login form. Returns sentinel values for roles that cannot be browser-logged-in (anonymous, bearer, api_key). LOOPBACK ONLY — credentials cross the wire; the SurfaceMCP HTTP server is bound to 127.0.0.1.

**Output type** (TypeScript, for the adapter side):
```ts
export type DescribeAuthResult =
  | { authKind: 'none'; reason: 'no_auth_configured' }
  | { authKind: 'bearer'; reason: 'programmatic_only'; detail: 'Bearer-token auth cannot drive a browser; skip browser login.' }
  | { authKind: 'api_key'; reason: 'programmatic_only'; detail: 'API-key auth cannot drive a browser; skip browser login.' }
  | { authKind: 'anonymous'; reason: 'role_has_no_credentials' }
  | {
      authKind: 'form';
      uiLoginPath: string;                  // resolved: uiLoginPath ?? loginPath
      uiTriggerSelector?: string;
      uiSubmitSelector?: string;
      // The UI field map: { credentialKey -> domFieldName }
      // e.g. for TraiderJo: { email: 'identifier', password: 'password' }
      // (when uiLoginFields is set, otherwise mirrors loginFields)
      fields: Record<string, string>;
      // The actual values to type into each field, keyed by domFieldName.
      // Pre-resolved: $env:VAR substituted. Caller indexes by domFieldName.
      values: Record<string, string>;
      successCheck: SuccessCheck;
      // Optional cookie name for cookie-based successCheck (mirrors form auth).
      cookieName?: string;                  // present iff successCheck.kind === 'cookie'
    }
  | {
      authKind: 'nextauth';
      uiLoginPath: string;                  // resolved: uiLoginPath ?? '/api/auth/signin'
      uiTriggerSelector?: string;
      uiSubmitSelector?: string;
      fields: Record<string, string>;       // same orientation: credentialKey -> domFieldName
      values: Record<string, string>;
      successCheck: SuccessCheck;           // synthesized: { kind: 'cookie', name: cookieName }
      cookieName: string;                   // resolved cookie name (Auth.js v5 default if unset)
    };

export type SuccessCheck =
  | { kind: 'redirect'; to: string }
  | { kind: 'cookie'; name: string }
  | { kind: 'status'; code: number };
```

**Resolution rules:**

1. **Role lookup.** Find `role` in `surface.roles`. If not found → `toolError('not_found', 'Unknown role: <name>')`.
2. **Anonymous role** (no `credentials` map): return `{ authKind: 'anonymous', reason: 'role_has_no_credentials' }`. NOT an error — the consumer should skip browser login for this role.
3. **`auth.kind === 'none'`**: return `{ authKind: 'none', reason: 'no_auth_configured' }`.
4. **`auth.kind === 'bearer'`**: return `{ authKind: 'bearer', reason: 'programmatic_only', detail: '...' }`.
5. **`auth.kind === 'api_key'`**: return `{ authKind: 'api_key', reason: 'programmatic_only', detail: '...' }`.
6. **`auth.kind === 'form'`**:
   - `uiLoginPath = auth.uiLoginPath ?? auth.loginPath`.
   - `uiFieldMap = auth.uiLoginFields ?? auth.loginFields`.
   - `resolved = resolveCredentials(role.credentials!)`.
   - Build `fields: Record<string, string>` from `uiFieldMap` (verbatim — credentialKey → domFieldName).
   - Build `values: Record<string, string>` by iterating `uiFieldMap` and resolving:
     - `for (const [credKey, domName] of Object.entries(uiFieldMap)) values[domName] = resolved[credKey] ?? ''`.
   - `successCheck = auth.successCheck` (passthrough).
   - `cookieName = successCheck.kind === 'cookie' ? successCheck.name : undefined`.
   - Pass through `uiTriggerSelector`, `uiSubmitSelector`.
7. **`auth.kind === 'nextauth'`**:
   - `uiLoginPath = auth.uiLoginPath ?? '/api/auth/signin'`.
   - **Field-orientation normalization** (this is the load-bearing detail): `auth.fields` is `{ postFieldName: credentialKey }`. Invert when computing the response `fields`:
     - Default UI map: `{ credentialKey -> postFieldName }` (inverted). For Auth.js, the default credentials provider exposes inputs whose `name` attribute matches the post-field name (`username`, `password`), so this inversion produces correct DOM names by default.
     - If `auth.uiLoginFields` is set, use it as-is (already in `{ credentialKey -> domFieldName }` orientation).
   - `resolved = resolveCredentials(role.credentials!)`.
   - Build `values` keyed by domFieldName, same as form.
   - `cookieName = auth.cookieName ?? 'authjs.session-token'` (v5 default; v4 fallback is `'next-auth.session-token'`, but for the synthesized successCheck we need a single name — pick v5 default and document in `detail`).
   - `successCheck = { kind: 'cookie', name: cookieName }` (synthesized — nextauth has no explicit successCheck in current config).
8. **Unknown role-credentials key** (a `credentials` map that doesn't include all credential keys referenced by `loginFields`): missing values default to empty string. Log a warning. Do not throw — the consumer (BugHunter) will get an empty value and surface a clearer error from the actual login attempt.

**Errors:**
- `not_found` — unknown role.
- `not_loopback` — request arrived from a non-loopback socket. Status 403, returned via the standard `toolError` envelope (see § 4.3).

### 4.2 New optional fields on `AuthConfig`

Updated discriminated union (additive — existing variants unchanged):

```ts
export type AuthConfig =
  | { kind: 'none' }
  | {
      kind: 'form';
      preLogin?: { /* unchanged */ };
      loginMethod: 'POST' | 'GET';
      loginPath: string;
      loginFields: Record<string, string>;
      bodyFormat?: 'form' | 'json';
      successCheck: SuccessCheck;
      // NEW — UI-only overrides; ignored by API login (loginForm).
      uiLoginPath?: string;
      uiLoginFields?: Record<string, string>;
      uiTriggerSelector?: string;
      uiSubmitSelector?: string;
    }
  | {
      kind: 'nextauth';
      csrfPath?: string;
      callbackPath?: string;
      cookieName?: string;
      fields: Record<string, string>;
      callbackUrl?: string;
      // NEW — UI-only overrides.
      uiLoginPath?: string;
      uiLoginFields?: Record<string, string>;
      uiTriggerSelector?: string;
      uiSubmitSelector?: string;
    }
  | { kind: 'bearer' }
  | { kind: 'api_key'; header?: string; query?: string };
```

### 4.3 Loopback-only enforcement

- HTTP transport already binds to `127.0.0.1` (see `src/server/http.ts` line 433). That is the primary boundary.
- Defense-in-depth: inside the `surface_describe_auth` handler, check `req.socket?.remoteAddress`. Express makes the request available on the underlying `req` via `transport.handleRequest(req, res, ...)` — but the McpServer handler signature does NOT receive the express request directly. The clean way: capture `req` in the closure when constructing the McpServer per-request.
- **Implementation pattern** (keeps the rest of the registry untouched):
  - Modify `createApp`'s per-request `app.post('/mcp', ...)` handler to pass the express `req` into `registerMetaTools`. Add an `httpReq?: Request` parameter to `registerMetaTools`. The describe-auth handler reads it, calls a new `isLoopbackRemote(req)`, and returns `toolError('not_loopback', '...')` on a non-loopback request.
  - Other tools do not need this guard; they don't return credentials.
- A unit test (using `supertest` or a manual `http` request to a non-loopback bound port if portable; otherwise inject a fake socket address via a test-only seam) verifies the guard.

### 4.4 No changes to:
- `surface_call`, `surface_list_tools`, `surface_describe_tool`, `surface_probe`, `surface_sample_inputs`, `surface_login_status`, `surface_relogin`, `surface_list_pages`, `surface_describe_self`, `surface_routes_for_page` — frozen surfaces.
- The login flow (`loginForm`, `loginNextAuth`, `getBearer`) — UI fields are not consumed here.
- The role mutex / refresh logic.
- The watcher.
- The HTTP `/health` endpoint.

## 5. Edge Cases

| # | Case | Behaviour |
|---|---|---|
| 1 | Role exists but has no `credentials` (anonymous role) | Return `{ authKind: 'anonymous', reason: 'role_has_no_credentials' }`. Not an error. |
| 2 | Role does not exist | `toolError('not_found', 'Unknown role: <name>')`. |
| 3 | `auth.kind === 'none'` | Return `{ authKind: 'none', reason: 'no_auth_configured' }`. Not an error. |
| 4 | `auth.kind === 'bearer'` or `'api_key'` | Return programmatic-only sentinel. Not an error. |
| 5 | `uiLoginPath` not set | Default to `loginPath` (form) or `'/api/auth/signin'` (nextauth). Document in response so caller can audit. |
| 6 | `uiLoginFields` not set, form auth | Use `loginFields` verbatim. Pass through values resolved by credential key. |
| 7 | `uiLoginFields` not set, nextauth | **Invert** `auth.fields` (which is `[domName] = credKey`) to `{ credKey: domName }` before returning. |
| 8 | `loginFields` references credential key not in `role.credentials` | `values[domName] = ''`. Log warning with role + missing credential key. Caller's `type()` will fail with a clear error. |
| 9 | `$env:VAR` not set | `resolveCredentials` returns empty string (existing behaviour). Same as above. |
| 10 | `uiTriggerSelector` set but `uiLoginPath` is the same as the post-trigger URL | Pass through both — caller's flow is "navigate, click trigger if set, find form, type, submit". |
| 11 | Concurrent `surface_describe_auth` calls for the same role | Stateless; no contention. RoleMutex is not touched. |
| 12 | Request from non-loopback IP (e.g. forgot to bind 127.0.0.1) | `toolError('not_loopback', 'surface_describe_auth requires a loopback connection')`. Status 403 envelope. |
| 13 | `auth.kind === 'nextauth'` and `auth.cookieName` unset | Synthesize `successCheck = { kind: 'cookie', name: 'authjs.session-token' }`. v4 fallback (`next-auth.session-token`) is documented but not synthesized — caller can override via config. |
| 14 | Multi-surface configs (more than one entry in `surfaces[]`) | This tool operates on the surface the McpServer is registered for (matches existing `surface_list_pages`, etc.). No cross-surface lookup. |

## 6. Acceptance Criteria

1. `cd /root/SurfaceMCP && npx tsc --noEmit` clean.
2. `npx vitest run` green. Tests cover:
   - **`auth/describe-auth.test.ts`** (new file):
     - Form auth, role with credentials → returns resolved values keyed by post field name.
     - Form auth with `uiLoginFields` set (TraiderJo-shaped: `{ email: 'identifier', password: 'password' }`) → returns values keyed by `identifier` and `password`.
     - Form auth with `uiTriggerSelector` set → passed through.
     - NextAuth, no `uiLoginFields` → inverts `auth.fields` correctly, synthesizes cookie successCheck.
     - NextAuth with `uiLoginFields` → uses it verbatim.
     - `auth.kind === 'none'` → returns sentinel.
     - `auth.kind === 'bearer'` → returns sentinel.
     - `auth.kind === 'api_key'` → returns sentinel.
     - Anonymous role (no credentials) → returns sentinel.
     - Unknown role → returns `toolError('not_found', ...)`.
     - `$env:VAR` resolution: set `process.env.X='secret'`, role has `password: '$env:X'` → returned `values` includes `secret`.
     - Missing env var → empty string + warning logged.
   - **`server/http.test.ts`** (extend existing or add new):
     - Non-loopback socket → 403 `not_loopback`. (Use a test seam to inject a fake remoteAddress, or use `supertest` to simulate.)
3. `npm run build` clean.
4. **Manual smoke (TraiderJo)**:
   ```bash
   # surfacemcp running on 127.0.0.1:3103 with TraiderJo's config + uiLoginPath='/' + uiLoginFields={email:'identifier',password:'password'} + uiTriggerSelector='button[aria-label="Sign in"]' (or text-based)
   curl -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"surface_describe_auth","arguments":{"role":"owner"}}}' \
     http://127.0.0.1:3103/mcp | jq
   ```
   Expect:
   ```json
   {
     "authKind": "form",
     "uiLoginPath": "/",
     "uiTriggerSelector": "button[aria-label=\"Sign in\"]",
     "fields": { "email": "identifier", "password": "password" },
     "values": { "identifier": "brad@autogeny.ai", "password": "<resolved>" },
     "successCheck": { "kind": "cookie", "name": "tj_sess" },
     "cookieName": "tj_sess"
   }
   ```
5. **Manual smoke (loopback enforcement)**:
   - Bind on a non-loopback interface (test fixture only; do NOT change defaults). Confirm `surface_describe_auth` returns 403 / `not_loopback`. Confirm other tools still respond as expected.

## 7. Files Touched

```
SurfaceMCP/
├── SPEC_DESCRIBE_AUTH.md              # NEW — this file
├── README.md                          # MODIFIED — document the 4 new auth fields and the new tool (≤ 30 lines added)
├── src/
│   ├── types.ts                       # MODIFIED — add 4 optional fields to form + nextauth variants
│   ├── server/
│   │   ├── http.ts                    # MODIFIED — register surface_describe_auth; thread req for loopback check
│   │   └── loopback.ts                # NEW (~15 LOC) — isLoopbackRemote helper
│   └── auth/
│       └── describe-auth.ts           # NEW (~80 LOC) — pure function buildDescribeAuth(auth, role) → DescribeAuthResult
└── tests/  (or src/auth/)
    └── describe-auth.test.ts          # NEW — see § 6.2 for cases
```

No new dependencies. No new top-level config keys.

## 8. Definition of Done

After this lands:
1. Existing TraiderJo and Spoonworks configs continue to work without modification (the new fields are optional).
2. Adding `uiLoginPath`, `uiLoginFields`, `uiTriggerSelector` to TraiderJo's config (pseudo-diff below) makes `surface_describe_auth({role: 'owner'})` return the correct browser-login plan.
3. PR description includes: `Depends on: camofox-mcp/spec-cookies. Unblocks: BugHunter/spec-browser-login.`
4. Spoonworks's existing nextauth flow (cookie-based, configured without `uiLoginFields`) continues to log in successfully both via the existing programmatic path AND can be described by the new tool with a sensible inverted-fields default.

### TraiderJo config diff after this lands (for reference, applied in PR 3)
```jsonc
{
  "surfaces": [{
    "auth": {
      "kind": "form",
      "loginMethod": "POST",
      "loginPath": "/auth/login",
      "loginFields": { "email": "email", "password": "password" },  // unchanged
      "bodyFormat": "json",
      "successCheck": { "kind": "cookie", "name": "tj_sess" },
      // NEW:
      "uiLoginPath": "/",
      "uiLoginFields": { "email": "identifier", "password": "password" },
      "uiTriggerSelector": "button:has-text(\"Sign in\")"
      // uiSubmitSelector left unset — falls back to text-based discovery in the consumer
    }
  }]
}
```
That diff lives in the BugHunter PR's TraiderJo bring-up — NOT in this PR.

## 9. Test Plan (TODO checklist for QA)

- [ ] `npx tsc --noEmit` clean.
- [ ] `npx vitest run` green; all describe-auth cases pass.
- [ ] Non-loopback test passes (403).
- [ ] Manual smoke against TraiderJo with config diff applied returns the expected plan.
- [ ] Existing `auth.test.ts` still green (no regression in form / nextauth login).
- [ ] `surface_describe_self` does not regress (still returns metadata; unchanged).
- [ ] README documents the 4 new fields with a TraiderJo example.
