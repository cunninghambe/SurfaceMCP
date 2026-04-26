# SurfaceMCP — architect review pass

The original SPEC.md was reviewed by an independent Opus architect agent (`@architect` subagent type, fresh context) on 2026-04-25. The review surfaced **4 blockers, 10 concerns, 8 open questions**. This file records the resolution table — what changed in SPEC.md and why.

---

## Blockers (all resolved)

| # | Issue | Resolution in SPEC v0.1 |
|---|---|---|
| 1 | NextAuth/Auth.js v5 not adequately modeled by `auth.kind: "form"` — the spec's acceptance criterion (Spoonworks login) wouldn't actually pass | Added `auth.kind: "nextauth"` first-class variant (knows the canonical Auth.js dance: `/api/auth/csrf` GET, `/api/auth/callback/credentials` POST with form-urlencoded body, `next-auth.session-token` cookie with `__Secure-` prefix detection). Added generic `auth.preLogin` step on the `form` variant for any GET-token-then-POST pattern. Documented login-rate-limit collision risk. |
| 2 | Server-action invocation as specified is incomplete and likely broken — `actionId` can't be derived from source AST alone | Narrowed v0.1 server-action support to `<form action={fn}>` submissions only; closure-bound RPC actions deferred to v0.2. Form-submitted actions are addressable via the page's URL with form-data shape, no `Next-Action` header gymnastics. Documented. |
| 3 | Schema introspection too thin for BugHunter's mutation palette to do useful work — `additionalProperties: true` fallback gives BugHunter nothing | Committed to **Draft 2020-12 JSON Schema** with `format`, `enum`, `min/maxLength`, `min/maximum`, `multipleOf`, `format: binary`. Added `inputSchemaConfidence: 'introspected' \| 'inferred' \| 'unknown'`. Added `surface_probe` tool that extracts schema from validation-error responses. Added `surface_sample_inputs` that reads co-located test fixtures. |
| 4 | Per-project port allocation has no policy — second `surfacemcp init` collides on 3102 | Added port allocator: scan `/root/*/surfacemcp.config.json` for taken ports at `init`, pick first free in `3102–3199`. Per-project process model retained for isolation. The architect-suggested alternative (single daemon at 3102 with project routing) explicitly deferred — isolation > port conservation. |

## Concerns (all addressed)

| # | Concern | Resolution |
|---|---|---|
| 1 | Per-role cookie refresh race conditions under BugHunter load | Per-role refresh mutex; concurrent calls during a refresh queue on the lock |
| 2 | File watcher on a 10k-file monorepo will hammer inotify | Default ignore set spelled out (`.next`, `node_modules`, `.git`, `dist`, `build`, `__pycache__`, `*.log`, `.bughunter`, `.surfacemcp`, `.gitnexus`, `.vercel`, `coverage`); debounce raised to 1500ms; "throttle" → "debounce" wording fix |
| 3 | "Cookies refresh on 401" footgun under negative-test traffic | Refresh only on 401/403 + session-clear signal (`Set-Cookie` clearing the session cookie name, `WWW-Authenticate: error="invalid_token"`, framework-specific JSON shapes). Bare 401s pass through. `surface_call({ noAutoRelogin: true })` opt-out for negative-test callers |
| 4 | Side-effect classification by grep is unsafe (false positives + false negatives in real apps) | Two-phase: greppy detection at `init` produces `_suggestedExternalIntegrations` for user review; runtime classification uses user-confirmed `externalIntegrations` plus a one-hop call-graph check. Two-hop or transitive reach stays `mutating` (conservative). `external` calls require explicit `allowExternal: true` |
| 5 | Stack detection's "first match wins" misses monorepos / hybrids | Added `surfaces[]` config array. `init --multi-surface` walks one level of subdirectories, runs detection in each, allocates per-surface ports |
| 6 | `surface_routes_for_page` is hand-waving | Algorithm specified: parse the page component (and direct imports), find string-literal URL arguments to `fetch` / `useSWR` / `useMutation` / `useQuery`, normalize to route patterns, match against catalog. Best-effort; documented as such |
| 7 | "80% of routes discovered" is unenforceable | Replaced with per-fixture hand-curated `MUST_DISCOVER.json`. Must-set hits 100%; extras allowed |
| 8 | Tool collision under file-watch breaks BugHunter caches | Added stable hashed `toolId` (sha1 of method + path) for cluster-keying. User-facing `name` may renumber; downstream agents must key on `toolId` |
| 9 | Streaming/SSE response handling missing | `surface_call` reads up to 64 KB or 5s, returns `bodyTruncated: true` |
| 10 | Recursion / self-call story undefined | Added `X-Surface-Origin: surfacemcp/<projectName>` header on every outbound call; downstream handlers detect & short-circuit |

## Nits (all accepted)

- `inputSchema: any` → typed `JsonSchema2020`
- `sourceTrace?: string` removed (was undefined)
- `init` writes `.gitignore` entries explicitly
- "throttle" → "debounce" (Concern 2)
- Pages Router `pages/api/*.ts` extraction explicitly listed
- `.env` indirection for credentials (`$env:VAR`); `surfacemcp.config.json` is no longer gitignored, only `.env.local`
- Server-action naming uses `__` separator to disambiguate from path tokens
- `pm2 save` warning surfaced via `surfacemcp doctor`
- Server actions: form-action only (covered in Blocker 2)
- README ↔ SPEC consistency on Pages Router

## Open questions resolved

| # | Question | Resolution |
|---|---|---|
| 1 | Unified host project registry (consolidate ClaudeMCP / SurfaceMCP / BugHunter configs)? | **Defer to v0.2.** Three configs is fine for v0.1 |
| 2 | Server actions in v0.1 — closure-bound or form-only? | **Form-action only.** Covered in Blocker 2 |
| 3 | JSON Schema target — Draft 2020-12 or subset? | **Draft 2020-12.** Committed in §3.4 |
| 4 | `surface_sample_inputs` from co-located test fixtures? | **In v0.1.** Small lift, big BugHunter win |
| 5 | Hot-reload during a run — freeze or surface? | **Both.** Caller passes `pinRevision`; mid-run rev change returns `error: { code: "revision_changed" }`; caller decides |
| 6 | File upload introspection? | **Yes.** `format: binary` tag for multipart inputs |
| 7 | chokidar vs parcel-watcher? | **chokidar** (Linux-only host, parcel-watcher's macOS advantage moot) |
| 8 | Django introspection canonical path? | **AST-walk default**, `show_urls` optional fallback if `django-extensions` is installed |

## Praise (preserved in revision)

The reviewer flagged these as good and not to lose. They remain in v0.1 as-is:

- HTTP transport rationale (multi-agent + persistent auth state)
- One-instance-per-project decision
- `revision` counter on `tools/list` for live regen + agent caches
- Auto-relogin as default behavior (now refined with session-clear-signal detection + opt-out)
- Side-effect class as the most important safety primitive (now better implemented)
- `surface_describe_tool` returning `sourceFile` + `sourceLine` (BugHunter consumes this directly)
- Explicit `surface_login_status` / `surface_relogin` tools (gives test runners control)
- Repo layout with one extractor per stack
