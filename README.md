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

## Companion projects

- **[ClaudeMCP](https://github.com/cunninghambe/ClaudeMCP)** — exposes Claude Code itself as an MCP server, so agents can delegate building work
- **[BugHunter](https://github.com/cunninghambe/BugHunter)** — uses SurfaceMCP + a browser MCP to run exhaustive automated tests against any vibe-coded app
