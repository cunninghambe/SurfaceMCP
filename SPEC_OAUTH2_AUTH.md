# SurfaceMCP — OAuth2 / OIDC client-credentials auth

**Status:** Implemented · **Date:** 2026-07-25 · **Branch:** `feat/oauth2-auth`

Adds a sixth `auth.kind` — `oauth2` — covering the **client-credentials grant** (RFC 6749 §4.4), the machine-to-machine grant that fits SurfaceMCP's non-interactive model. Purely additive: the five existing kinds (`none`, `form`, `nextauth`, `bearer`, `api_key`) behave identically.

---

## 1. Problem Statement

`auth.kind: 'bearer'` requires the operator to paste a static token into the env file. Real/enterprise APIs mint short-lived access tokens from an OAuth2/OIDC token endpoint, so driving them meant either refreshing a token by hand or watching every call fail with a 401 once the token aged out. That breaks the "drive any app" claim exactly where it matters most.

The value over `bearer` is **lifecycle**: the token is minted from configured credentials, cached with its expiry, and re-minted *before* it expires rather than after a request has already failed.

## 2. Decisions

### 2.1 Client-credentials only

The authorization-code / device grants need a human at a browser; SurfaceMCP is a non-interactive proxy. `grantType` is an enum with a single member (`'client_credentials'`) so the shape is forward-compatible without advertising grants we do not implement.

### 2.2 Credentials come from `roles[].credentials`, never the auth block

`client_id` / `client_secret` are read from the role's `credentials` map through `$env:` indirection, exactly like the password of a `form` role or the `token` of a `bearer` role (camelCase `clientId` / `clientSecret` are accepted as aliases, mirroring `bearer.ts`'s `token ?? bearer`). The `auth` block therefore holds **no secrets** — only the endpoint, grant, scope, audience, and client-auth style — and stays safe to commit. `findLiteralCredentialPaths` covers the new kind without modification because it walks `roles[].credentials` for every kind.

### 2.3 `clientAuth: 'basic' | 'body'`, default `'basic'`

RFC 6749 §2.3.1 prefers HTTP Basic, and §2.3.1 requires each half to be form-urlencoded before base64. `'body'` sends `client_id`/`client_secret` as form fields for authorization servers that only accept that. Either way the credentials travel in the request — never in the URL or query string.

### 2.4 Proactive expiry, with the reactive 401 path kept as a backstop

`expires_in` is converted to an absolute `expiresAt` (epoch ms) minus a **30 s safety skew**, the skew capped at half the lifetime so a short-lived token never computes an expiry in the past. `RoleMutex.ensureSession` treats a session whose `expiresAt` has passed as absent and re-authenticates. Sessions without `expiresAt` (every non-oauth2 kind, and an AS that returns no `expires_in`) are never considered stale — behaviour there is unchanged.

Concurrency is unchanged and unmodified: the expired path routes through the existing `refresh()`, whose per-role in-flight map collapses N concurrent callers onto **one** token request. No thundering herd on the authorization server.

Reactively, `shouldAutoRelogin` gained an **optional** `authKind` argument. When it is `'oauth2'`, a 401 carrying an RFC 6750 `Bearer` challenge (with or without `error="invalid_token"` / `error="expired_token"`) is treated as a session-clear signal. The signal is scoped to 401 — a 403 `insufficient_scope` is an authorization failure that re-minting the same token cannot fix, so it must not spin the login loop. Omitting the argument, or passing any of the five pre-existing kinds, leaves the decision byte-identical to before.

### 2.5 `refresh_token` grant: opportunistic, always with a fallback

RFC 6749 §4.4.3 says a client-credentials response SHOULD NOT include a refresh token, but some authorization servers issue one anyway. When the previous response carried one, the next re-authentication tries a `refresh_token` grant first and **falls back to a fresh `client_credentials` request if it fails for any reason**, so a rotated or revoked refresh token can never wedge a role. No config knob: there is nothing to tune.

### 2.6 `describe_auth` never reveals the client secret

Unlike `form`/`nextauth` there is no browser login for a caller to drive with these values, so plaintext would be disclosure with no consumer. The oauth2 variant reports the token-request shape (endpoint, grant, client-auth style, scope, audience), the credential-key → canonical-field map, and `valueMeta` (`present` / `length` / `source`) — and is hard-coded `redacted: true`. `revealSecrets: true` does not change the result. Access tokens live only on the session and are never described.

## 3. Config Surface

```jsonc
"auth": {
  "kind": "oauth2",
  "tokenUrl": "https://auth.example.com/oauth2/token",  // required, absolute URL
  "grantType": "client_credentials",                    // optional, default 'client_credentials'
  "clientAuth": "basic",                                // optional, default 'basic' | 'body'
  "scope": "read:things write:things",                  // optional
  "audience": "https://api.example.com"                 // optional
},
"roles": [
  { "name": "service",
    "credentials": { "client_id": "$env:API_CLIENT_ID", "client_secret": "$env:API_CLIENT_SECRET" } }
]
```

Optional fields use `.optional()` with the default applied at use-site, matching every other optional field in `AuthConfigSchema` (`bodyFormat`, `cookieName`, …). No new config-file top-level keys, no new env vars, no new npm dependencies.

## 4. Token Lifecycle

1. **Fetch** — `surface_call` → `RoleMutex.ensureSession(role)` → (no session) `refresh()` → `fetchOAuth2Token`: `POST tokenUrl`, `application/x-www-form-urlencoded`, `redirect: 'manual'`, 15 s timeout.
2. **Cache** — the `RoleSession` gains `token`, `tokenType`, `expiresAt`, and `refreshToken` (all optional, so the other kinds are untouched).
3. **Send** — `buildHeaders` emits `Authorization: <tokenType> <token>`, honouring a non-`Bearer` `token_type` when the AS returned one.
4. **Proactive refresh** — the next `ensureSession` past `expiresAt` re-authenticates before issuing the call.
5. **Reactive refresh** — a 401 bearer challenge from the resource server still triggers `refresh()` + one retry, as a backstop for clock skew or server-side revocation.

## 5. Interface Contract

- `fetchOAuth2Token(auth, credentials, { refreshToken? })` → `{ ok: true, token: { accessToken, tokenType, expiresAt?, refreshToken? } } | { ok: false, error }`.
- `oauth2AuthorizationHeader(token, tokenType?)` → the `Authorization` value.
- `isSessionExpired(session, now?)` (exported from `role-mutex.ts`) → `expiresAt !== undefined && now >= expiresAt`.
- `isInsecureTokenUrl(url)` / `missingOAuth2CredentialKeys(credentials)` → `doctor` helpers; the latter returns **key names only**.
- `DescribeAuthResult` gains an `authKind: 'oauth2'` variant (see §2.6).

`doctor` additionally probes the token endpoint with a **GET** (never a POST — a reachability check must not send client credentials), warns when `tokenUrl` is neither https nor loopback, and names any missing credential keys. `loginAll()` then exercises a real token request per role, as it already does for `form` / `nextauth`.

## 6. Secret Handling (see also SPEC_SECURITY_HARDENING.md §9)

| Concern | Handling |
|---|---|
| `client_secret` at rest | `roles[].credentials` + `$env:` indirection; inline literals flagged by `findLiteralCredentialPaths` at config load and in `doctor` |
| `client_secret` in transit | Request only: HTTP Basic header or form body. Never the URL/query. `doctor` warns on a non-https, non-loopback `tokenUrl` |
| `access_token` / `refresh_token` | Held on the in-memory `RoleSession`; sent only as the outbound `Authorization` header. Never returned by `surface_login_status` or `surface_describe_auth` |
| Logging | Only role names, refresh counts and HTTP status codes reach pino — asserted by a test that runs a full login/expiry/refresh/call cycle with sentinel secret values and greps every captured log record |
| Error strings | Non-2xx echoes the status plus the RFC 6749 §5.2 `error` code only when it matches `/^[a-z_]{1,64}$/`. The response body (which may quote credentials) is never echoed |
| Header injection | `access_token` must be printable ASCII; `token_type` must be an RFC 7230 token or it falls back to `Bearer` — a hostile AS response cannot splice headers |
| Redirect replay | `redirect: 'manual'` on the token request: a 3xx never replays the client credentials to another host |
| Hostile endpoint | `tokenUrl` is schema-restricted to `http(s)` with no embedded `user:password@` userinfo; the response is refused past 64 KB rather than buffered, and the request is bounded by a 15 s timeout |

## 7. Files Touched

```
SurfaceMCP/
├── SPEC_OAUTH2_AUTH.md                 # NEW — this file
├── SPEC_SECURITY_HARDENING.md          # MODIFIED — §9 oauth2 secret handling
├── README.md                           # MODIFIED — Auth kinds section
├── surfacemcp.config.example.json      # MODIFIED — second surface using oauth2
├── .env.example                        # MODIFIED — client id/secret placeholders
└── src/
    ├── types.ts                        # MODIFIED — RoleSession token fields; DescribeAuthResult oauth2 variant
    ├── config.ts                       # MODIFIED — oauth2 variant in AuthConfigSchema
    ├── config.test.ts                  # MODIFIED — schema + literal-credential tests
    ├── cli/doctor.ts                   # MODIFIED — token URL + credential-presence checks
    ├── auth/
    │   ├── oauth2.ts                   # NEW — token request, parsing, expiry, header helpers
    │   ├── oauth2.test.ts              # NEW
    │   ├── role-mutex.ts               # MODIFIED — oauth2 login branch; expiry-aware ensureSession
    │   ├── refresh-policy.ts           # MODIFIED — optional authKind, oauth2-only 401 signals
    │   ├── describe-auth.ts            # MODIFIED — oauth2 variant (always redacted)
    │   └── describe-auth.test.ts       # MODIFIED — oauth2 redaction tests
    └── server/call.ts                  # MODIFIED — oauth2 Authorization header; pass authKind
```

## 8. Acceptance Criteria

1. `npm run typecheck` clean. ✓
2. `npm run build` clean. ✓
3. `npm test` green: 596 tests / 51 files (was 543 / 50). ✓
4. The five pre-existing auth kinds are behaviourally unchanged — `ensureSession` only re-authenticates on an expiry that only oauth2 sets, and the new `shouldAutoRelogin` signals are gated on `authKind === 'oauth2'`. ✓
5. No secret reaches pino, `surface_describe_auth`, `surface_login_status`, or any error string. ✓ (covered by tests)

## 9. Notes / Edge Cases

- An AS that returns no `expires_in` yields no `expiresAt`: the token is cached indefinitely and only the reactive 401 path refreshes it. That is the same posture as `bearer`.
- `expires_in: 0` means "already expired" and is honoured — every call re-mints. The existing `refreshCount > 10` warning is the loop alarm.
- A non-2xx from the token endpoint surfaces as a role login failure (`ensureSession` rejects), which `surface_call` reports as `relogin_failed` on the reactive path and `doctor` reports as `Role "x": FAIL`.
- Tokens are per-process and in-memory only; restarting `serve` re-mints on first use.
