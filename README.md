# Contextual Governance — Mastra × Arcade

An agent that does real work in a real business system, with [Arcade](https://arcade.dev)
enforcing deterministic control at three points on every tool call: **access**,
**pre-execution**, and **post-execution**.

A loan officer asks the agent to approve a $95K loan and to double-check its work. Four
things go wrong. The control plane catches all four. The model never gets a vote.

Built with [Mastra](https://mastra.ai), Next.js, Bun, SQLite, and TypeScript — plus one
Python `arcade-mcp` toolkit.

## Status

`apps/loan-mcp` is real: a Streamable HTTP MCP server over `loans.db`, with the four
loan tools and the seed data the demo runs on. `apps/idp` is real: the enterprise's
identity provider, Better Auth as an OAuth 2.1 server, with the four personas seeded and
a login and consent page. `apps/hooks` and `apps/web` are still stubs that serve a
health endpoint and nothing else.

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
apps/idp         Bun — Better Auth OAuth 2.1 provider, login and consent pages.
                 Owns idp.db. A demo fixture standing in for the enterprise's
                 real IdP; a forker deletes it and points at their Okta. Not a
                 workspace member — has its own lockfile.              → Render
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
bun install --cwd apps/idp   # not a workspace member; see apps/idp/README.md
cp .env.example .env         # then fill it in — every variable is documented in place
```

```sh
bun run typecheck        # tsc --noEmit across every workspace
bun test                 # the pure decision modules, plus the forkability boundary
```

Run a service:

```sh
bun run dev:hooks        # :8081
bun run dev:loan-mcp     # :8082, MCP at POST /mcp
bun run dev:idp          # :8083, OAuth at /oauth2/*
bun run dev:web          # :3000
```

Each service answers `GET /health`:

```sh
curl localhost:8081/health   # {"status":"ok","service":"hooks",...}
curl localhost:8082/health   # {"status":"ok","service":"loan-mcp","loans":8,...}
curl localhost:8083/health   # {"status":"ok","service":"idp","people":4,...}
```

## The loan book

`apps/loan-mcp` is the system being governed, and it knows nothing about governance:
no authority checks, no withheld fields, nothing consulted before a write is applied.
`get_loan` hands back the borrower's bank account number, tax ID and the underwriter's
notes in full, on purpose — redacting them is the post-execution hook's job, and a
service that did it itself would leave nothing to demonstrate.

That constraint is enforced by a test, not a convention:
`apps/loan-mcp/test/knows-nothing-about-governance.test.ts` fails if the words
`policy`, `role`, `limit`, `redact`, `authority`, `approver` or `permission` appear in
its source. If you find yourself wanting to add a check there, it belongs in
`apps/hooks`.

Four tools: `search_loans`, `get_loan`, `approve_loan`, `deny_loan`. A decision is an
event rather than a flag, so approving the same loan twice leaves two rows in its
history instead of collapsing into an accidental no-op.

`loans.db` is seeded from `apps/loan-mcp/src/fixtures/loans.json` when it has no
schema, and left alone on every boot after that. Editing that fixture and deleting the
database is the whole domain swap.

### Registering it in Arcade

Register the deployed service as a Remote MCP server pointing at `https://<host>/mcp`.

**The toolkit name comes from the server, not from what you call it in the dashboard.**
Arcade lowercases the `serverInfo.name` this service reports, strips every `mcp` and
`server` *substring*, then PascalCases the rest — so a server calling itself `loan-mcp`
becomes toolkit `Loan`. This one reports `loan-app`, which should survive as `LoanApp`.
Read the real value off a `/pre` payload before keying a rule on it: a rule that matches
nothing is indistinguishable from a rule that permits. Measured in
[`docs/spikes/02-remote-mcp-hooks.md`](./docs/spikes/02-remote-mcp-hooks.md).

## The identity provider

`apps/idp` is what the loan tools authenticate against: Arcade is registered as an OAuth
client of it, and the email it returns from `/oauth2/userinfo` is the identity every hook
and every loan-book write is keyed on. It stands in for the enterprise's real IdP, and it
has one operational rule — **resetting it must not rotate the OAuth client**, or the
registration in the Arcade dashboard goes stale right before you present. Its reset script
keeps the client; see [`apps/idp/README.md`](./apps/idp/README.md), including how to
print the credentials and what to enter in Arcade.

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

Four services deploy from [`render.yaml`](./render.yaml) as a Render blueprint.
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
