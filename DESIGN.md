# Contextual Governance — Mastra × Arcade

A live demo, shipped as a forkable template: an agent that does real work in a real
business system, with Arcade enforcing deterministic control on every tool call.

Source narrative: loan officer asks an agent to approve a $95K loan and "double-check
your work." Four things go wrong. All four are caught by the control plane, not by the
model.

## Thesis

Treat the LLM as an adversary. Controls it cannot reason around must live outside it.
Arcade provides **four** identity-keyed control points on every tool call, and the model
sits inside all of them:

| # | Layer | Keyed on | Mechanism | Act |
|---|---|---|---|---|
| 1 | Whether you can see the tool | identity | `/access` → `deny` list | 1 |
| 2 | Whether you hold the credential to call it at all | identity | per-tool auth requirement, OAuth scopes | — |
| 3 | Whether you have the authority for *this* call | identity + policy | `/pre` → `CHECK_FAILED` | 2 |
| 4 | What comes back | policy | `/post` → `override.output` | 3, 4 |

Layer 2 was added on #32. It is not a gap in governance — it is a cheaper, earlier gate on
the same identity, and defence in depth is the point. **It has one consequence the other
three do not:** Arcade evaluates auth requirements *before* `/pre`, so a refusal there fires
no hook, writes no audit row, and shows nothing on the panel (measured, spike #2). Never
stage a beat we want to *show* as a layer-2 refusal. See open risk 2.

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
| Integration | Mastra `MCPClient` → `https://api.arcade.dev/mcp/{gateway}` |
| Model | Claude Sonnet 5 via `@ai-sdk/anthropic`, temperature 0, model id from env |
| **Tool layer** | **Both toolkits are Python `arcade-mcp`, shipped with `arcade deploy` into one Arcade project and exposed through one gateway. `arcade-mcp` is the tool-authoring framework; it is Python-only, which is why the TS-everywhere rule does not reach the toolkits. Decided on #32, confirmed in session.** |
| **Business system** | **`apps/loan-app` is a plain HTTP API — the bank's system of record. It is not an MCP server and knows nothing about Arcade. `tools/loan` is a stateless client of it. Decided on #32; splitting them is what makes "governance is outside the business system" literal rather than asserted.** |
| **Identity** | **Every persona is a real Arcade account with a real email. The persona switcher selects which Arcade user the agent acts as. `context.user_id` on every hook payload is that email.** |
| **Authorization** | **The loan tools require OAuth against our own provider, so they call `apps/loan-app` on behalf of the user rather than as a service account. The API derives the actor from the token, never from a parameter. OAuth carries *identity*; hooks carry *authority*. Proposed provider: Better Auth (TypeScript, ships an OAuth 2.1 / OIDC provider plugin). Placement open — see below.** |
| **One identity, not two** | **The Arcade `user_id`, the OAuth subject, and the actor `apps/loan-app` records are the same person, joined on email. If these ever diverge, `governance.db` and `loans.db` describe different people and the audit trail is fiction.** |
| Policy source | Policy DB owned by the hook server. Editable live on stage. |
| HITL | Custom `request_approval` tool posts Block Kit to Slack; approval link carries **no authority** |
| Approval authz | `approvals.decide` is itself a governed tool call — pre-hook enforces role, limit, and requester ≠ approver |
| Approver routing | Deterministic minimum-sufficient-clearance, requester excluded. The LLM does not choose the approver. |
| The wait | Agent ends its turn; SSE `approval.granted` event auto-resumes it |
| Determinism | The **hook** writes the remediation instruction, not the system prompt |
| Redaction | Declarative per-tool field rules + regex over free text |
| Database | `bun:sqlite`, two files: `loans.db` (domain), `governance.db` (policy + audit) |
| Durability | Data persists; resetting is something you deliberately run. Both databases sit on Render disks and seed from their fixture only when empty. Reset is a script (#23), never a redeploy. Decided on #29 |
| Visualization | Hook server → SSE → live three-lane Access/Pre/Post panel |
| Design | Left half deliberately boring enterprise app; right half Arcade-branded control plane |
| **Hosting** | **Render (`render.yaml` blueprint) for `web`, `hooks`, `loan-app`. `arcade deploy` for `tools/loan` and `tools/approvals`.** |
| **Languages** | **TypeScript for the three Render services and everything under `packages/`. Python for both `arcade-mcp` toolkits. The boundary is *tool authoring*, not *domain*.** |

## Services

    apps/web         Next.js — chat, persona switcher, approval page, control-plane panel.
                     Mastra agent runs in route handlers. → Render
    apps/hooks       Bun — /access /pre /post, policy engine, audit, SSE. Owns governance.db. → Render
    apps/loan-app    Bun — plain HTTP API, the bank's system of record. Owns loans.db.
                     No MCP, no Arcade, no governance. → Render

    tools/loan       Python arcade-mcp — search_loans, get_loan, approve_loan, deny_loan.
                     Stateless client of apps/loan-app. → arcade deploy
    tools/approvals  Python arcade-mcp — request_approval, decide. → arcade deploy

    packages/governance-core    Hook framework, policy engine, audit, event bus. Zero loan references.
    packages/policy-schema      Shared zod types for policy, events, hook payloads.

`apps/hooks` and `apps/loan-app` stay separate processes on purpose: one is the governed
system, the other is the thing governing it. Forking means replacing `apps/loan-app`,
`tools/loan` and the seed data, and touching nothing under `packages/`.

That boundary is enforced by tests, not comments. `apps/loan-app` declares
`"cg": { "governed": true }` in its manifest; `knows-nothing-about-governance.test.ts`
fails if governance vocabulary or a `@cg/*` import appears in its source, and
`policy-schema`'s workspace sweep exempts flagged workspaces rather than forcing the
dependency in. Both halves read the same flag so they cannot drift apart. Decided on #33.

## Identity and OAuth

The call chain, end to end:

    Dana (persona switcher)
      → Mastra MCPClient → https://api.arcade.dev/mcp/{gateway}   as Arcade user dana@…
        → /access   hooks see user_id = dana@…            ← layer 1
        → auth requirement: does Dana hold a token?        ← layer 2 (no hook fires)
        → /pre      hooks see user_id = dana@…            ← layer 3
          → tools/loan (arcade deploy) receives Dana's OAuth token
            → apps/loan-app validates it, actor = dana@…
        → /post     hooks rewrite the output               ← layer 4

Three rules this has to hold to:

1. **`apps/loan-app` derives the actor from the token, never from a request parameter.**
   An actor passed as an argument is an actor the model can forge, and act 4 is
   specifically about the model trying to.
2. **Scopes are not the governance gate.** A layer-2 refusal is invisible to the control
   plane. Every beat we intend to *show* is an `/access` or `/pre` decision.
3. **Email is the join key.** Arcade `user_id`, OAuth subject, and `loans.db`'s actor
   column are the same string.

**Open: where Better Auth runs.** It is an authorization server, and it has to live
somewhere with a browser-facing login. `apps/web` is its natural home — the personas
already log in there and Next.js is Better Auth's canonical deployment — but that makes
the demo's own UI the bank's IdP, which is not the shape a forker would have. Putting it
in `apps/loan-app` instead collides with the boundary test, which greps that service's
source for `role`, `permission`, `authority` and `limit`; Better Auth's own vocabulary
would trip it, and loosening that test to accommodate auth is exactly the erosion the test
exists to prevent. A fourth Render service is the third option. Not yet decided.

## Tool surface

**loan** (Python, `arcade deploy`)
- `search_loans(status?, min_amount?, max_amount?)`
- `get_loan(loan_id)` → includes `bank_account_number`, `tax_id`, `underwriter_notes`
- `approve_loan(loan_id, amount)`
- `deny_loan(loan_id, reason)`

**approvals** (Python, `arcade deploy`)
- `request_approval(action, resource_id, amount, justification)` — routes deterministically, posts Block Kit
- `decide(request_id, decision, note?)` — called from the approval page as the clicker

⚠️ **Neither toolkit's name has been observed yet.** `arcade deploy` derives it from the
package, but whether it is the raw package name or a normalised form is unmeasured — spike
#2 found that Remote MCP registration applies an aggressive normalisation (lowercase, strip
every `mcp`/`server` substring, PascalCase) and that a hyphenated segment cannot form a
parseable tool name at all. A policy rule keyed on the wrong toolkit matches nothing, which
is indistinguishable from a rule that permits. **Read both names off a real `/pre` payload
and pin them in `.env.example` before #7 writes a rule.** Tracked on #35.

## Cast (emails to be confirmed)

| Persona | Role | Limit | Notes |
|---|---|---:|---|
| Dana Okafor | Loan Officer | $50,000 | The protagonist |
| Sam Reyes | Credit Analyst | $0 | `approve_loan` hidden entirely — act 1 |
| Riley Chen | VP Credit | $250,000 | Minimum-sufficient approver for $95K |
| Morgan Ellis | Chief Credit Officer | $5,000,000 | Deliberately *not* bothered — proves routing |

Each persona needs an Arcade account and an account in the OAuth provider, under the same
email.

Seed loan `LN-2291`, Northwind Bakery LLC, $95,000. Carries `bank_account_number` and
`tax_id` (act 3) and an `underwriter_notes` field containing an injected instruction (act 4).

## Event contract

    { id, ts, execution_id, hook: 'access'|'pre'|'post',
      user_id, tool, decision: 'allow'|'deny'|'modify',
      reason, rule_id, before?, after? }

## Open risks

1. ~~**Do contextual-access hooks fire for tools served by a registered Remote MCP
   server?**~~ **Resolved twice over.** Measured yes for Remote MCP servers and for hosted
   toolkits — `docs/spikes/02-remote-mcp-hooks.md` (#2), with raw payloads. Confirmed in
   session by Arcade: **hooks apply to all tools regardless of where the server is hosted**,
   including `arcade deploy`'d toolkits, which is the path this demo now runs on. Spike #2
   remains valid and is now documentation of a capability the live demo no longer exercises,
   since nothing here is registered as a Remote MCP server.

2. **Layer-2 refusals are invisible to the control plane.** Measured, spike #2: an unmet
   auth requirement returns `tool_requirements_not_met` and no hook fires — no `/pre` event,
   no audit row, nothing on the panel. Not an architectural problem, but it constrains two
   slices: **#14/#21** must not stage a beat as an auth failure, and **#12**'s audit schema
   cannot claim `governance.db` is a complete record of refusals. Worth a line in the panel
   naming the layer that refuses upstream of the hooks.

3. **Toolkit names are unmeasured.** See **Tool surface**. Tracked on #35, blocks #7.

4. **Identity could silently split.** Arcade `user_id` and the OAuth subject are joined by
   convention, not by a mechanism. If a persona's Arcade email and provider email drift,
   the pre-hook governs one person and the loan book records another, and every test still
   passes. Whoever builds the auth slice should assert the join, not assume it.

5. ~~**Does Arcade's stock Slack provider grant a user token with `chat:write`?**~~
   *Answered: yes — `docs/spikes/03-slack-scopes.md` (#3). Act 2 posts as the requester.
   The tool must request four scopes, not three: `users:read` is a prerequisite for
   `users:read.email`.*

6. **What survives a hook denial over MCP?** `@arcadeai/arcadejs` exposes `execution_id` and
   typed `CONTEXT_CHECK_FAILED` / `CONTEXT_DENIED` errors, but over MCP those flatten toward
   `isError: true` + text. Resolved for our purposes by the hook-embedded correlation token
   (#6); noted here because it shapes what the panel can claim.

## Sequence (~2.5 weeks)

1. Spikes 1–3. **Done.**
2. Scaffold, policy schema, loan book. **Done** (#4, #5, #11).
3. Split into `apps/loan-app` + `tools/loan`; measure the toolkit names (#34, #35).
4. Arcade wiring: gateway, hook extension, OAuth provider (#13).
5. Thinnest vertical slice, end to end and ugly: agent → gateway → tool → API, one denying
   pre-hook (#14).
6. Acts 1, 3, 4 — access hook, redaction, injection.
7. Approvals: Slack, approval page, `decide` as a governed call, auto-resume.
8. Control-plane panel and the split-screen UI.
9. Rehearsal, reset script, README for forkers.
