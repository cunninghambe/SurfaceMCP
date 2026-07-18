# SPEC — Typed call surface (path params + schema conversion)

Status: implemented (v0.3.x). Closes two gaps where the extracted metadata was
discarded before it reached the MCP caller, undercutting the core product promise
of a *typed, callable* surface.

## Problem

1. **Path parameters were never substituted.** `executeCall` fetched
   `${baseUrl}${tool.path}` verbatim, so any parameterized route
   (`/api/users/:id`, `/users/{id}`, `/articles/<int:pk>`) was uncallable with a
   real value — the id stayed literal in the URL and the caller's `id` leaked
   into the query string or body instead.

2. **Extracted input schemas were dropped at the MCP boundary.** `jsonSchemaToZod`
   was a stub returning `z.record(z.unknown())` for every tool, so the per-route
   schemas recovered by zod-introspection / OpenAPI / probe were invisible to
   agents — every tool advertised an untyped `input`.

## Design

### Path parameters (`src/server/path-params.ts`)

- `extractPathParams(path)` recognizes all three syntaxes the stack extractors
  emit: `:name` (Express/Next.js), `{name}` (OpenAPI/FastAPI), `<name>` /
  `<converter:name>` (Django). Names are de-duplicated in source order.
- `substitutePathParams(template, input)` replaces every token in a **single
  regex pass** (so `:id` cannot clobber `:idcard`), URL-encoding each value, and
  returns the concrete path plus the set of consumed keys. A path parameter that
  is absent / null / empty in `input` yields `{ ok: false, missing }`.
- `withPathParams(schema, params)` folds the path parameters into the tool's
  JSON Schema as required `string` properties (without overwriting a richer
  existing definition) so the generated tool advertises them.

In `executeCall`, substitution runs before the URL is built; the consumed keys
are stripped from `bodyInput` so they are never sent twice. A missing path
parameter returns a typed `missing_path_param` error **without** issuing a
request. Object/array-valued query params are now JSON-encoded rather than
stringifying to `"[object Object]"`.

### Schema conversion (`src/server/schema-to-zod.ts`)

`jsonSchemaToZod(schema)` converts Draft 2020-12 JSON Schema to a Zod type:

- objects → `z.object` with required/optional properties; `additionalProperties:
  false` → `.strict()`, otherwise `.passthrough()` (agents may add path params;
  introspected schemas may be partial)
- strings → `format` (email/url/uuid/date-time), `minLength`/`maxLength`,
  `pattern` (invalid regexes are skipped, not fatal)
- numbers/integers → `minimum`/`maximum`, exclusive bounds, `multipleOf`
- arrays → item type + `minItems`/`maxItems`
- `enum` / `const` → enum / literal; `anyOf`/`oneOf` → union; `['T','null']` →
  `.nullable()`
- recursion is depth-guarded (cyclic `$ref`) and falls back to an open record

The historical pass-through for a bare `{type:'object'}` (accept any body) is
preserved so existing untyped tools behave exactly as before.

## Backwards compatibility

- Tools with no path parameters and no usable schema behave identically (open
  record input, verbatim path).
- `toolId`s are unchanged — this only affects call-time URL construction and the
  advertised parameter schema, not extraction.

## Tests

- `src/server/path-params.test.ts` — extraction across all syntaxes, single-pass
  substitution, missing-param handling, encoding, `withPathParams` merge.
- `src/server/schema-to-zod.test.ts` — every supported keyword + fallback.
- `src/server/call.test.ts` — `executeCall` against a throwaway server proving
  GET/POST substitution, body omission, the `missing_path_param` short-circuit,
  and object-query JSON-encoding.
