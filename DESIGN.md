# Contextual Governance — Mastra × Arcade

A live demo, shipped as a forkable template: an agent that does real work in a real
business system, with Arcade enforcing deterministic control at three points on every
tool call.

Source narrative: loan officer asks an agent to approve a $95K loan and "double-check
your work." Four things go wrong. All four are caught by the control plane, not by the
model.

## Thesis

Treat the LLM as an adversary. Controls it cannot reason around must live outside it.
Arcade provides three such points per tool call: **access**, **pre-execution**,
**post-execution**.

## The four acts

| # | Beat | Control | Mechanism |
|---|------|---------|-----------|
| 1 | Sam (analyst) literally cannot see `approve_loan` | Access | `POST /access` → `deny` list |
| 2 | Dana's $95K exceeds her $50K authority → blocked → routed approval → retry succeeds | Pre | `POST /pre` → `CHECK_FAILED` + remediation message |
| 3 | `get_loan` returns a bank account number → redacted before it reaches the model | Post | `POST /post` → `override.output` |
| 4 | Seeded underwriter note contains an injected instruction → stripped | Post | `POST /post` → regex scanner |

## Decisions

| Area | Decision |
|---|---|
| Format | Live demo, but `main` is a forkable template |
| Topology | Arcade Cloud engine → hooks deployed at a stable public URL. No tunnels. |
| Integration | Mastra `MCPClient` → `https://api.arcade.dev/mcp/{gateway}` (pending spike 1) |
| Model | Claude Sonnet 5 via `@ai-sdk/anthropic`, temperature 0, model id from env |
| Policy source | Policy DB owned by the hook server. Editable live on stage. |
| Identity | Persona switcher over **real** emails so Arcade OAuth actually works |
| HITL | Custom `request_approval` tool posts Block Kit to Slack; approval link carries **no authority** |
| Approval authz | `approvals.decide` is itself a governed tool call — pre-hook enforces role, limit, and requester ≠ approver |
| Approver routing | Deterministic minimum-sufficient-clearance, requester excluded. The LLM does not choose the approver. |
| The wait | Agent ends its turn; SSE `approval.granted` event auto-resumes it |
| Determinism | The **hook** writes the remediation instruction, not the system prompt |
| Redaction | Declarative per-tool field rules + regex over free text |
| Database | `bun:sqlite`, two files: `loans.db` (domain), `governance.db` (policy + audit) |
| Visualization | Hook server → SSE → live three-lane Access/Pre/Post panel |
| Design | Left half deliberately boring enterprise app; right half Arcade-branded control plane |
| Hosting | Render (`render.yaml` blueprint) for web, hooks, loan-mcp; `arcade deploy` for approvals |
| Languages | TypeScript everywhere except the approvals toolkit (Python, `arcade-mcp`) |

## Services

    apps/web         Next.js — chat, persona switcher, approval page, control-plane panel.
                     Mastra agent runs in route handlers. → Render
    apps/hooks       Bun — /access /pre /post, policy engine, audit, SSE. Owns governance.db. → Render
    apps/loan-mcp    Bun — Streamable HTTP MCP server, the governed business system.
                     Owns loans.db. Registered in Arcade as a Remote MCP server. → Render
    tools/approvals  Python arcade-mcp — request_approval, decide. → arcade deploy

    packages/governance-core    Hook framework, policy engine, audit, event bus. Zero loan references.
    packages/policy-schema      Shared zod types for policy, events, hook payloads.

`apps/hooks` and `apps/loan-mcp` stay separate processes on purpose: one is the governed
system, the other is the thing governing it. Forking means replacing `apps/loan-mcp` and
the seed data, and touching nothing under `packages/`.

## Tool surface

**loan-app** (TypeScript)
- `search_loans(status?, min_amount?, max_amount?)`
- `get_loan(loan_id)` → includes `bank_account_number`, `tax_id`, `underwriter_notes`
- `approve_loan(loan_id, amount)`
- `deny_loan(loan_id, reason)`

**approvals** (Python)
- `request_approval(action, resource_id, amount, justification)` — routes deterministically, posts Block Kit
- `decide(request_id, decision, note?)` — called from the approval page as the clicker

## Cast (emails to be confirmed)

| Persona | Role | Limit | Notes |
|---|---|---:|---|
| Dana Okafor | Loan Officer | $50,000 | The protagonist |
| Sam Reyes | Credit Analyst | $0 | `approve_loan` hidden entirely — act 1 |
| Riley Chen | VP Credit | $250,000 | Minimum-sufficient approver for $95K |
| Morgan Ellis | Chief Credit Officer | $5,000,000 | Deliberately *not* bothered — proves routing |

Seed loan `LN-2291`, Northwind Bakery LLC, $95,000. Carries `bank_account_number` and
`tax_id` (act 3) and an `underwriter_notes` field containing an injected instruction (act 4).

## Event contract

    { id, ts, execution_id, hook: 'access'|'pre'|'post',
      user_id, tool, decision: 'allow'|'deny'|'modify',
      reason, rule_id, before?, after? }

## Open risks — resolve before building anything else

1. **Do contextual-access hooks fire for tools served by a registered Remote MCP server?**
   The docs do not say. If they don't, the architecture changes fundamentally.
   *Blocking. Verify first.*
2. **What survives a hook denial over MCP?** We confirmed `@arcadeai/arcadejs` exposes
   `execution_id` and typed `CONTEXT_CHECK_FAILED` / `CONTEXT_DENIED` errors with
   `additional_prompt_content`. Over MCP those may flatten to `isError: true` + text.
   Determines whether panel correlation is exact or heuristic.
3. **Does Arcade's stock Slack provider grant a user token with `chat:write`?**
   If not, register a custom Slack app as an Arcade auth provider. Act 2 depends on it.

## Sequence (~2.5 weeks)

1. Spikes 1–3 above.
2. Thinnest vertical slice: `loan-mcp` with `approve_loan` → registered in Arcade →
   one denying pre-hook → bare chat agent → deployed to Render. End to end, ugly.
3. Acts 1, 3, 4 — access hook, redaction, injection.
4. Approvals: Python toolkit, Slack, approval page, `decide` as a governed call, auto-resume.
5. Control-plane panel and the split-screen UI.
6. Rehearsal, reset script, README for forkers.
