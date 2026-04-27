# SPEC v0.2 — Closure-bound Server Action Discovery

Status: SPEC — ready for implementation
Owner: @architect
Implementer: @coder (single PR, no cross-repo coupling required)
Supersedes the `TODO(spec)` at `src/extract/nextjs/server-actions.ts:7-8`.

---

## 1. Problem

SurfaceMCP v0.1 discovers Next.js server actions only when they are wired through `<form action={fn}>` in a page-component file. Real Next.js 15 codebases author server actions in three additional patterns: a file-level `'use server'` module exporting async RPCs (Pattern A), an inline `'use server'` directive at the top of a function body in a server component (Pattern B), and a server action passed through props to a client component (Pattern D). v0.2 extends `extractServerActions` to cover all four patterns, emit a correctly-scoped `toolId` derived from the action's definition file (not the consuming page), and preserve the v0.1 form-action behaviour as a regression gate.

The downstream `isServerAction: true` consumer contract — BugHunter `phases/plan.ts:82` skips server-action tools from API direct-call because they require React Flight encoding plus a `Next-Action` header — is load-bearing and MUST NOT change. v0.2 only widens *which* actions are discovered; it does not change what consumers do with them.

---

## 2. Pattern catalog

### Pattern A — File-level `'use server'` module
The first non-comment statement of the file is the directive `'use server';`. Every export must be `async` (Next.js 15 enforces this at compile time). Action symbol = export name. Definition file = the module.

```ts
// app/actions/orders.ts
'use server';
export async function createOrder(data: { productId: string; qty: number }) { /* ... */ }
```

AST signal: `SourceFile.getStatements()[0]` is an `ExpressionStatement` whose expression is a `StringLiteral` with text `'use server'` (or `"use server"`). Comments and other directives must be tolerated before this — collect leading directives only, take statements until the first non-string-literal-statement.

### Pattern B — Inline `'use server'` (function-level, in a server component)
A function-component scope contains a nested `async function` whose first statement is the `'use server';` directive. The host file does NOT have `'use client'` and does NOT have file-level `'use server'`. Action symbol = the inner function name. Definition file = the host file.

```tsx
// app/admin/inline-action/page.tsx
export default function Page() {
  async function archiveOrder(id: string) {
    'use server';
    // ...
  }
  return <button onClick={() => archiveOrder('x')}>Archive</button>;
}
```

AST signal: any `FunctionDeclaration` / `ArrowFunction` / `FunctionExpression` whose `Block` body's first statement is an `ExpressionStatement` over `StringLiteral('use server')`. Anonymous arrow functions without a binding name are out of scope (we cannot toolId them stably) and MUST be skipped with a debug-log only.

### Pattern C — `<form action={fn}>` (already covered by v0.1)
Form element with a JSX expression `action={ident}`. v0.1 lives at `src/extract/nextjs/server-actions.ts:94-122`. Action symbol = the JSX expression text (stripped of `props.` prefix). Definition file = the page file containing the JSX (today). v0.2 keeps that exact derivation for the form-bound branch as a regression gate, EXCEPT when the same action symbol is also discovered via Pattern A or B in the same scan — in which case the form-bound entry is dropped (deduped) by the canonical `definitionFile + name` key. See §3.5.

### Pattern D — Server action passed via props to a client component
A server-component file imports a name from a `'use server'` module (Pattern A) and passes it through JSX as a prop. The consumer is `'use client'`. We do NOT discover a *new* tool for the prop usage — Pattern A already discovered the underlying action. We DO need the call-site mapping for `surface_routes_for_page` to link the consuming page back to the existing action's `toolId` (§3.6).

```tsx
// app/admin/orders/page.tsx — server component
import { createOrder } from '@/app/actions/orders';
export default function Page() {
  return <ClientOrderForm action={createOrder} />;
}
```

AST signal for the *mapping* (not for new discovery): for every page file (server or client), collect every named import whose source resolves to a Pattern-A module discovered in this scan. Those imports become the page's "uses these server actions" mapping.

---

## 3. Discovery algorithm

### 3.1 Internal types (new)

In `src/extract/nextjs/server-actions.ts`, introduce:

```ts
export type ServerActionKind = 'file-level' | 'function-level' | 'form-bound';

export type ServerActionParam = {
  name: string;
  /** Lowercase JSON-Schema primitive plus 'object' / 'array' / 'formdata' / 'unknown'. */
  jsonType: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'formdata' | 'unknown';
  /** Recursive properties when jsonType === 'object'. */
  properties?: Record<string, ServerActionParam>;
  /** Whether the parameter / property is required (non-optional). */
  required: boolean;
  /** Format hint, e.g. 'email', when introspectable. Optional. */
  format?: string;
};

export type ServerAction = {
  name: string;
  kind: ServerActionKind;
  /** Path of the file that DEFINES the action, relative to project root. */
  definitionFile: string;
  /** 1-indexed line where the action's identifier is declared. */
  definitionLine: number;
  /** Top-level positional parameters, in order. */
  parameters: ServerActionParam[];
  /** Pre-computed JSON Schema for the first parameter (or merged FormData fields). */
  schema: import('../../types.js').JsonSchema2020;
  schemaConfidence: import('../../types.js').InputSchemaConfidence;
};
```

These types are NOT exported beyond `server-actions.ts` and `server-actions.test.ts`. The public surface remains `extractServerActions(root): Promise<ToolMeta[]>`.

### 3.2 `findServerActionDefinitions(root)` — internal

Function signature:

```ts
async function findServerActionDefinitions(root: string): Promise<ServerAction[]>
```

Algorithm, executed in this exact order:

1. Walk the standard Next.js source roots: `app/`, `src/app/`, `pages/`, `src/pages/`. Reuse the existing `walkDir` helper. Filter to `.ts | .tsx | .js | .jsx`, excluding `.test.` / `.spec.` files. (v0.1 only walked `app/`; v0.2 widens this to match `routes.ts`.)
2. Build a single `Project` (`useInMemoryFileSystem: false`, no `tsConfigFilePath`) and `addSourceFileAtPath` for every walked file. One project per `extractServerActions` call to keep the type checker hot.
3. For each source file, classify the file-level directive state:
   - `fileDirective: 'use-server' | 'use-client' | 'none'` by inspecting `sf.getStatements()[0..N]` while they are `ExpressionStatement → StringLiteral`. Stop at the first non-directive statement. Take the first matching directive (`'use server'` or `'use client'`).
   - If `fileDirective === 'use-client'`, skip the file entirely for action *definition* discovery. (It will still participate in §3.6 prop-mapping.)
4. **Pattern A — file-level**: if `fileDirective === 'use-server'`, iterate every exported function declaration:
   - `sf.getFunctions().filter(f => f.isExported() && f.isAsync())`
   - default exports declared as `export default async function name() {}`
   - `export const name = async (…) => {…}` (variable declaration with `async` arrow / function expression initialiser)
   - For each, produce a `ServerAction` with `kind: 'file-level'`, `name = exported binding name`, `definitionFile = relative(root, file)`, `definitionLine = node.getStartLineNumber()`, `parameters = extractParameters(node)`. Default-exported functions WITHOUT a name are skipped with a debug-log; we cannot produce a stable `toolId` for them.
5. **Pattern B — function-level**: regardless of file directive (must be `'none'` here — Pattern A already captured `'use-server'`, and `'use-client'` files were skipped), find every function-like node whose body is a `Block` and whose first statement is an `ExpressionStatement` with a `StringLiteral('use server')` expression. ts-morph: walk `sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration | ArrowFunction | FunctionExpression)`. For each match:
   - Resolve the action's binding name. Priority: (a) `FunctionDeclaration.getName()`; (b) parent `VariableDeclaration.getName()` for arrow/fn-expression initialisers; (c) parent `PropertyAssignment.getName()`. If none, skip and debug-log.
   - The function MUST be `async` — Next.js 15 requires it. If not async, skip and debug-log `'function-level use-server on non-async function'`.
   - Emit a `ServerAction` with `kind: 'function-level'`, `definitionLine = node.getStartLineNumber()`.
6. **Pattern C — form-bound**: for files matching `/page\.(ts|tsx|js|jsx)$/` or `/layout\.(…)/$/` (the v0.1 surface), find `JsxAttribute` nodes named `action` whose parent JSX element name is `form`. Extract the action symbol from the attribute's JSX expression (preserving the v0.1 `props.` prefix-strip). Resolve the symbol locally: if the symbol name matches an action discovered in Pattern A or B for the same file (via the binding map), reuse that `ServerAction` — do NOT emit a duplicate. Otherwise emit a `ServerAction` with `kind: 'form-bound'`, `definitionFile = the page file`, parameters derived from the sibling `<input>` elements (reuse `extractFormFields` + `formFieldsToSchema` logic verbatim).
7. Return the merged list, deduplicated by `(definitionFile, name)`. When two `kind`s collide on the same key, prefer the more specific definition: `file-level` > `function-level` > `form-bound`.

### 3.3 `extractParameters(node)` — internal

Function signature:

```ts
function extractParameters(node: FunctionDeclaration | ArrowFunction | FunctionExpression): ServerActionParam[]
```

Logic:

1. Get `node.getParameters()`. For each parameter:
   - Resolve `paramTypeNode = param.getTypeNode()`; if absent, fall back to the type checker via `param.getType()`.
   - Map the type to `jsonType` per the table in §3.4.
   - If the type is an object literal type (`TypeLiteralNode`) or an interface/type-alias resolving to a `TypeLiteral`, recursively walk properties (max depth 3 — beyond that, emit `jsonType: 'object'` with `properties: {}` and downgrade overall confidence). Each property's `required` is `!ts-morph PropertySignature.hasQuestionToken()`.
   - If the parameter has a default value (`param.hasInitializer()`), `required = false`.
   - If `param.isRestParameter()`, mark `jsonType: 'array'` and stop walking.
2. Top-level `required` is `!param.isOptional() && !param.hasInitializer()`.

### 3.4 Type → `jsonType` mapping

| TypeScript form | jsonType | Notes |
| --- | --- | --- |
| `string` | `string` |  |
| `number`, `bigint` | `number` |  |
| `boolean` | `boolean` |  |
| `Date` | `string` | `format: 'date-time'` |
| `FormData` | `formdata` | Use the form-bound branch's `formFieldsToSchema` if a sibling JSX form is present, otherwise `{ type: 'object', additionalProperties: true }` and confidence = `unknown`. |
| `T[]`, `Array<T>`, `ReadonlyArray<T>` | `array` |  |
| `{ k: T; … }` (TypeLiteral) | `object` | Recurse on members, max depth 3. |
| Type alias / interface resolving to TypeLiteral | `object` | Resolve via `param.getType().getProperties()` (type checker). |
| Union `A \| B` of primitives | first member's jsonType | Confidence downgraded to `inferred`. |
| Generic `T`, `unknown`, `any`, no annotation | `unknown` | Confidence becomes `unknown`. |

### 3.5 Confidence assignment (per action)

Compute the action's `schemaConfidence` after `extractParameters` returns, with the following decision tree (first match wins):

1. Action has zero parameters → `schema = { type: 'object', additionalProperties: false }`, `schemaConfidence = 'introspected'`.
2. Action's first parameter is `FormData` AND a sibling JSX form is present in the same file → reuse the form schema. Confidence: `inferred` (matches v0.1 form-bound behaviour exactly — no regression).
3. Action's first parameter has a fully-resolved object type (no `unknown` properties anywhere) AND no `any` / `unknown` / generic in the type → `schemaConfidence = 'introspected'`.
4. Action's first parameter has a partially-resolved type (some properties typed, some not) OR the function body invokes `<schemaIdent>.parse(...)` / `<schemaIdent>.safeParse(...)` against the parameter (Zod) → `schemaConfidence = 'inferred'` (and if Zod is detected, opportunistically reuse `extractZodSchema` from `src/extract/nextjs/schemas.ts:17` over the action's body — same path the route extractor uses).
5. Action has a parameter typed `any`, `unknown`, or no annotation → `schemaConfidence = 'unknown'`, `schema = { type: 'object', additionalProperties: true }`.

The schema itself is constructed from the first positional parameter:
- If `formdata` and a sibling form is present → use `formFieldsToSchema(extractFormFields(content))`.
- If `object` → `{ type: 'object', properties: {…recursed properties…}, required: [keys with required=true] }`.
- Otherwise → wrap the single primitive into `{ type: 'object', properties: { value: { type: jsonType } }, required: ['value'] }`. (Server actions taking a single positional primitive are rare; this normalisation keeps `inputSchema.type === 'object'` invariant — every consumer assumes an object envelope.)

### 3.6 Page → action mapping (Pattern D, internal)

Add an internal pass `mapServerActionImports(root, actions: ServerAction[]): Map<pagePath, ServerAction[]>`:

1. For every page-like file (`page.{tsx,ts,jsx,js}`, `layout.{…}` — not exhaustive routing logic, just the same set v0.1 inspected, plus regular components imported from those pages within depth 1 — out of scope for v0.2; just page/layout files), parse imports.
2. For every named `ImportDeclaration`, resolve the module specifier relative to the file. If the resolved file matches a `ServerAction.definitionFile` (Pattern A or B host) and the imported name matches a `ServerAction.name`, record the mapping `pagePath -> action`.
3. Return the map.

This map is NOT emitted as a tool. It is used in §5 by `surface_routes_for_page` to extend its existing fetch-URL-based matching with server-action import-symbol matching. v0.2 does NOT modify `http.ts` directly — the wire-up is a separate task in §10 with a clear interface.

### 3.7 `mapServerActionsToToolMeta` — internal

```ts
function mapServerActionsToToolMeta(
  actions: ServerAction[],
  root: string,
): ToolMeta[]
```

For each `ServerAction`:

```ts
{
  name: `serveraction_${action.name}__${sanitizePath(action.definitionFile)}`,
  toolId: sha1(`serveraction:${action.name}:${action.definitionFile}`).slice(0,12),
  method: 'POST',
  // Path: stable, human-readable identifier; NOT a real HTTP path.
  // For file-level/function-level: the definition file with /page suffix stripped.
  // For form-bound: the consuming page route (preserves v0.1 behaviour).
  path: deriveServerActionPath(action),
  inputSchema: action.schema,
  inputSchemaConfidence: action.schemaConfidence,
  sideEffectClass: 'mutating',
  sourceFile: action.definitionFile,
  sourceLine: action.definitionLine,
  sourceFunctionName: action.name,
  isServerAction: true,
}
```

`deriveServerActionPath`:
- `kind === 'form-bound'`: keep v0.1 derivation `/${pagePath without /page.ext}` (regression gate).
- `kind === 'file-level' | 'function-level'`: `/__action__/${action.definitionFile.replace(/\.(t|j)sx?$/,'')}/${action.name}` — synthetic, unique, never matches a real route. Consumers (BugHunter) skip it via `isServerAction`, so the path is purely identification, never invoked over HTTP.

### 3.8 Public entry point

```ts
export async function extractServerActions(root: string): Promise<ToolMeta[]> {
  const actions = await findServerActionDefinitions(root);
  return mapServerActionsToToolMeta(actions, root);
}
```

The signature is unchanged from v0.1; `tools-meta.ts:35` does not need any edit.

---

## 4. Confidence assignment rules — summary table

| Pattern | Param type | Body has `.parse()` / `.safeParse()` | confidence |
| --- | --- | --- | --- |
| A or B | typed object literal, all primitives | n/a | `introspected` |
| A or B | typed object literal, some `unknown`/`any` | no | `inferred` |
| A or B | any param | yes (Zod) | `inferred` (schema from Zod) |
| A or B | `FormData` + sibling JSX form | n/a | `inferred` (regression gate) |
| A or B | `any` / `unknown` / no annotation | no | `unknown` |
| A or B | zero params | n/a | `introspected` |
| C (form-bound) | n/a | n/a | `inferred` (unchanged from v0.1) |

Rationale for never emitting `partial` here: `partial` is reserved by the route extractor for manual if-guard-validation analysis (`schemas.ts` `extractManualValidationSchema`). Server actions surface their inputs via the function signature, not via runtime if-guards on `req.json()`, so `partial` does not apply.

---

## 5. Refactor of `extractServerActions`

**Before (v0.1):** Single function, ~60 lines, walks `app/`, regexes for `<form action=`, ts-morph extracts the symbol, builds one `ToolMeta` per `<form>`. Schema is from sibling inputs.

**After (v0.2):** Same file, three internal helpers + the same public entry:

```
findServerActionDefinitions(root)            // discovers Patterns A, B, C in one pass
  ├── classifyFileDirective(sf)              // 'use-server' | 'use-client' | 'none'
  ├── collectPatternA(sf, file)              // returns ServerAction[] for file-level
  ├── collectPatternB(sf, file)              // returns ServerAction[] for function-level
  └── collectPatternC(sf, file, content)     // returns ServerAction[] for form-bound
                                             // (preserves v0.1 behaviour, deduped against A/B)

extractParameters(fnNode)                    // shared, returns ServerActionParam[]

mapServerActionsToToolMeta(actions, root)    // ServerAction[] → ToolMeta[]
                                             // applies §3.7 path / id rules

extractServerActions(root)                   // public entry, unchanged signature
```

**Migration safety:**
- The exported function name and signature are identical.
- v0.1's regex pre-filter `if (!/<form\s[^>]*action=\{/.test(content))` is DROPPED — it incorrectly excludes Pattern A/B files. Replace it with a per-pattern early-out inside each collector.
- v0.1's hard-coded `inputSchemaConfidence: 'inferred'` for form-bound is preserved by §4.
- v0.1's `sourceLine: 1` placeholder is replaced by `definitionLine`. Existing tests do not assert `sourceLine` on server actions; this is a quiet improvement.
- v0.1's `walkDir` is reused; the file-extension whitelist is unchanged.

**File length:** the refactored `server-actions.ts` should land at <300 lines. If it overflows, split into:
- `server-actions.ts` (entry + types + `extractParameters` + `mapServerActionsToToolMeta`)
- `server-actions-collect.ts` (the three collectors)

Decide at implementation time; the spec does not mandate the split.

**Function length:** every helper must stay under 40 lines per the project rule. The collectors will require dedicated parameter-extraction helpers — that's expected.

---

## 6. Fixture extensions

Add these files under `fixtures/nextjs-app/`. Existing v0.1 fixtures stay untouched.

### 6.1 `app/actions/orders.ts` — Pattern A

```ts
'use server';

export async function createOrder(data: { productId: string; qty: number }) {
  console.log('createOrder', data);
}
```

Constraints:
- ALL exports must be async (Next.js 15 will fail to compile otherwise — see commit `2edd409`).
- File must NOT be co-located under `app/api/`, otherwise it would be treated as an API route by `extractNextjsRoutes`.

### 6.2 `app/admin/inline-action/page.tsx` — Pattern B

```tsx
export default function InlineActionPage() {
  async function archiveOrder(id: string) {
    'use server';
    console.log('archive', id);
  }
  return <button onClick={() => archiveOrder('demo')}>Archive</button>;
}
```

Constraints:
- No `'use client'` directive — must be a server component (Next.js requires this for inline `'use server'`).
- `archiveOrder` MUST be async; v0.2 will skip otherwise and the test for Pattern B detection would fail.

### 6.3 `app/admin/orders/page.tsx` — Pattern D

```tsx
import { createOrder } from '@/app/actions/orders';
import { ClientOrderForm } from './client-order-form';

export default function AdminOrdersPage() {
  return <ClientOrderForm action={createOrder} />;
}
```

### 6.4 `app/admin/orders/client-order-form.tsx` — Pattern D consumer

```tsx
'use client';

type Props = { action: (data: { productId: string; qty: number }) => Promise<void> };

export function ClientOrderForm({ action }: Props) {
  return (
    <button onClick={() => action({ productId: 'p1', qty: 1 })}>Order</button>
  );
}
```

Constraint: `tsconfig.json` already has the `@/*` path alias to `./*` — verify in `fixtures/nextjs-app/tsconfig.json`. If not, switch to a relative import (`'../../actions/orders'`).

### 6.5 `MUST_DISCOVER.json` — extension

Append to the existing JSON. Do NOT remove existing entries.

```json
{
  "routes": [
    "GET /api/users",
    "POST /api/users",
    "GET /api/users/:id",
    "PUT /api/users/:id",
    "DELETE /api/users/:id",
    "GET /api/products",
    "POST /api/journal-entries",
    "POST /api/orders",
    "POST /api/conditional-404"
  ],
  "serverActions": [
    {
      "name": "createOrder",
      "kind": "file-level",
      "definitionFile": "app/actions/orders.ts",
      "toolId": "3aabc90b1d5d",
      "inputSchemaConfidence": "introspected",
      "requiredFields": ["productId", "qty"]
    },
    {
      "name": "archiveOrder",
      "kind": "function-level",
      "definitionFile": "app/admin/inline-action/page.tsx",
      "toolId": "11b684e04a34",
      "inputSchemaConfidence": "introspected",
      "requiredFields": ["value"]
    },
    {
      "name": "createUser",
      "kind": "form-bound",
      "definitionFile": "app/admin/users/page.tsx",
      "toolId": "997c1db5bd0b",
      "inputSchemaConfidence": "inferred",
      "requiredFields": ["name", "email"]
    }
  ],
  "perRoute": {
    "POST /api/users": { "inputSchemaConfidence": "introspected" },
    "PUT /api/users/:id": { "inputSchemaConfidence": "introspected" },
    "POST /api/journal-entries": { "inputSchemaConfidence": "partial", "requiredFields": ["amount", "memo"] },
    "POST /api/orders": { "inputSchemaConfidence": "partial", "requiredFields": ["amount"] },
    "POST /api/conditional-404": { "inputSchemaConfidence": "unknown" }
  },
  "suggestedExternalIntegrations": {
    "include": ["app/api/orders/route.ts"],
    "exclude": [
      "app/policies/privacy/page.tsx",
      "app/components/CheckoutButton.tsx"
    ]
  }
}
```

ToolId derivation (verified): `sha1('serveraction:<name>:<definitionFile>').slice(0,12)` — see appendix §A.1 for command. **Note for the `archiveOrder` entry**: the `'value'` in `requiredFields` is the synthetic envelope key from §3.5 (single primitive parameter `id: string` is wrapped as `{ value: string }`). If the implementer changes the wrapper key, update both spec §3.5 and this JSON in lockstep.

---

## 7. Test plan

Create `src/extract/nextjs/server-actions.test.ts` (new). Use the fixtures from §6.

```ts
import { describe, it, expect } from 'vitest';
import { extractServerActions } from './server-actions.js';
import { resolve } from 'node:path';

const FIXTURE = resolve(import.meta.dirname, '../../../fixtures/nextjs-app');

describe('extractServerActions — v0.2 closure-bound discovery', () => {
  it('discovers Pattern A: file-level use-server module', async () => {
    const tools = await extractServerActions(FIXTURE);
    const t = tools.find((t) => t.sourceFunctionName === 'createOrder');
    expect(t).toBeDefined();
    expect(t!.isServerAction).toBe(true);
    expect(t!.sideEffectClass).toBe('mutating');
    expect(t!.sourceFile).toBe('app/actions/orders.ts');
    expect(t!.toolId).toBe('3aabc90b1d5d');
    expect(t!.inputSchemaConfidence).toBe('introspected');
    expect(t!.inputSchema.required).toEqual(expect.arrayContaining(['productId', 'qty']));
  });

  it('discovers Pattern B: inline use-server in server component', async () => {
    const tools = await extractServerActions(FIXTURE);
    const t = tools.find((t) => t.sourceFunctionName === 'archiveOrder');
    expect(t).toBeDefined();
    expect(t!.toolId).toBe('11b684e04a34');
    expect(t!.inputSchemaConfidence).toBe('introspected');
  });

  it('preserves Pattern C: form-bound action (regression)', async () => {
    const tools = await extractServerActions(FIXTURE);
    const t = tools.find((t) => t.sourceFunctionName === 'createUser');
    expect(t).toBeDefined();
    expect(t!.toolId).toBe('997c1db5bd0b');
    expect(t!.inputSchemaConfidence).toBe('inferred');
    expect(t!.inputSchema.required).toEqual(expect.arrayContaining(['name', 'email']));
  });

  it('does not duplicate Pattern D actions for each consuming page', async () => {
    const tools = await extractServerActions(FIXTURE);
    const createOrders = tools.filter((t) => t.sourceFunctionName === 'createOrder');
    expect(createOrders).toHaveLength(1);
  });

  it('emits exactly three server-action tools for the fixture', async () => {
    const tools = await extractServerActions(FIXTURE);
    expect(tools).toHaveLength(3);
  });

  it('every emitted tool has isServerAction=true and method=POST', async () => {
    const tools = await extractServerActions(FIXTURE);
    for (const t of tools) {
      expect(t.isServerAction).toBe(true);
      expect(t.method).toBe('POST');
      expect(t.sideEffectClass).toBe('mutating');
    }
  });

  it('skips non-async function-level use-server (debug log only)', async () => {
    // Inline test using ts-morph in-memory (no fixture file needed):
    // a synchronous function with 'use server' must NOT yield a tool.
    // Implementation detail: spec requires no emission; the test asserts that.
    // (See §8 for full edge case list.)
  });
});
```

Extend `src/extract/extract.test.ts` minimally — add a parallel block that loads `MUST_DISCOVER.json#/serverActions` and asserts each `toolId` and `inputSchemaConfidence` appears in the merged catalog:

```ts
describe('nextjs-app server-action extraction', () => {
  it('discovers all must-discover server actions', async () => {
    const root = resolve(FIXTURES, 'nextjs-app');
    const tools = await extractServerActions(root);
    const must = loadMustDiscover('nextjs-app');
    const byId = new Map(tools.map(t => [t.toolId, t]));
    for (const expected of (must as { serverActions?: Array<{ toolId: string; inputSchemaConfidence: string }> }).serverActions ?? []) {
      const t = byId.get(expected.toolId);
      expect(t, `missing server action toolId=${expected.toolId}`).toBeDefined();
      expect(t!.inputSchemaConfidence).toBe(expected.inputSchemaConfidence);
    }
  });
});
```

The existing `loadMustDiscover` helper already returns `{ routes?, serverActions? }` (see `extract.test.ts:11-14`); the new shape just needs the typed cast above.

---

## 8. Edge cases — what NOT to flag

The following must be silently skipped (debug-log permitted; no `ToolMeta` emission):

1. **Non-async function with `'use server'`** — Next.js compile-time error. Skip; do not propagate the misuse.
2. **Anonymous functions with `'use server'`** — e.g. `export default async () => { 'use server'; … }` with no binding name. No stable identifier → skip and debug-log.
3. **Nested `'use server'` inside another action** — only the outermost function-level directive counts. ts-morph: when iterating descendants, deduplicate by `(file, identifier)`; if an identifier already has a `'use server'` ancestor, skip the inner.
4. **`'use server'` inside a `'use client'` file** — invalid combination. v0.2 skips the file entirely on Pattern A/B detection.
5. **`'use server'` not as the first statement of the function body** — invalid Next.js usage. Only the *first* statement counts.
6. **Action defined under `app/api/**`** — those files are owned by `extractNextjsRoutes`. Server-action discovery MUST exclude `app/api/` and `pages/api/` and `src/app/api/` and `src/pages/api/` from its walk.
7. **Action defined in a `.test.` / `.spec.` file** — already excluded by `walkDir`.
8. **Action defined but never imported/exported** — still discovered (it has a binding name). The user might be in mid-development; emitting it is correct because BugHunter excludes server-actions anyway.
9. **Re-exports** (`export { createOrder } from './orders'`) — the original definition is the one we discover; the re-export is ignored for tool emission. Pattern D's prop-mapping still works because the import resolution lands on the original.
10. **TypeScript declaration files (`.d.ts`)** — already excluded by walk filter (only `.ts/.tsx/.js/.jsx`, `.d.ts` files have `.ts` extension but they live in a separate path and are typically not under `app/`; if encountered, the implementation must additionally skip files ending in `.d.ts`).
11. **Generic action `function f<T>(arg: T)`** — type checker resolves `T` to `unknown`. Per §3.4, `jsonType: 'unknown'`, confidence: `unknown`.
12. **Action whose first parameter is a typed `Request`/`Response`** — these are NOT server actions despite being async; the user almost certainly mis-applied `'use server'`. Detect: if the first parameter's type ends in `Request`, `Response`, `NextRequest`, `NextResponse` and the file directive is `'use-server'`, skip with a debug-log. (Defensive — these would not call as a server action anyway.)
13. **Action with `…rest` parameter** — emit with `jsonType: 'array'`; confidence: `unknown`. BugHunter will skip via `isServerAction`.

---

## 9. Acceptance criteria

The PR is complete when ALL of the following hold:

1. `npx tsc --noEmit` passes from `/root/SurfaceMCP` with zero errors.
2. `npx eslint . --max-warnings 0` passes from `/root/SurfaceMCP` (project rule).
3. `npx vitest run src/extract/nextjs/server-actions.test.ts` passes with at least 7 tests, covering: Pattern A, Pattern B, Pattern C regression, Pattern D no-duplicate, total tool count = 3, every tool has `isServerAction=true / method=POST / sideEffectClass='mutating'`, and the non-async edge case.
4. `npx vitest run src/extract/extract.test.ts` passes — including the new server-action `MUST_DISCOVER.json` block.
5. The fixture compiles under Next.js 15 (`cd fixtures/nextjs-app && npx next build` succeeds). This is the regression that bit commit `2edd409` — it must not return.
6. `extractServerActions(fixtures/nextjs-app)` returns exactly 3 tools, with the toolIds:
   - `3aabc90b1d5d` (createOrder, file-level)
   - `11b684e04a34` (archiveOrder, function-level)
   - `997c1db5bd0b` (createUser, form-bound)
7. The existing v0.1 form-bound test (`createUser` discovery + correct schema) continues to pass — no regression.
8. `src/server/tools-meta.ts:35` is unchanged. The wire-up consumes the new tools transparently.
9. BugHunter's `phases/plan.ts:82` continues to skip all three new server-action tools (manual verification: run `bh discover` against `fixtures/nextjs-app` and confirm none of the three new toolIds appear in the API test plan).
10. No file in `src/extract/nextjs/` exceeds 300 lines.
11. No function in the changed files exceeds 40 lines.
12. No `as any` / `: any` introduced.
13. The `TODO(spec)` comment at the top of `server-actions.ts` is REMOVED (it referenced v0.1's deferral).

---

## 10. Files to touch

**Modify:**
- `src/extract/nextjs/server-actions.ts` — refactor per §5.

**Create:**
- `src/extract/nextjs/server-actions.test.ts` — per §7.
- `fixtures/nextjs-app/app/actions/orders.ts` — Pattern A fixture, §6.1.
- `fixtures/nextjs-app/app/admin/inline-action/page.tsx` — Pattern B fixture, §6.2.
- `fixtures/nextjs-app/app/admin/orders/page.tsx` — Pattern D fixture, §6.3.
- `fixtures/nextjs-app/app/admin/orders/client-order-form.tsx` — Pattern D consumer, §6.4.

**Modify (additive):**
- `fixtures/nextjs-app/MUST_DISCOVER.json` — extend per §6.5. Existing entries remain.
- `src/extract/extract.test.ts` — add the `nextjs-app server-action extraction` block per §7.

**Do NOT touch:**
- `src/server/tools-meta.ts` — the wire-up is correct as-is.
- `src/server/http.ts` — `surface_routes_for_page` enhancement (Pattern D mapping) is OUT OF SCOPE for v0.2. Tracked as open question §12.Q3.
- `src/types.ts` — `ToolMeta` shape is sufficient. The new `ServerAction` types are internal to `server-actions.ts`.
- `BugHunter/**` — no cross-repo edits required; the consumer contract is preserved.
- Any v0.1 fixture file — no regressions allowed.

---

## 11. Risk & sequencing

**Cross-repo coupling: NONE.** BugHunter consumes `ToolMeta.isServerAction` already (`plan.ts:82`); v0.2 emits more such tools, all correctly flagged. No BugHunter PR is needed.

**Sequencing: single PR.** The fixture, the refactor, and the tests must land together — partial landing breaks `extract.test.ts`'s MUST_DISCOVER assertion. There are no intermediate integration points.

**Rollback:** revert the single PR. v0.1 behaviour returns; nothing else depends on the new fixture files (`app/actions/orders.ts`, `app/admin/inline-action/`, `app/admin/orders/`).

**Risk: ts-morph type-checker depth.** Resolving `param.getType().getProperties()` on cross-file type aliases can be expensive on large codebases. The fixture is tiny so the test won't catch this; production users with large `app/actions/` modules might see extraction times in seconds. Mitigation: a single `Project` per `extractServerActions` call (§3.2 step 2), and recursion depth cap at 3 (§3.3). Beyond this, profile in v0.3 if real surfaces report slowness.

**Risk: Next.js 15 compile breakage.** `'use server'` semantics are strict (see commit `2edd409`). Acceptance criterion #5 gates this — the implementer MUST run `next build` against the fixture before merging.

**Risk: Pattern D import-resolution cost.** Out of scope for v0.2 (see §12.Q3). v0.2 discovers Pattern A/B definitions cleanly; Pattern D reuse-of-definition is automatic by symbol name; no resolution needed for tool emission.

---

## 12. Open questions

**Q1.** Should `surface_routes_for_page` learn to match server-action imports for Pattern D (so a page importing `createOrder` returns the server-action tool)?
- Recommendation: defer to v0.3. Today, BugHunter's page exploration finds these via JSX `onClick`/`action` follow-through during the browser walk, so `surface_routes_for_page` is not the only mapping. If users report missing mappings, add it then.

**Q2.** Should the `path` for file-level/function-level server actions be a real Next.js RPC path (e.g. the encoded hash Next.js generates at build time)?
- Recommendation: NO. The build-time hash is unstable across deploys and not extractable from source. The synthetic `/__action__/...` path in §3.7 is sufficient — it is purely an identifier, never invoked.

**Q3.** Should we discover server actions defined in non-`app/` files (e.g. `lib/server-actions/orders.ts`)?
- Recommendation: NO for v0.2. The Next.js convention is `app/` (or `src/app/`). If a user keeps actions outside, they can move them or file an issue. Adding arbitrary `lib/**` walking would explode the discovery surface.

**Q4.** Should Zod schema introspection on action bodies (§3.5 rule 4) reuse the full `extractZodSchema` from `schemas.ts` or a stripped-down variant?
- Recommendation: reuse the full one. It already handles the text-fallback path. The implementer should pass the action's body `Block` as the search root rather than the whole source file, by constructing a temporary in-memory file containing only the body — OR adapt `extractZodSchema` to accept a `Node` instead of `SourceFile`. The latter is cleaner; the former requires no signature change. Implementer's call.

---

## Appendix A — toolId derivation

A.1 Verification command (Node REPL):

```bash
node -e "const c=require('crypto');const h=(n,p)=>c.createHash('sha1').update('serveraction:'+n+':'+p).digest('hex').slice(0,12);console.log(h('createOrder','app/actions/orders.ts'));console.log(h('archiveOrder','app/admin/inline-action/page.tsx'));console.log(h('createUser','app/admin/users/page.tsx'));"
```

Expected output:
```
3aabc90b1d5d
11b684e04a34
997c1db5bd0b
```

These three values are pinned in `MUST_DISCOVER.json` (§6.5) and the test file (§7).

A.2 Stability invariant: `toolId` is `sha1('serveraction:' + name + ':' + definitionFile).slice(0,12)`. This is a *change* from v0.1 for form-bound actions, where `definitionFile` was the page file (since v0.1 had no other definition concept). Today the form-bound `createUser` action is defined IN the page file (`app/admin/users/page.tsx`), so the v0.1 and v0.2 toolIds collide BY CONSTRUCTION — both compute over the same `(name, page)` pair. No stored toolId is invalidated. Verified above: `997c1db5bd0b`.
