# SPEC: SurfaceMCP — first-class multi-surface support

Status: draft, ready for implementation
Owner: @architect
Target version: SurfaceMCP v0.3.0 (additive, no breaking change for single-surface configs)
Companion: `/root/BugHunter/fixtures/bughunter-self-deliberate-bugs/surfacemcp.config.json` (real-world six-surface config that this spec unblocks)
Implementation by: @coder (Sonnet)

---

## 1. Problem statement

Real applications are not single surfaces. The smallest realistic SurfaceMCP target is a frontend SPA + a backend API; many are richer (auth service, microservice mesh, admin UI, OpenAPI third-party). Today `src/cli/serve.ts` and `src/server/http.ts` both read `config.surfaces[0]!` and serve only that one entry. Every other declared surface in `surfaces[]` is silently ignored.

The leak is visible in the BugHunter self-test fixture: `surfacemcp.config.json` declares six surfaces (`self-api`, `self-spa`, `race-bad`, `idor-bad`, `v24-deferred-bugs`, `pen-bad`). A single SurfaceMCP run sees one of two worlds — the API kinds OR the UI kinds, never both — because surface zero is the only one that matters. BugHunter's smoke #9 (cross-cutting kind coverage) cannot pass against HEAD, and the user must spawn N separate SurfaceMCP processes and stitch results downstream. Every consumer (BugHunter, IDE plugins, agent frameworks) re-implements the same aggregation. Multi-surface is SurfaceMCP's job, not its consumer's.

This spec promotes multi-surface from a workaround to a primary deployment mode. One SurfaceMCP process, one `/mcp` endpoint, N surfaces; consumers see one tool catalog whose entries declare which surface they belong to. The wire protocol (`tools/list`, `tools/call`) is unchanged; the BugHunter adapter at `/root/BugHunter/packages/cli/src/adapters/surface-mcp.ts` does not need a single line of change to start seeing all six surfaces' tools.

---

## 2. Goals / non-goals

### 2.1 Goals

- One SurfaceMCP process serves N surfaces declared in `surfaces[]`.
- Single endpoint (`POST /mcp` on one port) routes calls to the correct surface.
- Tool names on the wire are unambiguously surface-prefixed (`<surface>:<tool>`).
- Existing single-surface configs (1 entry) continue to work with bare tool names — zero migration required.
- Consumers (BugHunter HttpSurfaceMcpAdapter) do not change their adapter code; they just see more tools.
- A new metadata tool (`surface_list_surfaces`) lets consumers introspect what surfaces are served and which tools belong to which.
- A surface that fails to extract or fails to log in does not crash the process or break sibling surfaces; it appears in metadata with a typed error.
- `tools/list` aggregates across all surfaces; per-surface filtering is supported via a new `surface` filter.

### 2.2 Non-goals (explicit; each could be a future spec)

- **No cross-surface query joining.** A tool call is dispatched to exactly one surface. There is no built-in "fan out to all surfaces" or "join SPA route X to API route Y" call shape. (Consumer can do that on top.)
- **No surface-level auth federation.** Each surface keeps its own `auth` and `roles`. There is no single sign-on or shared session pool. A `role: "admin"` on a `surface_call` against `idor-bad` means `idor-bad`'s `admin` role only.
- **No hot-reload of the surface set.** Adding/removing a surface from `surfacemcp.config.json` requires a process restart. (Tracked separately.)
- **No per-surface rate limits or observability dashboards.** Logs include the surface name; that is the limit of v0.3.0 telemetry.
- **No per-surface MCP listen port.** One process listens on one port; surface-level `port` becomes advisory for single-surface configs and is ignored beyond the first entry in multi-surface configs (see § 3.4).
- **No major version bump.** This release is additive: single-surface configs and single-surface consumers see no behaviour change beyond the new `surface_list_surfaces` tool appearing.
- **No closure-bound server actions, GraphQL, WebSockets, OAuth.** Out of scope per `SPEC.md` § 2 and unchanged here.

---

## 3. Existing code map (READ THESE BEFORE WRITING ANY CODE)

The implementation must read and modify the following files. Files to **read** establish patterns; files to **edit** are the ones that change.

### 3.1 Files you MUST read before writing any code

- `/root/SurfaceMCP/src/config.ts` — Zod `ConfigSchema`, `SurfaceConfigSchema`. The schema already accepts `surfaces: z.array(...).min(1)` — no schema change is required for the array itself. New validation rules go HERE, not in a new file.
- `/root/SurfaceMCP/src/types.ts` — `Config`, `SurfaceConfig`, `ToolMeta`, `ToolCatalog`, `PageCatalog`, `NavigationCatalog`. New types added HERE.
- `/root/SurfaceMCP/src/server/http.ts` — `createApp(surface, root)`. This is the central rewrite: it must accept `Config` (multiple surfaces) and create per-surface state. Note `process.argv` entrypoint at the bottom that pulls `config.surfaces[0]!`.
- `/root/SurfaceMCP/src/server/tools-meta.ts` — module-level `let catalog`, `let pageCatalog` and the `getCatalog/getPageCatalog/regenerateCatalog` functions. Currently global; must become per-surface (a `Map<surfaceName, State>`).
- `/root/SurfaceMCP/src/server/navigation-catalog.ts` — same pattern, module-level `let navigationCatalog`. Must become per-surface.
- `/root/SurfaceMCP/src/server/tools-generated.ts` — `registerGeneratedTools(server, catalog, surface, roleMutex, root)`. Tool registration loop. Must produce surface-prefixed names.
- `/root/SurfaceMCP/src/server/call.ts` — `executeCall(...)`. Already takes `surface`-derived params (`baseUrl`, `auth`, `projectName`); no new logic needed here, just upstream wiring.
- `/root/SurfaceMCP/src/auth/role-mutex.ts` — `class RoleMutex`. Constructed once per surface (already correct), but currently SurfaceMCP creates one for `surfaces[0]` only. Must create one per surface.
- `/root/SurfaceMCP/src/cli/serve.ts` — entrypoint that calls `createApp(config.surfaces[0]!, ...)`. Must pass the whole `config`.
- `/root/SurfaceMCP/src/watch/chokidar-driver.ts` — `startWatcher(opts)`. Already accepts a list of paths; one watcher per surface (the simpler model — see § 6.3) or one combined watcher with surface-routing of events.
- `/root/BugHunter/packages/cli/src/adapters/surface-mcp.ts` — the consumer. **Read but do not modify.** This is the contract: the adapter calls `surface_list_tools`, `surface_call`, etc., already supports the `tools` array having metadata. The new `surface` field on `ToolMeta` will pass straight through.
- `/root/BugHunter/fixtures/bughunter-self-deliberate-bugs/surfacemcp.config.json` — the canonical multi-surface fixture. Six surfaces, mixed `openapi` + `vite` stacks, mixed roles vs anonymous. Use this as the integration-test target.

### 3.2 Patterns to follow

- **Per-surface state lifecycle:** mirror `RoleMutex`'s constructor pattern (per-surface instance owned by the parent). Hold all per-surface state in a single `SurfaceRuntime` value, indexed by `Map<surfaceName, SurfaceRuntime>`.
- **Logging:** every log line that mentions a surface includes `{ surface: <name> }` in the pino bindings. See `log.info({ stack, root }, 'regenerating tool catalog')` in `tools-meta.ts` — pattern is `log.info({ surface: surface.name, ... }, 'message')`.
- **Errors in tool responses:** existing `toolError(code, message)` shape in `http.ts`. Reuse; do not invent a new error envelope.
- **Discriminated unions over flag soup:** per `/root/.claude/CLAUDE.md`. New `SurfaceLifecycleState` is a discriminated union (see § 7.1), not `{ ok: boolean; error?: string; tools?: ToolMeta[] }`.
- **Zod-driven validation:** the Zod schema in `config.ts` is the validation source. Surface-name reserved-character checks go in `SurfaceConfigSchema.refine(...)`; cross-surface uniqueness goes in `ConfigSchema.refine(...)`.

### 3.3 DO NOT

- DO NOT create new files outside the list in § 9.1.
- DO NOT introduce a new MCP port or a routing layer "per surface URL". One process, one port, one `/mcp` endpoint.
- DO NOT add per-surface authentication on the MCP itself. SurfaceMCP is loopback-only; this is unchanged.
- DO NOT change the `ToolMeta` field semantics (`name`, `toolId`). Only ADD a new `surface` field. Existing fields keep their meaning so the existing `tools-naming.test.ts`, `extract.test.ts`, etc. still pass.
- DO NOT use `as any` to bridge the catalog map to the existing per-surface API surface. The map's value type IS the existing per-surface state, fully typed.
- DO NOT regenerate all catalogs synchronously on startup if any surface launches a slow dev server. Surface initialisation must be parallel-or-each-tolerant (see § 6.4).
- DO NOT assume `surfaces[0]` is special at the application level. The only place it remains special is the MCP listen port, and only because we have one process (see § 3.4).
- DO NOT bump SurfaceMCP to v1.0.0. Bump from `0.2.x` to `0.3.0`.

### 3.4 The one place `surfaces[0]` remains special

The MCP server listens on exactly one TCP port. We must pick one. Decision: **`config.mcpPort` if present, else `config.surfaces[0].port`.** All other surface `.port` values are ignored at runtime (they are still validated as numbers in the schema). `surfacemcp doctor` prints a warning if non-leading surfaces declare a different port than the leader.

This is documented in user-visible error messages and in `README.md`. It is NOT a hidden behaviour.

---

## 4. Config schema

### 4.1 Shape (additive)

The existing `ConfigSchema`:

```ts
const ConfigSchema = z.object({
  surfaces: z.array(SurfaceConfigSchema).min(1),
});
```

…becomes:

```ts
const ConfigSchema = z.object({
  surfaces: z.array(SurfaceConfigSchema).min(1),
  /** Optional: explicit MCP listen port. When unset, surfaces[0].port is used. */
  mcpPort: z.number().int().min(3102).max(3199).optional(),
}).superRefine((cfg, ctx) => {
  // (a) Surface names unique
  const names = cfg.surfaces.map((s) => s.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['surfaces'],
      message: `Duplicate surface name: "${dup}". Surface names must be unique.`,
    });
  }
});
```

`SurfaceConfigSchema.name` keeps `z.string().min(1)` and adds:

```ts
name: z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, {
    message:
      'Surface name must contain only [a-zA-Z0-9_-]. Reserved characters ":" and "." are not allowed because they are used in tool naming.',
  }),
```

### 4.2 Backwards compatibility

- A config with one surface is valid and unchanged in behaviour at the surface level.
- A config with N surfaces was previously valid at parse-time but only the first was served; now all are served.
- No new fields are required. `mcpPort` is optional.
- Reserved-character validation is NEW. A previously-loaded config with a surface name containing `:` or `.` will now fail at `loadConfig`. This is acceptable because (a) such names would have been silently broken under the new prefix scheme and (b) the existing fixture and the ones in `/root/SurfaceMCP/fixtures/**` use only `[a-zA-Z0-9_-]`.

### 4.3 What `surfaces[0]` means after this change

Three things only:
1. Used as the MCP listen port if `config.mcpPort` is unset.
2. The default surface for bare tool names in single-surface configs (i.e. when `surfaces.length === 1`). In multi-surface configs, bare names are an error.
3. Documented as the "first" surface in `surface_list_surfaces` output ordering (insertion order, not semantic).

Nothing else in the runtime branches on the surface index.

---

## 5. Tool naming convention

### 5.1 Wire format

A tool exposed by a surface named `S` whose bare name in the catalog is `T` appears on the wire as **`S:T`**. The colon `:` is the separator.

Examples (against the BugHunter self-test fixture):

```
self-api:get_api_users
self-api:post_api_users
self-spa:surface_list_pages       — wait, no: see § 5.6 about meta-tools
race-bad:get_api_orders
idor-bad:get_api_users_id_orders
```

### 5.2 Why `:` and not `.`

- `:` is standard URI-namespace syntax (`scheme:path`, `xmlns:tag`). Visually unambiguous as a separator.
- `.` reads as a property accessor and clashes with method-call notation; some MCP clients render it as part of the bare name (e.g. `getUser.v2`).
- The existing tool-naming convention (`get_api_users`, `serveraction_createUser__app_admin_users_page`) uses only `[a-zA-Z0-9_]`. `:` cannot collide with any existing bare name.
- MCP tool names are `string` per the spec (`@modelcontextprotocol/sdk` does not restrict character set on the server). `:` survives JSON serialization, URL paths (we are loopback POST-only, no path encoding needed), and pino structured logging.
- `.` would also work, but `:` is the stronger signal that the segment is a namespace, not a sub-name.

### 5.3 Where the prefix lives

Both the `name` field on `ToolMeta` AND the `name` registered with `McpServer.tool(name, ...)`. In `ToolMeta`:

```ts
export type ToolMeta = {
  /** Wire name with surface prefix in multi-surface configs; bare in single-surface configs. */
  name: string;
  /** Bare name as produced by the per-stack extractor, never prefixed. */
  bareName: string;
  /** Owning surface name. Always populated, even in single-surface configs. */
  surface: string;
  // ... existing fields unchanged ...
};
```

`bareName` is new. `surface` is new. `name` keeps its existing field name and meaning ("the name you call the tool by") but the value is now `<surface>:<bareName>` in multi-surface configs (or just `<bareName>` in single-surface configs).

`toolId` (sha1 hash) is unchanged — see § 5.5.

### 5.4 Collision handling

Two layers:

1. **Cross-surface bare-name collisions are allowed and harmless** because the wire name carries the surface prefix. `self-api:get_api_users` and `idor-bad:get_api_users` are distinct on the wire.

2. **Within a surface**, the existing collision dedup in `extract/nextjs/routes.ts` (and equivalents) applies unchanged — two routes resolving to the same bare name within one surface get `..._2` suffix per `SPEC.md` § 3.7.

3. **Surface-name collisions are caught at config-load time** (§ 4.1's `superRefine` block). Two surfaces with the same `name` is a fatal validation error.

### 5.5 `toolId` — globally unique even across surfaces

Today `toolId = sha1(method + ':' + normalizedPath).slice(0, 12)`. Two surfaces with the same `(method, path)` would collide. Fix:

```ts
toolId = sha1(`${surfaceName}:${method}:${normalizedPath}`).slice(0, 12)
```

This is a **stable hash change** for tools in single-surface configs (the surface name now factors into the hash). Acceptable because:
- `toolId` was documented as opaque/internal in `SPEC.md` § 3.6.
- BugHunter's `cluster-keying` uses `toolId` per `SPEC.md` § 3.6, but BugHunter recomputes from the live catalog on each run; nothing persists `toolId` across SurfaceMCP versions.
- Single-surface single-process upgrades will see new `toolId` values; this is documented in the v0.3.0 release notes and CHANGELOG.

### 5.6 Meta-tools (`surface_list_tools`, `surface_call`, etc.) are NOT prefixed

The eleven meta-tools registered by `registerMetaTools` (§ `http.ts` lines 118–438) are global to the SurfaceMCP process, not per-surface. They keep their bare names: `surface_list_tools`, `surface_describe_tool`, `surface_call`, `surface_probe`, `surface_sample_inputs`, `surface_login_status`, `surface_relogin`, `surface_describe_auth`, `surface_list_pages`, `surface_enumerate_routes_runtime`, `surface_postprocess_runtime_routes`, `surface_list_navigations`, `surface_describe_self`, `surface_routes_for_page`. Plus the new `surface_list_surfaces` (§ 7).

These names already start with the reserved `surface_` prefix; they will never collide with extractor-produced names (which are `<verb>_<path>` or `serveraction_<name>__<page>`).

Meta-tools that today operate on the implicit single surface (`surface_list_pages`, `surface_call`, `surface_describe_self`, `surface_describe_auth`, `surface_login_status`, `surface_relogin`, `surface_list_navigations`, `surface_routes_for_page`, `surface_enumerate_routes_runtime`, `surface_postprocess_runtime_routes`) gain an optional `surface?: string` parameter:

- If `surface` is provided, route to that surface.
- If omitted in a single-surface config, route to the only surface (back-compat).
- If omitted in a multi-surface config, return `error: { code: "surface_required", message: "Multiple surfaces are configured. Specify surface: <name>." }`.

`surface_list_tools` is the exception: it aggregates across all surfaces by default, with optional `filter.surface` to scope. See § 7.

### 5.7 Backwards compatibility for bare names (deprecation path)

| Config shape       | Bare-name call            | Prefixed-name call               |
|--------------------|---------------------------|----------------------------------|
| 1 surface          | OK (back-compat)          | OK                               |
| N surfaces (N > 1) | error `bare_name_ambiguous` | OK (only valid form)            |

The error response for a bare-name call in multi-surface mode:

```json
{
  "error": "bare_name_ambiguous",
  "message": "Bare tool name 'get_api_users' is ambiguous: matches surfaces [self-api, race-bad, idor-bad]. Call '<surface>:get_api_users'.",
  "candidates": ["self-api:get_api_users", "race-bad:get_api_users", "idor-bad:get_api_users"]
}
```

If the bare name matches exactly one surface in a multi-surface config, the response also returns `bare_name_ambiguous` (deliberately strict — avoid the agent learning to rely on accident-of-uniqueness behaviour). The error message lists the single candidate so the caller can correct in one round-trip.

A future v0.4.x deprecation pass can soften "single-surface bare names" with a warning log; v0.3.0 keeps it silent and working.

### 5.8 Reserved character validation

Already covered in § 4.1: surface names match `^[a-zA-Z0-9_-]+$`. No `:`, no `.`, no whitespace. Validated at `loadConfig`. The bare-name production rules in extractors are unchanged (they have always produced `[a-z0-9_]+` since `SPEC.md` § 3.7) and so cannot themselves contain `:`. A round-trip `<surface>:<bareName>` always splits unambiguously on the first `:`.

---

## 6. Tool dispatch routing

### 6.1 Lookup data structure

Per-surface state lives in a top-level map:

```ts
type SurfaceRuntime = {
  surface: SurfaceConfig;
  resolvedRoot: string;                 // resolve(projectRoot, surface.root)
  state: SurfaceLifecycleState;         // see § 7.1 — discriminated union
  catalog: ToolCatalog;                 // empty if state.kind !== 'ready'
  pageCatalog: PageCatalog;             // empty if state.kind !== 'ready'
  navigationCatalog: NavigationCatalog; // empty if state.kind !== 'ready'
  roleMutex: RoleMutex | undefined;     // undefined if state.kind === 'failed'
  watcher?: { close: () => Promise<void> };
};

type SurfaceRegistry = {
  surfaces: Map<string, SurfaceRuntime>;     // keyed by surface.name
  /** Insertion order — preserves config order for surface_list_surfaces output. */
  order: string[];
};
```

Resolution functions (replace today's module-level `getCatalog/getToolByName/getToolById`):

```ts
function resolveTool(
  registry: SurfaceRegistry,
  args: { name?: string; toolId?: string; surface?: string }
): { tool: ToolMeta; runtime: SurfaceRuntime } | { error: ResolveError };

type ResolveError =
  | { code: 'not_found'; message: string }
  | { code: 'bare_name_ambiguous'; message: string; candidates: string[] }
  | { code: 'unknown_surface'; message: string }
  | { code: 'surface_not_ready'; message: string; surface: string; state: SurfaceLifecycleState };
```

### 6.2 Resolution algorithm (pseudocode)

```
resolveTool(registry, { name, toolId, surface }):
  if toolId:
    for each runtime in registry.order:
      tool = runtime.catalog.tools.find(t => t.toolId === toolId)
      if tool: return { tool, runtime }
    return { error: { code: 'not_found', message: `toolId ${toolId}` } }

  if not name:
    return { error: { code: 'not_found', message: 'name or toolId required' } }

  if name contains ':':
    [surfaceFromName, bareName] = name.split(':', 2)
    runtime = registry.surfaces.get(surfaceFromName)
    if not runtime:
      return { error: { code: 'unknown_surface',
                        message: `Unknown surface "${surfaceFromName}". Known: ${registry.order.join(', ')}` } }
    if runtime.state.kind !== 'ready':
      return { error: { code: 'surface_not_ready', surface: surfaceFromName, state: runtime.state, message: ... } }
    tool = runtime.catalog.tools.find(t => t.bareName === bareName || t.name === name)
    if not tool: return { error: { code: 'not_found', message: `${name} not in surface ${surfaceFromName}` } }
    return { tool, runtime }

  // Bare name
  if surface:                                    // explicit surface filter wins
    runtime = registry.surfaces.get(surface)
    if not runtime: return { error: { code: 'unknown_surface', ... } }
    tool = runtime.catalog.tools.find(t => t.bareName === name)
    if not tool: return { error: { code: 'not_found', ... } }
    return { tool, runtime }

  if registry.order.length === 1:                // single-surface back-compat
    runtime = registry.surfaces.get(registry.order[0])!
    tool = runtime.catalog.tools.find(t => t.bareName === name)
    if not tool: return { error: { code: 'not_found', ... } }
    return { tool, runtime }

  // Multi-surface, bare name, no explicit surface — strict reject.
  candidates = []
  for each runtime in registry.order:
    if runtime.catalog.tools.some(t => t.bareName === name):
      candidates.push(`${runtime.surface.name}:${name}`)
  return { error: { code: 'bare_name_ambiguous',
                    message: `Bare tool name '${name}' requires a surface prefix in multi-surface configs.`,
                    candidates } }
```

### 6.3 Concurrency

- Multiple consumers calling tools across surfaces simultaneously: each call grabs `runtime.roleMutex` for its own surface; mutexes do not cross surfaces.
- Catalog regeneration for one surface (file-watcher fires) holds no lock against other surfaces' catalogs. Each `regenerate<Type>Catalog(runtime)` writes to its own runtime's fields; no global state.
- The `SurfaceRegistry` itself is constructed once at startup and is immutable thereafter (no surface add/remove during lifetime — § 2.2 non-goal). Read-only access from request handlers needs no lock.
- Per-surface `ToolCatalog.revision`, `PageCatalog.revision`, `NavigationCatalog.revision` are independent counters. The existing `surface_call` `pinRevision` mechanism continues to work, scoped to the surface owning the tool being called.

### 6.4 Error paths in `surface_call`

When `resolveTool` returns an error, `surface_call` returns:

```ts
{
  ok: false,
  error: { code: <ResolveError.code>, message: <ResolveError.message> },
  durationMs: 0,
  revisionAtCall: -1,                  // sentinel: no surface owns this call
  // For bare_name_ambiguous, also include candidates field at top level.
}
```

(`revisionAtCall: -1` is a discriminated sentinel; existing consumers either ignore it or treat negative as "no revision". BugHunter's adapter type `SurfaceCallResult` declares it `number`, no parse change.)

---

## 7. Surface metadata exposure

### 7.1 New tool: `surface_list_surfaces`

Top-level introspection. Lets BugHunter and other consumers learn the surface set without parsing every tool name.

```ts
server.tool(
  'surface_list_surfaces',
  'List all surfaces served by this SurfaceMCP instance, with stack, lifecycle state, and tool counts.',
  {},
  async () => toolOk(buildSurfaceListResponse(registry))
);

type SurfaceListResponse = {
  /** SurfaceMCP version. Useful for adapter capability negotiation. */
  surfaceMcpVersion: string;
  surfaces: SurfaceSummary[];
};

type SurfaceSummary = {
  name: string;
  stack: Stack;                                  // 'nextjs' | 'express' | ... | 'vite'
  baseUrl: string;
  state: SurfaceLifecycleState;
  toolCount: number;                             // 0 if not 'ready'
  pageCount: number;                             // 0 for stacks without page extraction
  navigationCount: number;                       // 0 for stacks without nav extraction
  toolRevision: number;                          // 0 if not 'ready'
  capabilities: {
    listPages: boolean;
    listNavigations: boolean;
    enumerateRoutesRuntime: boolean;
    crawlSeed: boolean;
  };
};

type SurfaceLifecycleState =
  | { kind: 'ready' }
  | { kind: 'extracting' }                       // initial extract still in flight
  | { kind: 'failed'; phase: 'extract' | 'login' | 'detect'; error: string };
```

Ordering: insertion order from `config.surfaces[]` (preserved via `registry.order`).

### 7.2 `surface_describe_self` — extended

Today returns one surface's metadata. After this spec, it returns:

```ts
{
  surfaceMcpVersion: string,
  surfaces: SurfaceSummary[],     // same shape as surface_list_surfaces.surfaces
}
```

This is a **shape change** for `surface_describe_self`. BugHunter's `SurfaceDescribeSelfResult` type is currently:

```ts
type SurfaceDescribeSelfResult = {
  name: string; stack: Stack; baseUrl: string;
  toolRevision: number; pageRevision: number;
  capabilities: { ... };
};
```

To preserve back-compat for adapters that have not been updated, `surface_describe_self` retains the old top-level fields (filled from the first surface) AND adds a new `surfaces: SurfaceSummary[]` field:

```ts
{
  // Legacy fields — populated from registry.order[0]:
  name: string,
  stack: Stack,
  baseUrl: string,
  toolRevision: number,
  pageRevision: number,
  capabilities: { ... },
  // New field — full multi-surface view:
  surfaceMcpVersion: string,
  surfaces: SurfaceSummary[],
}
```

The legacy fields are documented as deprecated in v0.3.0; they will be removed in v0.4.0. (Tracked as a TODO comment in `http.ts`.)

### 7.3 `surface_list_tools` — aggregation

Today returns `{ revision, tools }`. After this spec returns:

```ts
{
  /** Aggregate revision: sum of per-surface revisions, monotonic but not semantically meaningful as a count. */
  revision: number,
  /** Tools across all 'ready' surfaces, in insertion order of surface, then per-surface order. */
  tools: ToolMeta[],
  /** Per-surface revision map for fine-grained pinning. */
  surfaceRevisions: Record<string, number>,
}
```

`filter` extends with one new field:

```ts
filter?: {
  method?: string;
  sideEffect?: string;
  pathPrefix?: string;
  confidence?: string;
  surface?: string;                              // NEW: scope to one surface
}
```

`tools` from surfaces in `state.kind !== 'ready'` are absent. They appear in `surface_list_surfaces` with their failure state.

`pinRevision` semantics in `surface_call`: continues to mean "the revision of the surface this tool belongs to at the time you read it." Implementation reads `runtime.catalog.revision` for the resolved tool's surface, not the aggregate.

---

## 8. Tool list aggregation algorithm

### 8.1 Pseudocode

```
buildAggregateCatalog(registry):
  tools = []
  surfaceRevisions = {}
  aggRevision = 0
  for surfaceName in registry.order:
    runtime = registry.surfaces.get(surfaceName)
    surfaceRevisions[surfaceName] = runtime.catalog.revision
    aggRevision += runtime.catalog.revision
    if runtime.state.kind !== 'ready':
      continue                                   // failed surfaces contribute zero tools
    for tool in runtime.catalog.tools:
      tools.push(tool)                           // tool.name already prefixed (or bare for single-surface)
  return { revision: aggRevision, tools, surfaceRevisions }
```

Complexity: O(sum of tools across surfaces). Per-call; no caching needed (the underlying catalogs are already cached and only mutate on watcher events).

### 8.2 Lazy-loading semantics

Initial extraction happens at process startup, **per-surface in parallel**:

```
startup:
  registry = new SurfaceRegistry(config)
  await Promise.all(config.surfaces.map(async (surface) => {
    runtime = createSurfaceRuntime(surface)
    registry.add(runtime)
    try:
      runtime.state = { kind: 'extracting' }
      await regenerateCatalog(runtime)            // calls existing per-stack extractor
      await regeneratePageCatalog(runtime)
      await regenerateNavigationCatalog(runtime)
      await runtime.roleMutex.loginAll()
      runtime.state = { kind: 'ready' }
    catch (err):
      runtime.state = { kind: 'failed', phase: <phase>, error: String(err) }
      log.error({ surface: surface.name, err }, 'surface initialisation failed')
  }))
```

No lazy "first tools/list call" extraction. Reasons:
- The existing single-surface code extracts at startup; preserving that timing means a multi-surface upgrade cannot regress startup observability.
- `surface_list_surfaces` becomes a useful liveness probe immediately after startup.
- BugHunter's first call is typically `surface_list_tools`; lazy extraction would add unpredictable latency to the first agent call.

Cache invalidation: file-watcher per surface, debounced 1500ms, calls `regenerate*Catalog(runtime)` exactly as today; the only change is the runtime parameter is per-surface, not implicit.

### 8.3 Watcher topology

One chokidar watcher per surface, scoped to `runtime.resolvedRoot + (surface.watchPaths ?? defaults)`. Reasons:
- `surface.watchIgnore` is per-surface; combining watchers makes it harder to apply per-surface ignores.
- A watcher event in `apps/web/` should regen `apps/web/`'s catalog, not `apps/api/`'s. Per-surface watcher gives this for free.
- Performance: chokidar's per-watcher overhead is negligible (a few hundred bytes); for the 6-surface fixture this is well under any meaningful threshold.

---

## 9. Per-surface lifecycle and failure isolation

### 9.1 Lifecycle states (§ 7.1 definition)

- `extracting` — initial extract in flight. Tools list is empty for this surface.
- `ready` — extract completed, login completed (or `auth.kind === 'none'`). Tools available.
- `failed` — extract OR login OR detect threw. The `phase` field tells which; the `error` field is `String(err)` (no stack trace; pino logs hold the stack).

`failed` is terminal in v0.3.0 (no auto-retry; restart the process to retry). A failed surface's `surface_call` invocations return `surface_not_ready`. A failed surface's tools are absent from `surface_list_tools`. The surface still appears in `surface_list_surfaces` with its `failed` state — explicit, debuggable, not silent.

### 9.2 Behaviour table

| Action                                | `ready`    | `extracting`                  | `failed`                       |
|---------------------------------------|------------|--------------------------------|--------------------------------|
| Tools in `surface_list_tools`         | included   | absent                         | absent                         |
| Entry in `surface_list_surfaces`      | present    | present                        | present                        |
| `surface_call` resolves               | dispatches | error `surface_not_ready`      | error `surface_not_ready`      |
| `surface_describe_tool` resolves      | works      | error `surface_not_ready`      | error `surface_not_ready`      |
| Watcher events processed              | yes        | enqueued; processed at `ready` | ignored (terminal)             |

### 9.3 Process-level safety

The startup `Promise.all(...)` block must NOT propagate any single surface's rejection. Use the per-iteration try/catch shown in § 8.2's pseudocode. The HTTP server starts listening regardless of how many surfaces failed; `surface_list_surfaces` is the diagnostic.

If ALL surfaces fail (extract or login on every one), the HTTP server still starts, returns the meta-tools, and `surface_list_surfaces` reports the failure set. This is the correct behaviour for a debugging tool: visible failure, not silent crash.

---

## 10. Auth / role propagation

### 10.1 Per-surface roles

`auth` and `roles` are per-`SurfaceConfig` already. Each `SurfaceRuntime` constructs its own `RoleMutex`. A consumer's `surface_call({ name: 'idor-bad:get_api_users_id', role: 'admin', ... })` resolves the tool to `idor-bad`, looks up `runtime.roleMutex` for that surface, and calls `ensureSession('admin')` on `idor-bad`'s mutex. The `admin` role for `self-api` is a different role on a different mutex.

### 10.2 Role lookup error path

If the role does not exist on the resolved surface, `RoleMutex.refresh(roleName)` already throws `Unknown role: <name>`. `executeCall` already surfaces this. No new code path.

If a consumer calls `surface_call({ name: 'self-api:get_api_users', role: 'alice' })` and `self-api` has no `alice` role (only `idor-bad` does), the existing error message is sufficient: `Unknown role: alice`. The error happens inside the correct surface's mutex, so the consumer can correlate.

### 10.3 No cross-surface role lookup

There is no fallback: if `self-api` has no `alice`, SurfaceMCP does not try `idor-bad`'s `alice`. Roles are private to their surface (per § 2.2 non-goal "no surface-level auth federation").

---

## 11. Migration plan

### 11.1 Existing single-surface user (most common)

- `surfacemcp.config.json` has one surface. **No change required.**
- Existing consumer code calling `surface_call({ name: 'get_api_users', role: 'owner' })` continues to work — bare name resolves to the only surface.
- New tool `surface_list_surfaces` appears in their `tools/list` output. Their consumer either ignores it or (BugHunter case) starts using it.
- New field `surface` on every `ToolMeta` is populated with the single surface's name. Adapters that don't know about it ignore it; adapters that do (BugHunter v0.4) use it for filtering.
- `toolId` values change because surface name now factors into the hash (§ 5.5). Documented in CHANGELOG; impacts no persisted state in any known consumer.

### 11.2 Multi-surface user (the BugHunter fixture, etc.)

- Existing config with N surfaces is now FULLY served instead of partially.
- Bare-name calls FAIL with `bare_name_ambiguous`. Fix: prefix with `<surface>:`.
- For BugHunter specifically: the adapter at `/root/BugHunter/packages/cli/src/adapters/surface-mcp.ts` does not need code changes — it passes through whatever `surface_list_tools` returns. The toolName values it sees become prefixed; it uses them as-is in subsequent `surface_call` invocations. No round-trip parsing required.
- Consumer code that hard-codes bare tool names (e.g. test fixtures) needs the prefix added. This is the only consumer-side migration cost.

### 11.3 `surfacemcp doctor` enhancements

Adds (in this spec — see § 9.1's file list):
- Lists every surface and its lifecycle state.
- Warns on per-surface port conflicts (`surfaces[1..].port !== mcpPort`).
- Reports `surface_list_surfaces` output as the canonical source of truth.

---

## 12. Test strategy

### 12.1 Unit tests (Vitest, fast)

| Test                                                           | File (new or existing)                       |
|----------------------------------------------------------------|----------------------------------------------|
| Zod schema accepts N surfaces                                  | `src/config.test.ts` (NEW)                   |
| Zod rejects duplicate surface names                            | `src/config.test.ts` (NEW)                   |
| Zod rejects surface name with `:` or `.`                       | `src/config.test.ts` (NEW)                   |
| `mcpPort` defaults to `surfaces[0].port` when unset            | `src/config.test.ts` (NEW)                   |
| `resolveTool` — prefixed name routes to right surface          | `src/server/resolve-tool.test.ts` (NEW)      |
| `resolveTool` — bare name in single-surface returns the tool   | `src/server/resolve-tool.test.ts` (NEW)      |
| `resolveTool` — bare name in multi-surface returns ambiguity   | `src/server/resolve-tool.test.ts` (NEW)      |
| `resolveTool` — unknown surface in prefix returns typed error  | `src/server/resolve-tool.test.ts` (NEW)      |
| `resolveTool` — toolId scans all surfaces                      | `src/server/resolve-tool.test.ts` (NEW)      |
| Tool name has `surface:` prefix in multi-surface config        | `src/server/tools-naming.test.ts` (EXTEND)   |
| Tool name is bare in single-surface config                     | `src/server/tools-naming.test.ts` (EXTEND)   |
| `toolId` is stable for given (surface, method, path)           | `src/server/tools-naming.test.ts` (EXTEND)   |
| `toolId` differs across surfaces with same (method, path)      | `src/server/tools-naming.test.ts` (EXTEND)   |
| `buildAggregateCatalog` includes only `ready` surfaces         | `src/server/aggregate.test.ts` (NEW)         |
| Failed surface appears in `surface_list_surfaces` with state   | `src/server/aggregate.test.ts` (NEW)         |

### 12.2 Integration test (Vitest with HTTP fixture)

`src/server/multi-surface.integration.test.ts` (NEW):

1. **Setup:** create a temp directory with three minimal surfaces:
   - `surfaces[0]`: `openapi` stack pointing at a fixture `openapi.json` with two routes.
   - `surfaces[1]`: `express` stack pointing at a tiny in-process Express app with three routes.
   - `surfaces[2]`: `openapi` stack pointing at a malformed `openapi.json` (so it fails to extract).
2. Boot SurfaceMCP via `createApp(config, root)`.
3. Assert `surface_list_surfaces` returns three entries; first two `ready`, third `failed` with `phase: 'extract'`.
4. Assert `surface_list_tools` returns 5 tools (2 + 3 + 0); each name starts with `<surfaceName>:`.
5. Assert `surface_call({ name: 'surfaces[1].name:get_users', role: 'anon' })` dispatches to the express app.
6. Assert `surface_call({ name: 'get_users', role: 'anon' })` (bare) returns `bare_name_ambiguous`.
7. Assert `surface_call({ name: 'surfaces[2].name:foo', role: 'anon' })` returns `surface_not_ready`.
8. Assert one healthy surface still serves while another is failed (already covered by 4 + 5).

### 12.3 Smoke test against the BugHunter self-test fixture

`scripts/smoke-multi-surface.sh` (NEW, callable from CI):

```bash
cd /root/BugHunter/fixtures/bughunter-self-deliberate-bugs
SURFACEMCP_CONFIG=./surfacemcp.config.json node /root/SurfaceMCP/dist/server/http.js &
SMCP_PID=$!
sleep 5
curl -s -X POST -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"surface_list_surfaces","arguments":{}}}' \
  http://127.0.0.1:3140/mcp | jq '.result.content[0].text | fromjson | .surfaces | length'
# Expect: 6
curl -s -X POST -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"surface_list_tools","arguments":{}}}' \
  http://127.0.0.1:3140/mcp | jq '.result.content[0].text | fromjson | .tools | length'
# Expect: SUM of tool counts across all 6 surfaces (>= 50 vs today's ~16).
kill $SMCP_PID
```

Note: the fixture's `launchDevCommand` per surface will spawn six dev servers. The smoke test must either (a) skip surfaces whose `baseUrl` is unreachable (the `extract` phase handles this for `openapi` stacks; `vite` stacks need a running dev server) or (b) pre-launch the dev servers separately. The implementation must handle "extractor cannot reach baseUrl" by transitioning the surface to `failed` with `phase: 'extract'`, NOT crashing.

### 12.4 Contract test: BugHunter adapter unchanged

`/root/BugHunter/packages/cli/test/surface-mcp-multi.contract.test.ts` (NEW, lives in BugHunter; this spec only declares the requirement — the actual test is BugHunter's responsibility):

- Construct `HttpSurfaceMcpAdapter('http://127.0.0.1:3140')`.
- Call `surface_list_tools()` against a running multi-surface SurfaceMCP.
- Assert the returned `tools[].name` values include `:` separators.
- Assert subsequent `surface_call({ name: tools[0].name, role: 'anon', input: {} })` succeeds (i.e. the adapter passes the prefixed name through verbatim).

This contract test pins the no-change-required guarantee.

---

## 13. Phasing

Each phase is independently shippable and tested. Coder picks them in order; do not interleave.

### Phase 12.1 — Core multi-surface + prefix + dispatch (the load-bearing change)

- Files modified: `config.ts`, `types.ts`, `server/http.ts`, `server/tools-meta.ts`, `server/tools-generated.ts`, `server/navigation-catalog.ts`, `cli/serve.ts`, `auth/role-mutex.ts` (no logic change; just confirm per-instance ownership).
- Files created: `src/server/registry.ts` (the `SurfaceRegistry` + `resolveTool`), `src/server/resolve-tool.test.ts`, `src/config.test.ts`, `src/server/tools-naming.test.ts` extensions.
- Bare-name back-compat for single-surface configs only.
- All meta-tools (except `surface_list_tools`) gain optional `surface?: string` parameter.
- Per-surface watcher topology.
- Acceptance: § 12.1 unit tests + § 12.2 integration test green.

### Phase 12.2 — Surface metadata endpoint

- Files modified: `server/http.ts` (add `surface_list_surfaces`), update `surface_describe_self` to return both legacy and new shape.
- Files created: `src/server/surface-list.ts` (build response), `src/server/surface-list.test.ts`.
- Acceptance: `surface_list_surfaces` returns full registry view; `surface_describe_self` retains legacy fields and adds new ones.

### Phase 12.3 — Per-surface failure isolation

- Files modified: `server/http.ts` (the `Promise.all` startup wrapper), `server/registry.ts` (state transitions).
- Files created: `src/server/aggregate.test.ts` (failure-isolation tests).
- Acceptance: § 12.2 integration test point 7 passes; injecting a malformed surface does not crash the process.

### Phase 12.4 — Doctor + deprecation warnings

- Files modified: `cli/doctor.ts` (multi-surface awareness), `cli/serve.ts` (warn on bare-name fallback in single-surface configs — INFO-level log on first bare-name call).
- Files created: none.
- Acceptance: `surfacemcp doctor` against the BugHunter fixture lists six surfaces with state.

Phases 12.1 and 12.2 are mandatory for v0.3.0 release. 12.3 should ship in v0.3.0 (low risk, additive). 12.4 can slip to v0.3.1.

---

## 14. Acceptance criteria

### 14.1 Process-level

1. `npx tsc --noEmit` clean from `/root/SurfaceMCP`.
2. `npx eslint . --max-warnings 0` clean.
3. `npx vitest run` green, including all new tests in § 12.1 and 12.2.
4. `npm run build` succeeds.

### 14.2 Behaviour-level

5. Against `/root/BugHunter/fixtures/bughunter-self-deliberate-bugs/surfacemcp.config.json`:
   - `surface_list_surfaces` returns six entries (one per declared surface).
   - At least four of them reach `state.kind === 'ready'` when their dev servers are launched (the OpenAPI stacks should always reach ready since they read static specs; the Vite stacks reach ready when their dev server is up).
   - `surface_list_tools` returns the SUM of per-surface tool counts (today: ~16 from one surface; goal: 50+ when all six contribute, exact number per fixture).
   - Every tool name in the returned list contains exactly one `:` (the surface prefix).
6. `surface_call({ name: '<surface>:<tool>', role, input })` dispatches to the correct surface and returns the live response.
7. `surface_call({ name: '<bareTool>', ... })` against the multi-surface fixture returns `error.code === 'bare_name_ambiguous'` with non-empty `candidates`.
8. Manually corrupting one surface (e.g. point its `openapi` `root` at a non-existent file) leaves the other five surfaces serving normally; the corrupted surface appears in `surface_list_surfaces` with `state.kind === 'failed'` and `phase === 'extract'`.
9. Single-surface fixture (`/root/SurfaceMCP/fixtures/express-app` or similar with one surface) continues to serve bare tool names without error; `surface_list_surfaces` returns one entry; `surface_describe_self` retains legacy fields populated.

### 14.3 Downstream consumer (BugHunter) — proof of unchanged contract

10. With HEAD SurfaceMCP and the unchanged BugHunter `HttpSurfaceMcpAdapter`, `bughunter run` against the self-test fixture reports `toolCount` equal to the SUM across all six surfaces.
11. Smoke test #9 in BugHunter's self-test (cross-cutting kind coverage) detects BOTH UI-kind findings AND API-kind findings in a single run, because the SPA surfaces (`self-spa`, `v24-deferred-bugs`) AND the API surfaces (`self-api`, `race-bad`, `idor-bad`, `pen-bad`) are all live in the same SurfaceMCP process.

(Acceptance criteria 10 and 11 are the user-facing definition of "this works." They prove the spec's premise: SurfaceMCP did its job, BugHunter didn't have to.)

---

## 15. Non-goals reinforced

The following are explicitly OUT of v0.3.0 scope and each warrants a separate spec if pursued:

- **Cross-surface tool composition** ("call all surfaces' health-checks at once," "join SPA route to API call"): a future SPEC_SURFACE_FANOUT.md.
- **Federated authentication** (one login spans surfaces): a future SPEC_SURFACE_AUTH_FEDERATION.md. Likely controversial; do not bake in.
- **Per-surface rate limits, quotas, observability dashboards:** a future SPEC_SURFACE_TELEMETRY.md.
- **Hot-reload of the surface set** (add/remove surface without process restart): a future SPEC_SURFACE_HOT_RELOAD.md. Watcher-driven config reload is plausible but adds substantial state-machine complexity; not now.
- **Multiple MCP listen ports per process** (one /mcp per surface): rejected. The single-endpoint contract is the entire point of this spec.
- **Surface aliases** (one config-level name maps to multiple physical surfaces): rejected as confusing.
- **Cross-surface `pinRevision`** ("abort if any surface revved"): the per-surface revision in `surfaceRevisions` map is sufficient; consumers can cross-check themselves.

---

## 16. Definition of Done

A reviewer can:

```bash
cd /root/SurfaceMCP
npm ci && npm run build && npx vitest run               # green

# Single-surface back-compat
cd /root/SurfaceMCP/fixtures/express-app
node /root/SurfaceMCP/dist/server/http.js &
SMCP=$!
curl -s -X POST -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"surface_list_tools","arguments":{}}}' \
  http://127.0.0.1:3102/mcp | jq '.result.content[0].text | fromjson | .tools | length'
# >= 1, names are bare (no ":")
kill $SMCP

# Multi-surface (the load-bearing test)
cd /root/BugHunter/fixtures/bughunter-self-deliberate-bugs
SURFACEMCP_CONFIG=./surfacemcp.config.json node /root/SurfaceMCP/dist/server/http.js &
SMCP=$!
sleep 5
curl -s -X POST ... surface_list_surfaces  # returns 6 entries
curl -s -X POST ... surface_list_tools     # tools array length is the sum across surfaces, every name contains ":"
curl -s -X POST ... surface_call name="self-api:get_api_users" role="anon" input={}
                                            # returns the real response from the self-api dev server
kill $SMCP
```

…and a fresh `bughunter run` against the same fixture reports `toolCount` matching the sum and finds both UI-kind and API-kind issues in one run.

---

End of spec.
