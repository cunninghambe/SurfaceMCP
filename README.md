# SurfaceMCP

Auto-generates an MCP server that exposes every route, server action, and API endpoint of a target codebase as a typed tool. Any agent can drive the app's full programmatic surface without writing custom integration code.

## Why this exists

UI-driven testing is slow and brittle. The actual programmatic surface — what the UI is a chrome over — is the API layer. SurfaceMCP makes that layer discoverable and callable from any MCP-aware agent. Together with a browser MCP, it gives you full coverage of what an app does without fighting Playwright for every assertion.

## Status

Spec only. See **[SPEC.md](SPEC.md)**.

## Stacks (v1)

- Next.js (App Router and Pages Router)
- Express
- FastAPI
- Django
- Generic OpenAPI fallback (any framework that emits an `openapi.json`/`yaml`)

## Capabilities

### `surface_list_navigations` v2

For Vite SPA stacks, the navigation catalog now includes richer hint fields on every navigation entry. These fields are optional and backwards-compatible — existing consumers that ignore unknown fields are unaffected.

- **`scope`** (`'top-level' | 'page-local'`): whether the trigger is reachable from any URL (`top-level`) or only after navigating to a parent page (`page-local`). URL-based navigations are always `top-level`; state-setter triggers are classified by their source file.
- **`triggerSelectorHint.preferred`** (`'testId' | 'ariaLabel' | 'text' | 'title'`): the strongest available selector for the trigger element. Priority: `testId` > `ariaLabel` > `text` > `title`. Consumers should use this field to pick the most reliable click strategy.
- **`triggerSelectorHint.title`**: the `title="..."` attribute of the trigger element, as a last-resort selector hint when no text content, `aria-label`, or `data-testid` is present.
- **`siblingNavigations`** (`number`): count of other navigations in the same scope that share the same text hint (case-insensitive). `0` means unique; `> 0` signals ambiguity. When `> 0` and `preferred === 'text'`, confidence is automatically dropped one notch (`high → medium`, `medium → low`).
- **`duplicateCount`** (`number`): count of other navigations sharing the same `(method, target, kind, scope)` quadruple. `0` means unique; `> 0` means the same logical destination is reachable from multiple triggers. All entries are retained; consumers can pick the one with the strongest `preferred` selector.

The catalog response is sorted by quality: confidence desc, siblingNavigations asc, preferred desc, then source file/line as a tiebreaker.

## Companion projects

- **[ClaudeMCP](https://github.com/cunninghambe/ClaudeMCP)** — exposes Claude Code itself as an MCP server, so agents can delegate building work
- **[BugHunter](https://github.com/cunninghambe/BugHunter)** — uses SurfaceMCP + a browser MCP to run exhaustive automated tests against any vibe-coded app
