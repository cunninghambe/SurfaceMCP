# SPEC — GraphQL stack

Status: implemented (`feat/graphql-stack`). Adds GraphQL as the 8th supported
stack. GraphQL is a paradigm shift from the REST stacks: a GraphQL API exposes a
**single** HTTP endpoint (usually `POST /graphql`) and encodes the operation in the
request **body** as a query string, not in the URL. Every downstream assumption
that keys a tool on `method:path` therefore has to be revisited.

Enhanced on `feat/graphql-depth-codefirst`: (1) selection sets / `outputSchema` now
expand to a **bounded depth** (default 3) with cycle protection, and (2) **code-first**
(decorator-driven) schemas are discovered in addition to schema-first SDL. See the
"Deep selection" and "Code-first discovery" sections below.

## Discovery

- **Source:** schema-first SDL **or** code-first decorators.
  - *Schema-first:* `src/detect/graphql.ts` (`isGraphql`) does a depth-bounded (≤3)
    walk for a `.graphql` / `.gql` file whose text declares a `type Query` or
    `type Mutation` root. Requiring a root type keeps a stray fragment or
    client-side codegen `.graphql` document from being mistaken for a standalone
    GraphQL surface.
  - *Code-first:* the same `isGraphql` also returns true for a project with a
    `type-graphql` / `@nestjs/graphql` dependency **and** a `@Resolver`/`@Query`/
    `@Mutation` decorator in source (depth-bounded ≤4 walk). Both signals are
    required so merely listing the dep, or a stray decorator name, can't false-positive.
    See "Code-first discovery" for the detection-order caveat vs. `nestjs`.
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
- object/interface return → an `object` expanded up to **`DEFAULT_SELECTION_DEPTH`
  levels deep** (see "Deep selection"): scalar/enum leaf fields become properties;
  a nested object/interface field is expanded recursively while depth remains and no
  cycle is on the path, otherwise it is an opaque `{ type: 'object' }` / `{ type:
  'array' }` marker.
- list wrapping (`[User!]!`) is preserved as `{ type: 'array', items: <object> }`.

### Deep selection (bounded depth + cycle protection)

`DEFAULT_SELECTION_DEPTH` (a named constant in `parse.ts`, currently **3**) bounds
how many object-nesting levels `outputSchema` and the generated selection set
expand. `expandObject(type, levels, visited)` drives both in lockstep:

- **Leaves.** Scalar/enum fields always become schema properties and enter the
  selection (`id name email`).
- **Nesting.** A nested object/interface field expands recursively **iff**
  `levels > 1` *and* its named type is not already on the current path (`visited`).
  The recursive call decrements `levels` and copies `visited` **per branch**, so two
  sibling fields of the same type each expand (a diamond is fine); only a true cycle
  *along one path* is cut.
- **Boundary.** When the depth budget runs out *or* a cycle is detected, the field
  becomes an opaque `{ type: 'object' }` marker and is **not** selected (selecting an
  object needs a sub-selection we've chosen to stop emitting). This is what bounds
  the query size and guarantees a self-referential type (`type Employee { manager:
  Employee }`) terminates — expansion keeps the scalar leaves and drops the recursive
  field.
- **Never empty.** An object with no selectable field one level down falls back to
  `__typename`, so `{ }` (invalid GraphQL) is never emitted; e.g. `type Node { child:
  Node }` yields `Node { __typename }`.

Example (depth 3): `Organization → Person → Address → Country` yields selection
`id name ceo { id name address { street city } }` — the fourth level (`Country`)
truncates to an opaque marker.

## Callability

REST `executeCall` posts `inputSchema` as a JSON body to `path`; that is wrong for
GraphQL, where the body must be `{ "query": "<operation>", "variables": {...} }`.

- **Descriptor.** `RawToolMeta`/`ToolMeta` gains an optional
  `graphql?: GraphQLToolDescriptor` (`{ operationType, field, args: {name, gqlType}[], selection? }`).
  Optional, so REST tools are unaffected. `args` carries each argument's SDL type
  string (e.g. `ID!`, `NewUserInput!`) — needed to emit valid GraphQL variable
  declarations. (`argNames` would be `args.map(a => a.name)`; the fuller shape is a
  documented deviation from the prompt's illustrative `argNames`.) `selection` is a
  space-separated selection set synthesized at extraction — scalar leaf field names
  plus nested `field { … }` blocks up to `DEFAULT_SELECTION_DEPTH` (see "Deep
  selection"). It is absent for scalar returns and falls back to `__typename` when an
  object return type exposes no selectable field at its boundary. Deeply nested
  selections are still injection-free (only `$variables` carry values) and still
  re-parse cleanly with `graphql`'s `parse`.
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

## Code-first discovery

Many GraphQL servers are **code-first**: the schema lives in TypeScript decorators
(`@ObjectType`/`@Field`/`@Resolver`/`@Query`/`@Mutation`/`@Arg`) from `type-graphql`
or `@nestjs/graphql`, with no SDL file. `src/extract/graphql/code-first.ts`
(`extractGraphqlCodeFirst`) discovers these with ts-morph and emits tools that are
**indistinguishable from schema-first ones** downstream — same operation-keyed
`computeGraphqlToolId`/`operationToolName` (imported from `parse.ts`, single-sourced),
same `POST <graphqlPath>`, same `graphql` descriptor — so `graphql-request.ts` /
`executeCall` handle them unchanged.

- **Wiring** (`tools-meta.ts`): the `graphql` case runs schema-first first and only
  falls back to code-first **when SDL extraction yields zero tools**. A schema-first
  project is therefore byte-for-byte unaffected.
- **Resolver walk:** each `@Resolver` class's methods decorated `@Query()` /
  `@Mutation()` become a tool. The field name is the method name, overridable via a
  `{ name }` decorator option. Query → `safe`, Mutation → `mutating`. `@Subscription`
  is out of scope.
- **Args → inputSchema:** `@Arg('name', () => T)` / `@Args('name')` params map to
  `inputSchema` properties and to the descriptor's `args` (with an SDL type string for
  the variable declaration, e.g. `ID!`, `NewRecipeInput!`). Nullability comes from the
  `?` token, a `| null|undefined` union, an initializer, or a `{ nullable: true }`
  option. `@InputType` classes are expanded recursively (cycle-guarded). The type
  thunk (`() => Int`) wins over the TS annotation; a bare `number` defaults to `Float`.
- **Return → outputSchema/selection:** the `@Query`/`@Mutation` return thunk
  (`() => [Recipe]`) gives the named type + list-ness; `@ObjectType` classes are
  expanded with the **same** `DEFAULT_SELECTION_DEPTH` + cycle logic as schema-first
  (`expandObjectClass` mirrors `expandObject`).
- **Confidence:** `inferred` (not schema-first's `introspected`) — the schema is
  reconstructed from TS types + decorator options heuristically, not from authoritative
  SDL.

### Detection-order caveat (honest limitation)

`isNestjs` runs **before** `isGraphql` in `detect/index.ts`. So a `@nestjs/graphql`
app that *also* exposes REST `@Controller`s is classified `nestjs`, and its resolvers
are **not** surfaced as GraphQL tools. A standalone `type-graphql` app — or a Nest app
with resolvers but no controllers (no `@Controller`, no `@nestjs/common` import) —
falls through to `isGraphql` and is classified `graphql`. Reordering to give a
GraphQL-carrying Nest app both REST and GraphQL tools is a deliberate follow-up, not
done here to avoid destabilizing existing `nestjs` detection.

### What works vs. deferred

- **Fully working:** schema-first discovery; operation→tool mapping; operation-keyed
  toolIds (raw + catalog); arg→inputSchema; return→outputSchema now expanded to
  `DEFAULT_SELECTION_DEPTH` (3) levels with cycle protection; end-to-end callability
  (well-formed `{ query, variables }` POST, verified against a throwaway HTTP server).
- **Code-first (new, working):** detection + extraction for `type-graphql`-style
  resolvers (and structurally `@nestjs/graphql`, whose decorator names match) — tools,
  args, input/output schemas, deep selection, all keyed and callable exactly like
  schema-first. Covered by `fixtures/graphql-codefirst-app/` + `code-first.test.ts`.
- **Deferred / limits:**
  - *Code-first type mapping is heuristic.* TS→GraphQL scalar mapping is best-effort
    (`number`→`Float`; custom scalars→`string`); an unresolved return type gets an
    opaque schema and no selection; an unresolved field is treated as a selectable
    leaf. A registered enum (`registerEnumType`) is handled as a leaf but its JSON
    type is a plain `string` (values not enumerated).
  - *`@ArgsType` flattening not done.* An unnamed `@Args() dto: SomeArgsType` becomes a
    single arg named after the parameter rather than flattening the class's fields into
    top-level operation arguments. Named `@Arg('x')` / `@Args('x')` are handled.
  - *`@nestjs/graphql` + REST controllers* → classified `nestjs` (see caveat above).
  - *typeDefs template literals* (SDL embedded in a TS string) are still not read.
  - Subscriptions ignored (Query + Mutation only). Multi-file SDL that fails a combined
    build falls back to the first buildable file. `surfacemcp export` (OpenAPI) still
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
- `src/detect/detect.test.ts` — detects `graphql` for the schema-first fixture, the
  deep/cyclic fixture, and the code-first fixture.
- `src/extract/graphql/parse.test.ts` — pinned toolIds/names/sideEffectClass,
  arg→inputSchema (required, nested input), return→outputSchema (list/enum/nested),
  the graphql descriptor, `graphqlPath` threading, posix `sourceFile`.
- `src/server/graphql-request.test.ts` — operation/body building for query,
  mutation, no-args, scalar-return, and multi-arg cases; each generated operation
  is re-parsed with `graphql`'s `parse` to prove validity.
- `src/server/graphql-call.test.ts` — `executeCall` against a throwaway server
  proving the POST hits the endpoint verbatim with a well-formed `{ query,
  variables }` body and inputs never leak into the URL.

### Deep + code-first fixtures/tests (`feat/graphql-depth-codefirst`)

- `fixtures/graphql-deep-app/` — `schema.graphql` with a 4-level chain
  (`Organization → Person → Address → Country`) and a self-referential `Employee`
  (`manager: Employee`, `reports: [Employee!]!`).
- `src/extract/graphql/deep.test.ts` — asserts `DEFAULT_SELECTION_DEPTH === 3`, the
  bounded 3-level selection/`outputSchema` (Country truncates), self-referential
  termination (`Employee` → `id name`, cyclic fields opaque), and that the deep +
  cyclic operations re-parse with `graphql`'s `parse`.
- `fixtures/graphql-codefirst-app/` — a `type-graphql` project (`src/recipe.resolver.ts`
  with `@ObjectType`/`@InputType`/`@Resolver`/`@Query`/`@Mutation`/`@Arg`), `package.json`
  (no express/nestjs deps, so earlier detectors miss), `surfacemcp.config.json`,
  `MUST_DISCOVER.json` (pinned operation toolIds — the same scheme as schema-first).
- `src/extract/graphql/code-first.test.ts` — pinned toolIds/names/sideEffect, `@Arg`
  → inputSchema (nested `@InputType`), the descriptor with SDL arg types + nested
  selection, nested `outputSchema`, posix `sourceFile`, generated operations re-parse,
  and `[]` for a project with no resolvers.
