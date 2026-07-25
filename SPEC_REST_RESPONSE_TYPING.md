# SPEC: Response typing (`outputSchema`) for the source-analysed REST stacks

Status: implemented
Branch: `feat/rest-response-typing`

---

## 1. Problem

`ToolMeta.outputSchema` has existed since the typed-call-surface work, but only
three of the nine extractors ever populated it — `src/extract/openapi/parse.ts`,
`src/extract/fastapi/openapi-fetch.ts` and `src/extract/graphql/*`. Those three
all have a *declared* schema to read.

Every tool extracted from **Express, Next.js, NestJS, Fastify or Django**
therefore advertised its inputs and said nothing about its outputs. An agent
driving the app (BugHunter and friends) can construct a valid request but has no
basis on which to assert on the response: it cannot tell a 200-with-an-error-body
from a real success, cannot know which keys to read, and cannot detect a
contract regression.

The gap has to be closed **statically** — the extractors run without the target
app necessarily being up — and therefore **best-effort**. Emitting a wrong schema
is worse than emitting none, so every path below is written to degrade to "no
schema" rather than to guess.

## 2. Design

### 2.1 `outputSchemaConfidence`

A new optional field on `RawToolMeta` / `ToolMeta`, mirroring
`inputSchemaConfidence` and narrowed to the two values a *populated* response
schema can carry (the field is absent whenever `outputSchema` is absent, so
there is no 'unknown' state to encode):

```ts
export type OutputSchemaConfidence = Extract<InputSchemaConfidence, 'introspected' | 'inferred'>;
```

- `introspected` — the app declares the response shape and we read it verbatim:
  an OpenAPI/FastAPI `responses` entry, a Fastify `schema.response[2xx]`, a
  GraphQL SDL return type, a Nest `@ApiResponse({ type })`.
- `inferred` — derived from source analysis the framework does not treat as a
  contract: a TS return type or generic, a `res.json(...)` literal, a DRF
  `serializer_class`.

Optional, so no existing consumer is affected. It is set **iff** `outputSchema`
is set, including on the three extractors that already populated `outputSchema`
(OpenAPI/FastAPI → `introspected`; GraphQL schema-first → `introspected`,
code-first → `inferred`, matching that extractor's own input confidence).

`src/export/openapi.ts` emits it as `x-surfacemcp-output-confidence` alongside
the existing `x-surfacemcp-input-confidence`, and omits the extension when the
tool has no response schema.

### 2.2 Shared type walk — `src/extract/ts-type-schema.ts`

The NestJS extractor already had a good TS-type → JSON Schema walk (arrays,
nested DTOs with depth + cycle guards, enums, class-validator refinements) built
for `inputSchema`. Response typing needs exactly that walk for NestJS return
types, Express `Response<T>` and Next.js `NextApiResponse<T>` / `NextResponse<T>`,
so it moved into a shared module rather than being written a second time.

The module exports:

| Export | Purpose |
| --- | --- |
| `TypeIndex`, `buildTypeIndex`, `indexSourceFiles` | name → declaration maps for one extraction pass |
| `schemaForTypeText`, `schemaForBaseType`, `declarationToSchema` | the type walk (`MAX_TYPE_DEPTH = 5`, cycle-guarded via a `visited` set) |
| `unwrapAsyncType`, `genericArgument` | peel `Promise<...>`; read `Wrapper<T, …>`'s first type argument |
| `schemaForValueExpression` | infer a schema from a literal *value* (the `res.json(...)` argument) |
| `isInformativeSchema` | gate: `{}` and a bare `{type:'object'}` say nothing, so they are never published |

**NestJS behavior is unchanged by construction.** `TypeIndex` carries separate
maps for classes, enums, interfaces and type aliases, and interfaces/aliases are
only populated when the caller passes `includeShapes: true`. NestJS builds its
index with the defaults, leaving those maps empty, so every lookup resolves
exactly as it did when they did not exist. Express and Next.js opt in, because
their apps declare response bodies as plain TS shapes rather than classes. The
existing NestJS suite (including the pinned toolIds and DTO schemas) is the
regression test for this.

Status-code selection is likewise shared: `pickSuccessResponseKey` in
`src/extract/common.ts` (200 → 201 → other explicit 2xx → `2xx` wildcard →
`default` → any remaining 2xx, case-insensitive) now backs both the OpenAPI
extractor and Fastify.

### 2.3 Per-stack extraction

| Stack | Source | Confidence |
| --- | --- | --- |
| **Fastify** | `schema.response[<2xx>]`, read verbatim; the OpenAPI-flavoured `{ content: { 'application/json': { schema } } }` wrapper is unwrapped | `introspected` |
| **NestJS** | `@ApiResponse` / `@ApiOkResponse` / `@ApiCreatedResponse` / `@ApiAcceptedResponse` / `@ApiDefaultResponse` with a `type` option (`type: [X]` and `isArray: true` wrap in an array; a non-2xx `status` is skipped) | `introspected` |
| **NestJS** | otherwise the declared return type — `ItemDto`, `ItemDto[]`, `Promise<ItemDto[]>` — resolved through the shared DTO walk | `inferred` |
| **Express** | a typed `res` parameter: `(req, res: Response<Body>)` | `inferred` |
| **Express** | otherwise a single unambiguous `res.json(<literal>)` (a `res.status(n).json(...)` chain counts) | `inferred` |
| **Next.js** (App Router) | a declared `Promise<NextResponse<T>>` return type, else the verb's own `NextResponse.json(...)` / `Response.json(...)` calls | `inferred` |
| **Next.js** (Pages Router) | the `NextApiResponse<T>` generic, else the handler's `res.json(...)` calls; applied to every verb the file serves | `inferred` |
| **Django** | the view's DRF `serializer_class` → serializer fields; array-wrapped when the handler serializes a collection (`Serializer(qs, many=True)`, or a generic `List*` / `*ViewSet` base handling a GET on a collection path); DELETE is skipped (204, no body) | `inferred` |

Fastify is the highest fidelity of the five: Fastify actually *enforces*
`schema.response` at serialization time, so the declared schema is a contract
rather than a description. Express is the weakest, which is why it needs two
independent signals and refuses ambiguity.

### 2.4 Guards

- **Ambiguity.** Where a schema is inferred from `res.json(...)` call sites, all
  the call sites in a handler must agree structurally. A handler with an early
  `return res.status(400).json({ error })` and a success `res.json({ items })`
  emits nothing — there is no single response shape to advertise.
- **Emptiness.** `isInformativeSchema` drops `{}` and bare `{type:'object'}`, so
  a resolution that learned nothing publishes nothing.
- **Recursion.** Every recursive walk (TS types, response value literals, DRF
  serializers) is depth-bounded at 5 and carries a `visited` set; a cycle
  degrades to `{ type: 'object' }` rather than spinning.
- **Never throws.** Next.js response typing is wrapped in a `try`/`catch` that
  degrades to "no schema": response typing must not be able to break route
  discovery.
- **`required` semantics.** Type-derived object schemas carry `required` (TS
  optionality is declared). Value-derived and serializer-derived schemas do not:
  an unseen branch or a `SerializerMethodField` returning `None` means the key
  set is a hint, not a contract.

### 2.5 What is explicitly out of scope

`toolId` hashing, tool names, `inputSchema` and every existing assertion are
untouched. The change is purely additive: a tool either gains two new optional
fields or is byte-identical to before.

## 3. Known limits, per stack

- **Fastify** — only inline JSON literals resolve. A `$ref`, an imported schema
  constant, or a TypeBox/Zod builder (`Type.Object(...)`) is skipped.
- **NestJS** — handlers with neither a Swagger decorator nor a declared return
  type emit nothing (the common case in an untyped codebase). Return types
  imported from outside the scanned tree do not resolve. `@ApiResponse` with a
  `schema` option (rather than `type`) is not read.
- **Express** — the weakest stack. A handler that delegates response writing to a
  helper, uses `res.send`, or branches to different shapes emits nothing. An
  object-literal body reports its key set with the value types it can see; a key
  whose value comes from a call or an `await` is reported as `{}` (present, type
  unknown), which is deliberate — the key set is the useful part.
- **Next.js** — response types are resolved **per file**. A body type imported
  from a shared `types.ts` will not resolve; the extractor reports no schema
  rather than a wrong one. Server actions are unaffected (they are not HTTP
  routes with a response body in this sense).
- **Django** — `serializer_class` must be a literal name on the view class.
  `get_serializer_class()` overrides, `fields = '__all__'`, model-derived field
  types, `SerializerMethodField` return types and `to_representation` overrides
  do not resolve. `DecimalField` is typed as a number even though DRF renders it
  as a string unless `COERCE_DECIMAL_TO_STRING` is off — that setting is not
  visible from the serializer. Pagination wrappers
  (`{count, next, previous, results}`) are not modelled.

## 4. Tests

- `src/extract/ts-type-schema.test.ts` — the shared walk in isolation: interfaces,
  aliases, enums, arrays, the depth ceiling and cycle guard, the
  `includeShapes: false` (NestJS) configuration, and value-literal inference.
- `src/extract/{fastify,nestjs,express,nextjs,django}/response.test.ts` — one per
  stack: fixture-level assertions pinning the emitted `outputSchema` and
  confidence, plus scratch-directory edge cases (ambiguous branches, unresolvable
  references, multi-verb routes, multi-prefix mounts). Each fixture suite also
  re-asserts the pinned toolIds / names / input schemas to prove nothing moved.
- `src/extract/common.test.ts` — `pickSuccessResponseKey` preference order.
- Retrofit assertions in `src/extract/openapi/response.test.ts`,
  `src/extract/fastapi/openapi-fetch.test.ts`,
  `src/extract/graphql/{parse,code-first}.test.ts`.
- `src/export/openapi.test.ts` — the `x-surfacemcp-output-confidence` extension.

Fixtures extended minimally: Fastify gains `response` maps (200, 201-without-200,
lowercase `2xx`), NestJS gains a response-DTO module plus return types and one
`@ApiResponse`, Express gains a typed `Response<T>` handler, Django gains a
`serializers.py` and `serializer_class` attributes. The Next.js fixture already
exercised `NextResponse.json(<literal>)` and was left alone. No
`MUST_DISCOVER.json` pins a schema, so none needed updating.
