# SPEC — Surface diffing (snapshots + breaking-change detection)

Status: implemented (v0.3.x). Additive: no extractor, `toolId` hashing, or
existing tool behaviour changes.

## Problem

SurfaceMCP already discovers a target app's API surface and gives every route a
stable `toolId` (`sha1(METHOD:path)`, operation-keyed for GraphQL). Nothing
consumed that stability *over time*:

- A PR could delete a route, make a body field required, or flip a `GET` handler
  to a mutating one, and neither CI nor a downstream agent would notice until a
  call failed at runtime.
- Downstream agents (BugHunter) re-scan the whole surface every run because there
  is no "what changed since last time" signal to prioritise.

`toolId` is exactly the join key a diff needs, so this is nearly free.

## Design

### `src/diff/surface-diff.ts` — the pure diff

`diffCatalogs(before: ToolMeta[], after: ToolMeta[]): SurfaceDiff`. No I/O, no
config, no extraction. Tools are joined on `toolId`; the result is
`added[]`, `removed[]`, `changed[]` plus a `summary`.

Each `changed` tool carries a flat `changes: ToolChange[]`:

```ts
type ToolChange = {
  field: 'name' | 'method' | 'path' | 'surface' | 'sideEffectClass'
       | 'inputSchemaConfidence' | 'isServerAction' | 'inputSchema' | 'outputSchema';
  property?: string;   // dotted path within the schema: `user.email`, `tags[]`, '' = root
  kind: 'replaced' | 'added' | 'removed' | 'retyped' | 'widened' | 'narrowed'
      | 'became_required' | 'became_optional'
      | 'constraint_tightened' | 'constraint_loosened';
  before?: string;     // human-readable rendering
  after?: string;
  breaking: boolean;
  reason: string;      // which rule fired, and why
};
```

Schema comparison is structural, not a stringified equality check: it walks
`properties` and `required` recursively (depth-guarded at 6, so a `$ref`-expanded
cycle can't spin), descends into array `items`, and compares the *set of accepted
JSON types* (`type`, `type[]`, `enum`/`const` member types, `anyOf`/`oneOf`
members) rather than the literal `type` keyword. `integer` is treated as a subset
of `number`. Purely annotative keywords (`description`, `title`, `default`,
`examples`, `$comment`, `deprecated`, `readOnly`, `writeOnly`) are ignored so a
docstring edit never shows up as an API change.

### Breaking vs non-breaking

"Breaking" means *a caller that worked against `before` may stop working against
`after`*. Direction matters, and the rules are polarity-flipped between the two
schema slots: a caller must **satisfy** an input, and **relies on** an output,
so tightening an input and loosening an output are the same kind of break.

| Change | `inputSchema` | `outputSchema` |
|---|---|---|
| property added, required | **breaking** | non-breaking |
| property added, optional | non-breaking | non-breaking |
| property removed, was required | **breaking** | **breaking** |
| property removed, was optional | non-breaking | **breaking** |
| became required | **breaking** | non-breaking |
| became optional | non-breaking | **breaking** |
| type narrowed / enum gained or shrunk / untyped→typed | **breaking** | non-breaking |
| type widened / enum dropped or grown | non-breaking | **breaking** |
| incompatible retype (`string`→`number`, enum swapped) | **breaking** | **breaking** |
| constraint tightened (`minLength` ↑, `maximum` ↓, new `pattern`/`format`) | **breaking** | non-breaking |
| constraint loosened | non-breaking | **breaking** |
| whole schema appeared | **breaking** (if typed) | non-breaking |
| whole schema disappeared | non-breaking | **breaking** |

Non-schema rules:

- **removed tool** — always breaking (`breaking: true` on the `removed[]` entry).
- **added tool** — never breaking.
- **`sideEffectClass`** — leaving `safe` (`safe`→`mutating`, `safe`→`external`)
  is breaking: an agent that treated the call as a free read now mutates state or
  hits a third party. Becoming `safe`, or moving between `mutating` and
  `external`, is not.
- **`inputSchemaConfidence`** — never breaking in either direction. Confidence
  describes how well *we* recovered the schema, not the target's contract. Still
  reported, with a `reason` distinguishing improvement from regression, so an
  `introspected` → `unknown` extraction regression is visible.
- **`name`, `surface`, `isServerAction`** — reported, non-breaking. The wire name
  is derived from method/path plus the surface prefix, so a rename re-labels the
  same endpoint.
- **`method` / `path` under a stable `toolId`** — breaking. Only reachable if the
  hashing changed underneath us or a snapshot was hand-edited; surfaced loudly
  rather than silently diffing two unrelated endpoints.

A pattern change is classified as a tightening in either direction (removal being
the only provably safe move) because proving one regex weaker than another means
solving language inclusion.

### Determinism

`added` / `removed` / `changed` are sorted by `toolId`; each tool's `changes` by
(field order, property, kind). Shuffling either input catalog produces
byte-identical JSON, so a diff can be committed and reviewed.

### `src/diff/snapshot.ts` — the snapshot format

```jsonc
{
  "snapshotVersion": 1,
  "surface": "app",
  "revision": 1,
  "tools": [ /* ToolMeta[], sorted by toolId */ ]
}
```

`serializeSnapshot` emits keys in lexicographic order at every level, 2-space
indented, trailing newline. Array order is preserved — only key order is
canonicalized, so a `required` array is never silently rewritten (the diff treats
it as a set anyway). Nothing timestamp-, path-, or machine-dependent is stored: a
`createdAt` would make every regeneration a diff, defeating the point of
committing the file.

`parseSnapshot` accepts a full envelope, a bare `ToolCatalog`
(`{ revision, tools }`), or a bare `ToolMeta[]`, and validates only the fields the
join needs (a string `toolId`), so a snapshot written by an older build still
diffs. A `snapshotVersion` newer than the running build is rejected rather than
mis-parsed.

## CLI

```
surfacemcp snapshot [--surface=<name>] [--out=<file>]
surfacemcp diff --before=<snapshot.json> [--after=<snapshot.json>]
                [--surface=<name>] [--out=<file>] [--fail-on-breaking]
```

- `snapshot` runs extraction only — no server, no login — reusing the exact
  acquisition path `export` uses (`regenerateCatalogForSurface` + `getCatalog`).
- `diff` compares two snapshot files; with `--after` omitted it extracts the live
  surface and diffs the stored baseline against it.
- **Machine-readable JSON goes to stdout** (or `--out`), the **human summary to
  stderr** — the repo convention (`src/log.ts`) that keeps `… | jq` clean.
- `--fail-on-breaking` exits 1 when any tool carries a breaking change. The CI
  gate:

```yaml
- run: npx surfacemcp diff --before=surface.snapshot.json --fail-on-breaking > /dev/null
```

Comparing snapshots from two different surfaces emits a stderr note, because
`toolId` is surface-scoped in multi-surface configs and everything would look
added/removed.

## MCP tool

`surface_diff` — `before` (required), `after` (optional), `surface` (optional).
Snapshots are passed **inline** in any of the shapes `parseSnapshot` accepts;
the tool reads no files, so it adds no filesystem or path-traversal surface. With
`after` omitted it diffs against the resolved surface's live catalog. Failures
use the existing `toolError` convention (`bad_snapshot`, `surface_required`).

## Tests

- `src/diff/surface-diff.test.ts` — added/removed/changed detection, every
  breaking and non-breaking rule in both polarities, nested-object and array-item
  recursion, determinism under shuffled input, empty/degenerate catalogs,
  GraphQL operation-keyed ids (distinct operations sharing `POST /graphql`), and
  the stderr summary renderer.
- `src/diff/snapshot.test.ts` — stable key order, array-order preservation,
  round-trip through `parseSnapshot`, the accepted input shapes, and rejection of
  malformed / future-versioned snapshots.

## Backwards compatibility

Purely additive. No extractor, `toolId` hash, existing CLI command, or existing
MCP tool changes behaviour; the only `http.ts` edit is one new `server.tool(...)`
registration plus its imports.
