# Contextual Governance — Mastra × Arcade

An agent that does real work in a real business system, with [Arcade](https://arcade.dev)
enforcing deterministic control at three points on every tool call: **access**,
**pre-execution**, and **post-execution**.

A loan officer asks the agent to approve a $95K loan and to double-check its work. Four
things go wrong. The control plane catches all four. The model never gets a vote.

Built with [Mastra](https://mastra.ai), Next.js, Bun, SQLite, and TypeScript — plus one
Python `arcade-mcp` toolkit.

## Status

Scaffold only. Every service is a stub that serves a health endpoint and nothing
else — the point of this slice is that the deploy pipeline works before any logic
goes into it.

See [`DESIGN.md`](./DESIGN.md) for the architecture and the decisions behind it, and
[issue #1](https://github.com/ArcadeAI/mastra-contextual-governance/issues/1) for the
PRD and the work breakdown.

## Layout

```
apps/web         Next.js — chat, persona switcher, approval page, control-plane panel.
                 The Mastra agent runs in route handlers.              → Render
apps/hooks       Bun — /access /pre /post, policy engine, audit, SSE.
                 Owns governance.db.                                   → Render
apps/loan-mcp    Bun — Streamable HTTP MCP server, the governed business system.
                 Owns loans.db. Registered in Arcade as a Remote MCP server.
                                                                       → Render
tools/approvals  Python arcade-mcp — request_approval, decide.  → arcade deploy

packages/governance-core   Hook framework, policy engine, audit, event bus.
                           Zero loan references, zero dependencies on apps/*.
packages/policy-schema     Shared zod types for policy, events, hook payloads.
```

`apps/hooks` and `apps/loan-mcp` stay separate processes on purpose: one is the
governed system, the other is the thing governing it.

## Getting started

Requires [Bun](https://bun.sh) 1.3.14.

```sh
bun install
cp .env.example .env     # then fill it in — every variable is documented in place
```

```sh
bun run typecheck        # tsc --noEmit across every workspace
bun test                 # the pure decision modules, plus the forkability boundary
```

Run a service:

```sh
bun run dev:hooks        # :8081
bun run dev:loan-mcp     # :8082
bun run dev:web          # :3000
```

Each service answers `GET /health`:

```sh
curl localhost:8081/health   # {"status":"ok","service":"hooks",...}
```

## Two things that will bite you

**Zod is pinned to 3.25.76.** Zod 4 changes internals the Arcade/Mastra path does
not support yet, so the root manifest carries an `overrides` entry that holds every
workspace to the same 3.x. Do not bump it without checking the Arcade SDK first.

**`packages/governance-core` must not depend on any app.** That boundary is what
makes this template forkable — a forker replaces `apps/loan-mcp` and the seed data
and touches nothing under `packages/`. It is enforced by a test, not a convention:
`packages/governance-core/test/no-app-dependencies.test.ts` fails if governance-core
declares a dependency on an app package or imports from one.

## Deploying

Three services deploy from [`render.yaml`](./render.yaml) as a Render blueprint.
Render does not detect Bun, so each service declares `runtime: docker` and ships
its own Dockerfile — do not rely on runtime detection.

`tools/approvals` is deliberately outside the blueprint: it is Python, and Arcade
hosts it via `arcade deploy`. See [`tools/approvals/README.md`](./tools/approvals/README.md).

Secrets are `sync: false` in the blueprint, so a sync prompts for them rather than
committing them. `.env.example` says where to obtain each one.

## Forking

The domain swap is structural, not a README instruction: replace `apps/loan-mcp`
and the seed data, leave `packages/` alone. Full guide lands in
[#24](https://github.com/ArcadeAI/mastra-contextual-governance/issues/24).
