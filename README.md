# Contextual Governance — Mastra × Arcade

An agent that does real work in a real business system, with [Arcade](https://arcade.dev)
enforcing deterministic control at four points on every tool call: **access**, the
**credential** to call it, **pre-execution**, and **post-execution**.

A loan officer asks the agent to approve a $95K loan and to double-check its work. Four
things go wrong. The control plane catches all four. The model never gets a vote.

Built with [Mastra](https://mastra.ai), Next.js, Bun, SQLite, and TypeScript — plus two
Python `arcade-mcp` toolkits, which is what the agent's tools are authored in.

## Status

`apps/loan-app` is real: the bank's system of record, a plain HTTP API over `loans.db`
with the seed data the demo runs on. `tools/loan` is real: the four loan tools, each a
stateless client of that API, shipped with `arcade deploy`. `apps/hooks` and `apps/web`
are still stubs that serve a health endpoint and nothing else.

See [`DESIGN.md`](./DESIGN.md) for the architecture and the decisions behind it, and
[issue #1](https://github.com/ArcadeAI/mastra-contextual-governance/issues/1) for the
PRD and the work breakdown.

## Layout

```
apps/web         Next.js — chat, persona switcher, approval page, control-plane panel.
                 The Mastra agent runs in route handlers.              → Render
apps/hooks       Bun — /access /pre /post, policy engine, audit, SSE.
                 Owns governance.db.                                   → Render
apps/loan-app    Bun — plain HTTP API, the bank's system of record. Owns loans.db.
                 No MCP, no Arcade, no governance.                     → Render

tools/loan       Python arcade-mcp — search_loans, get_loan, approve_loan, deny_loan.
                 Stateless client of apps/loan-app.             → arcade deploy
tools/approvals  Python arcade-mcp — request_approval, decide.  → arcade deploy

packages/governance-core   Hook framework, policy engine, audit, event bus.
                           Zero loan references, zero dependencies on apps/*.
packages/policy-schema     Shared zod types for policy, events, hook payloads.
```

`apps/hooks` and `apps/loan-app` stay separate processes on purpose: one is the
governed system, the other is the thing governing it. And `apps/loan-app` is not an MCP
server on purpose: banks have APIs, not MCP servers, and keeping the tool layer in
`tools/loan` is what makes "governance lives outside the business system" literal.

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
bun run dev:loan-app     # :8082, the loan API
bun run dev:idp          # :8083, a dev-only stand-in for apps/idp — tokens are `dev:<email>`
bun run dev:web          # :3000
```

Every `/loans` call needs a bearer token, and the API asks the identity provider who it
belongs to. Until `apps/idp` (#36) is running locally, `dev:idp` serves that one endpoint:

```sh
curl -H 'Authorization: Bearer dev:dana@example.test' localhost:8082/loans/LN-2291
```

Each service answers `GET /health`:

```sh
curl localhost:8081/health   # {"status":"ok","service":"hooks",...}
curl localhost:8082/health   # {"status":"ok","service":"loan-app","loans":8}
```

## The loan book

`apps/loan-app` is the system being governed, and it knows nothing about governance:
no authority checks, no withheld fields, nothing consulted before a write is applied.
`GET /loans/:id` hands back the borrower's bank account number, tax ID and the
underwriter's notes in full, on purpose — redacting them is the post-execution hook's
job, and a service that did it itself would leave nothing to demonstrate.

That constraint is enforced by a test, not a convention:
`apps/loan-app/test/knows-nothing-about-governance.test.ts` fails if the words
`policy`, `role`, `limit`, `redact`, `authority`, `approver` or `permission` appear in
its source. If you find yourself wanting to add a check there, it belongs in
`apps/hooks`.

```
GET  /loans?status=&min_amount=&max_amount=
GET  /loans/:loan_id
POST /loans/:loan_id/approve   { amount }
POST /loans/:loan_id/deny      { reason }
GET  /health
```

Every `/loans` route needs a bearer token. The API asks the identity provider
(`apps/idp`, #36) who the token belongs to via `/oauth2/userinfo` and records that email
as the decision's `decided_by`. **The actor is never a request parameter** — a body that
tries to name one is a 400. OAuth carries identity; the hooks carry authority.

A decision is an event rather than a flag, so approving the same loan twice leaves two
rows in its history instead of collapsing into an accidental no-op.

`loans.db` is seeded from `apps/loan-app/src/fixtures/loans.json` when it has no
schema, and left alone on every boot after that. Editing that fixture and deleting the
database is the whole domain swap.

## The loan tools

`tools/loan` is where the agent's tools live: `search_loans`, `get_loan`,
`approve_loan`, `deny_loan`, each a stateless `httpx` call to the API above carrying the
end user's OAuth token. It ships with `arcade deploy`, and the toolkit name Arcade files
it under is measured, not derived — see [`tools/loan/README.md`](./tools/loan/README.md)
and `ARCADE_LOAN_TOOLKIT` in `.env.example`. A policy rule keyed on the wrong toolkit
matches nothing, and a rule that matches nothing is indistinguishable from a rule that
permits.

## Two things that will bite you

**Zod is pinned to 3.25.76.** Zod 4 changes internals the Arcade/Mastra path does
not support yet, so the root manifest carries an `overrides` entry that holds every
workspace to the same 3.x. Do not bump it without checking the Arcade SDK first.

**`packages/governance-core` must not depend on any app.** That boundary is what
makes this template forkable — a forker replaces `apps/loan-app`, `tools/loan` and the
seed data and touches nothing under `packages/`. It is enforced by a test, not a convention:
`packages/governance-core/test/no-app-dependencies.test.ts` fails if governance-core
declares a dependency on an app package or imports from one.

## Deploying

Three services deploy from [`render.yaml`](./render.yaml) as a Render blueprint.
Render does not detect Bun, so each service declares `runtime: docker` and ships
its own Dockerfile — do not rely on runtime detection.

`tools/loan` and `tools/approvals` are deliberately outside the blueprint: they are
Python `arcade-mcp` toolkits, and Arcade hosts them via `arcade deploy`. See
[`tools/loan/README.md`](./tools/loan/README.md).

Secrets are `sync: false` in the blueprint, so a sync prompts for them rather than
committing them. `.env.example` says where to obtain each one.

## Forking

The domain swap is structural, not a README instruction: replace `apps/loan-app`,
`tools/loan` and the seed data, leave `packages/` alone. Full guide lands in
[#24](https://github.com/ArcadeAI/mastra-contextual-governance/issues/24).
