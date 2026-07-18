# SurfaceMCP

Auto-generates an HTTP MCP server that exposes every route, server action, and API endpoint of a target codebase as a typed, introspectable, role-aware tool. Any MCP-aware agent can drive the app's full programmatic surface without writing custom integration code.

## Why this exists

UI-driven testing is slow and brittle. The actual programmatic surface — what the UI is a chrome over — is the API layer. SurfaceMCP makes that layer discoverable and callable from any MCP agent. Together with a browser MCP, it gives you full coverage of what an app does without fighting Playwright for every assertion.

## Status

Working implementation, **v0.3.1**. Multi-surface, role-aware, with unit + e2e test suites. See **[SPEC.md](SPEC.md)** for the design and the `SPEC_*.md` files for per-feature specs.

## Stacks

- **Next.js** (App Router `app/api/**/route.ts` and Pages Router `pages/api/**`, plus server actions)
- **Express** (route + mounted-router discovery)
- **Fastify** (shorthand + `route({})` discovery, with inline JSON Schema introspection)
- **FastAPI** (via the app's generated `openapi.json`)
- **Django** (URLconf walk)
- **Vite SPA** (client-side route + navigation discovery, crawl-seed fallback)
- **Generic OpenAPI** fallback (any framework that emits `openapi.json`/`yaml`)

## Install

As a CLI, globally:

```bash
npm install -g surfacemcp
```

Or run without installing:

```bash
npx surfacemcp <command>
```

From source (for development):

```bash
npm install
npm run build
```

Requires Node ≥ 20.

## Quickstart

```bash
# 1. Detect the stack, allocate a port, write surfacemcp.config.json
npx surfacemcp init --project-root /path/to/app

# 2. Put role credentials in .env.local (gitignored) and reference them
#    from the config as "$env:OWNER_PASSWORD" — see .env.example

# 3. Start the MCP server
npx surfacemcp serve

# 4. Sanity-check discovery and config
npx surfacemcp doctor
npx surfacemcp tools
```

The server speaks Streamable HTTP MCP at `POST /mcp` on the allocated port (bound to `127.0.0.1`).

## CLI

| Command | Purpose |
|---|---|
| `init` | Detect stack, allocate a free port (3102–3199), write `surfacemcp.config.json`. Add `--multi-surface` to walk subdirectories. |
| `serve` | Start the MCP server. |
| `tools` | List discovered tools (`--filter`, `--confidence`). |
| `call <tool>` | Invoke a tool from the CLI (`--role`, `--input='<json>'`, `--allow-external`). |
| `probe <tool>` | Recover a schema from the target's validation-error response. |
| `regenerate` | Force re-extraction of the catalog. |
| `doctor` | Validate config, test logins, check port allocation. |
| `schema` | Print the JSON Schema for `surfacemcp.config.json` (for editor autocomplete). |

`serve` starts the MCP endpoint immediately and never blocks on the target: if a
surface sets `launchDevCommand` and its `baseUrl` isn't reachable, the dev server
is launched in the background while the endpoint stays responsive. Logins are
lazy (on first `surface_call`), so the target only needs to be up by the time an
authenticated call is made.

For editor autocomplete/validation of your config, generate the schema and
reference it:

```bash
surfacemcp schema > surfacemcp.config.schema.json
# then add "$schema": "./surfacemcp.config.schema.json" to surfacemcp.config.json
```

## MCP tools exposed to agents

Discovery: `surface_list_tools`, `surface_describe_tool`, `surface_describe_self`, `surface_list_surfaces`, `surface_list_pages`, `surface_routes_for_page`, `surface_list_navigations`.
Invocation: `surface_call`, `surface_probe`, `surface_sample_inputs`.
Auth: `surface_describe_auth`, `surface_login_status`, `surface_relogin`.
Runtime route enumeration: `surface_enumerate_routes_runtime`, `surface_postprocess_runtime_routes`.

### Call semantics

`surface_call` takes `role` and a single `input` object. The generated tool
advertises a **typed** input schema derived from the route's extracted schema
(zod introspection / OpenAPI / probe), not an opaque bag. Path parameters
(`:id`, `{id}`, `<int:pk>`) are substituted into the URL from `input` and then
omitted from the query string / body; a missing path parameter is rejected with
a typed `missing_path_param` error before any request is issued. See
[SPEC_TYPED_CALL_SURFACE.md](SPEC_TYPED_CALL_SURFACE.md).

### `surface_list_navigations` v2

For Vite SPA stacks, the navigation catalog includes richer hint fields on every entry. These are optional and backwards-compatible — consumers that ignore unknown fields are unaffected.

- **`scope`** (`'top-level' | 'page-local'`): whether the trigger is reachable from any URL (`top-level`) or only after navigating to a parent page (`page-local`). URL-based navigations are always `top-level`; state-setter triggers are classified by their source file.
- **`triggerSelectorHint.preferred`** (`'testId' | 'ariaLabel' | 'text' | 'title'`): the strongest available selector for the trigger element. Priority: `testId` > `ariaLabel` > `text` > `title`.
- **`triggerSelectorHint.title`**: the `title="..."` attribute of the trigger element, as a last-resort selector hint.
- **`siblingNavigations`** (`number`): count of other navigations in the same scope sharing the same text hint (case-insensitive). `0` means unique; `> 0` signals ambiguity, and when `preferred === 'text'` confidence is dropped one notch.
- **`duplicateCount`** (`number`): count of other navigations sharing the same `(method, target, kind, scope)` quadruple. All entries are retained; consumers pick the one with the strongest `preferred` selector.

The catalog is sorted by quality: confidence desc, siblingNavigations asc, preferred desc, then source file/line as a tiebreaker.

## Configuration

`surfacemcp init` writes `surfacemcp.config.json` (committed) describing one or more `surfaces`, each with a stack, `baseUrl`, port, auth kind, and roles. Secrets live in `.env.local` (gitignored) and are referenced with `$env:VAR` indirection — never inline literals. See [surfacemcp.config.example.json](surfacemcp.config.example.json) and [.env.example](.env.example).

## Security model

The MCP endpoint binds to `127.0.0.1` and proxies calls to the configured `baseUrl` only — tool arguments never choose the target host. Credentials are read from a gitignored env file and are never logged.

`POST /mcp` is protected by two layers (see [SPEC_SECURITY_HARDENING.md](SPEC_SECURITY_HARDENING.md)):

- **DNS-rebinding protection.** The `Host` header must be a loopback authority the server actually listens on (`127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`), and any request carrying an `Origin` header (i.e. a browser cross-context `fetch`) is rejected. This blocks a malicious web page from driving the endpoint via a rebound hostname.
- **Per-caller bearer token (default ON).** Callers must send `Authorization: Bearer <token>`, compared in constant time. Set `SURFACEMCP_TOKEN` to pin the secret; if unset, a random token is generated and logged **once** at startup. For trusted local dev only, set `SURFACEMCP_AUTH_DISABLED=1` to turn the token gate off (DNS-rebinding protection stays on). The `/health` readiness endpoint is not gated.

Credential values are **redacted by default**: `surface_describe_auth` returns field names and per-field shape metadata only. Pass `revealSecrets: true` (loopback + token gated) to include plaintext. `surface_call` does not follow redirects (no SSRF pivot), never returns the target's `set-cookie`, and validates any caller-supplied `extraCookie`; `surface_routes_for_page` confines file reads to the project root. Inline literal credentials (values not using `$env:` indirection) are flagged by `surfacemcp doctor` and at config load.

See [SPEC.md](SPEC.md) for the base threat model and [SPEC_SECURITY_HARDENING.md](SPEC_SECURITY_HARDENING.md) for this hardening pass.

## Development

```bash
npm test          # unit suite (vitest)
npm run test:e2e  # build + e2e suite against the fixtures/ apps
npm run typecheck
```

## Companion projects

- **[ClaudeMCP](https://github.com/cunninghambe/ClaudeMCP)** — exposes Claude Code itself as an MCP server, so agents can delegate building work.
- **[BugHunter](https://github.com/cunninghambe/BugHunter)** — uses SurfaceMCP + a browser MCP to run exhaustive automated tests against any vibe-coded app.
