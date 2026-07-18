# SPEC — GraphQL stack

Status: implemented (`feat/graphql-stack`). Adds GraphQL as the 8th supported
stack. GraphQL is a paradigm shift from the REST stacks: a GraphQL API exposes a
**single** HTTP endpoint (usually `POST /graphql`) and encodes the operation in the
request **body** as a query string, not in the URL. Every downstream assumption
that keys a tool on `method:path` therefore has to be revisited.

## Discovery

- **Source:** schema-first SDL. `src/detect/graphql.ts` (`isGraphql`) does a
  depth-bounded (≤3) walk for a `.graphql` / `.gql` file whose text declares a
  `type Query` or `type Mutation` root. Requiring a root type keeps a stray
  fragment or client-side codegen `.graphql` document from being mistaken for a
  standalone GraphQL surface.
- **Detection order** (`src/detect/index.ts`): placed **after** the framework
  detectors (nextjs/vite/django/express/fastify/fastapi) and before `openapi`, so
  an app that merely uses GraphQL client-side is still classified by its framework.
  Like OpenAPI, it is a schema-file detector, so it sits with OpenAPI at the tail.
- **Parser:** the `graphql` npm package (`buildSchema`), added as an exact
  dependency (`graphql@16.11.0`, MIT, zero-dependency). A real parser is far more
  robust than a hand-rolled SDL reader for `!` / `[]` wrappers, input objects,
  enums, and interfaces. `src/extract/graphql/parse.ts` builds a schema from the
  **combined** text of all SDL files (so schemas split across files work); on a
  build failure (typically a duplicate definition) it falls back to the first
  individual file that builds and declares a root type.

## Operation → tool mapping

One MCP tool per top-level **Query** and **Mutation** field (introspection
meta-fields — names starting `__` — are skipped). For `type Query { user(id: ID!): User }`:

| Field         | tool `name`            | `method` | `path`            | `sideEffectClass` |
| ------------- | ---------------------- | -------- | ----------------- | ----------------- |
| Query field   | `query_<field>`        | `POST`   | `graphqlPath`     | `safe`            |
| Mutation field| `mutation_<field>`     | `POST`   | `graphqlPath`     | `mutating`        |

- **name:** built by a small local helper `operationToolName` — `pathToToolName`
  is path-based (all GraphQL tools share one path) and cannot express the
  operation, so it is deliberately not used here.
- **path:** the configured GraphQL endpoint (`surface.graphqlPath`, default
  `/graphql`), threaded through `extractRaw` in `tools-meta.ts`.
- **method:** always `POST`.
- **sideEffectClass:** Query → `safe`, Mutation → `mutating`, decided from the
  operation type at extraction (see the call-graph note below).

### toolId scheme

`toolId` **cannot** be `sha1(method:path)` — every GraphQL tool shares
`POST <graphqlPath>`, which would collide them all onto one id. Instead, mirroring
the server-actions precedent (`sha1(serveraction:name:file)`):

```
toolId = sha1('graphql:' + operationType + ':' + field).slice(0, 12)   // raw / extractor level
```

These are pinned in `fixtures/graphql-app/MUST_DISCOVER.json` and asserted in
`src/extract/graphql/parse.test.ts`. Because they key on the operation, not the
path, they are stable across a `graphqlPath` change.

**Catalog level:** `applyPrefix` in `tools-meta.ts` re-derives a surface-scoped id
for every tool. The old `prefixedToolId(surface, method, path)` would collide all
GraphQL tools (same `POST <path>`), so `prefixedToolId` was made GraphQL-aware:
when `tool.graphql` is set it keys on `surface:graphql:operationType:field`; REST
tools keep `surface:method:path` **byte-for-byte** unchanged.

## inputSchema (from arguments)

`buildInputSchema` maps a field's arguments to a JSON Schema `object`:

- scalars: `ID`/`String` → `string`, `Int` → `integer`, `Float` → `number`,
  `Boolean` → `boolean`; custom scalars → `string`.
- `!` (non-null) at the top of an arg/field type → the property is `required`.
- `[T]` → `{ type: 'array', items: <T> }`.
- `enum` → `{ type: 'string', enum: [...] }`.
- input object types → nested `object` with its own `properties`/`required`,
  recursively; recursive input types are cycle-guarded (a repeat type becomes an
  open object). `additionalProperties: false`.
- confidence is always `introspected` — the SDL is authoritative.

## outputSchema (from return type)

`buildOutputAndSelection` maps the field's return type to an `outputSchema`
(reusing the existing optional `outputSchema` on `RawToolMeta`):

- scalar/enum return → the mapped scalar/enum schema (no selection set).
- object/interface return → an `object` expanded **exactly one level deep**:
  scalar/enum leaf fields become properties; nested object/list-of-object fields
  are emitted as opaque `{ type: 'object' }` / `{ type: 'array' }` markers.
- list wrapping (`[User!]!`) is preserved as `{ type: 'array', items: <object> }`.

**Depth limit:** one level. Nested objects are not expanded — documented, and the
reason the selection set (below) is shallow.

## Callability

REST `executeCall` posts `inputSchema` as a JSON body to `path`; that is wrong for
GraphQL, where the body must be `{ "query": "<operation>", "variables": {...} }`.

- **Descriptor.** `RawToolMeta`/`ToolMeta` gains an optional
  `graphql?: GraphQLToolDescriptor` (`{ operationType, field, args: {name, gqlType}[], selection? }`).
  Optional, so REST tools are unaffected. `args` carries each argument's SDL type
  string (e.g. `ID!`, `NewUserInput!`) — needed to emit valid GraphQL variable
  declarations. (`argNames` would be `args.map(a => a.name)`; the fuller shape is a
  documented deviation from the prompt's illustrative `argNames`.) `selection` is a
  space-separated list of scalar leaf field names, synthesized at extraction; it is
  absent for scalar returns and falls back to `__typename` when an object return
  type has no scalar leaf fields.
- **Request build** (`src/server/graphql-request.ts`). `buildGraphqlOperation`
  produces `<opType> <field>(<$var decls>) { <field>(<arg: $var>) <selection> }`,
  omitting each clause when empty (no args → no parens; scalar return → no
  selection block). `buildGraphqlBody` wraps it as `{ query, variables }` with the
  caller's `input` as `variables`. Values are never interpolated into the query
  text — only `$variables` — so operation building is injection-free.
- **executeCall branch** (`src/server/call.ts`). When `tool.graphql` is set,
  `fetchBody` is the GraphQL body and the request is a plain `POST` to the endpoint
  (`Content-Type: application/json`, already set by `buildHeaders`). The branch is
  guarded strictly on `tool.graphql`; the REST GET/POST/query-string path is
  untouched.

### What works vs. deferred

- **Fully working:** schema-first discovery; operation→tool mapping; operation-keyed
  toolIds (raw + catalog); arg→inputSchema; return→outputSchema (one level);
  end-to-end callability (well-formed `{ query, variables }` POST, verified against
  a throwaway HTTP server).
- **Deferred / limits:** code-first schemas (decorators, `typeDefs` template
  literals in TS) — schema-first SDL only. Output/selection depth is one level
  (nested objects not expanded/selected). Subscriptions are ignored (Query +
  Mutation only). Multi-file schemas that fail a combined build fall back to the
  first buildable file rather than stitching. `surfacemcp export` (OpenAPI) still
  keys on `method:path`, so it collapses GraphQL tools onto one entry — a follow-up.

## Config

`SurfaceConfig` / the Zod `SurfaceConfigSchema` gain an optional
`graphqlPath?: string` (default `/graphql`, graphql stack only). `init.ts` seeds
graphql defaults (baseUrl `http://localhost:4000`, watch `['.', 'src']`).

## Side-effect classification (call-graph note)

`regenerateCatalog` normally re-runs `classifyByCallGraph`, which returns `safe`
only for `GET/HEAD/OPTIONS`. Since every GraphQL tool is `POST`, that would force
every Query to `mutating`. So `regenerateCatalog` **preserves** the extractor's
`sideEffectClass` for GraphQL tools (Query `safe` / Mutation `mutating`) and skips
the call-graph pass for them; REST classification is unchanged. (SDL has no
resolver code to scan for external integrations anyway.)

## Tests & fixture

- `fixtures/graphql-app/` — `schema.graphql` (two Query fields incl. one with an
  arg; a Mutation with an input object; an enum), `package.json`,
  `surfacemcp.config.json` (`stack: "graphql"`), `MUST_DISCOVER.json` (pinned
  operation toolIds).
- `src/detect/detect.test.ts` — detects `graphql` for the fixture.
- `src/extract/graphql/parse.test.ts` — pinned toolIds/names/sideEffectClass,
  arg→inputSchema (required, nested input), return→outputSchema (list/enum/one
  level), the graphql descriptor, `graphqlPath` threading, posix `sourceFile`.
- `src/server/graphql-request.test.ts` — operation/body building for query,
  mutation, no-args, scalar-return, and multi-arg cases; each generated operation
  is re-parsed with `graphql`'s `parse` to prove validity.
- `src/server/graphql-call.test.ts` — `executeCall` against a throwaway server
  proving the POST hits the endpoint verbatim with a well-formed `{ query,
  variables }` body and inputs never leak into the URL.
