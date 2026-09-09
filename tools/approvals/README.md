# tools/approvals

The human-in-the-loop toolkit. `request_approval` routes a refused action to
the one person whose authority covers it and DMs them; `decide` records that
person's answer.

A Python `arcade-mcp` toolkit, like its sibling
[`tools/loan`](../loan/README.md): outside the Bun workspaces, outside
`render.yaml`, shipped with `arcade deploy`. `arcade-mcp` is the framework the
agent's tools are authored in and it is Python-only, so both toolkits are
Python while everything under `apps/` and `packages/` is TypeScript. The
boundary is tool authoring, not domain.

A forker who wants no Python deletes this directory and `tools/loan`, and
substitutes their own tools. Nothing under `packages/` imports either one.

## The two tools

    request_approval(action, resource_id, amount, justification)
      -> { request_id, status, approver, approver_display_name,
           required_clearance, candidate_approvers, approval_url,
           slack_message_ts }

    decide(request_id, decision, note?)
      -> the approval request as it stands after the decision

`request_approval` is what the agent reaches for after the pre-hook denies it.
The hook's own remediation message is what sends it here — the system prompt
says nothing about approvals, because a control the model is *asked* to respect
is not a control.

## Three things it deliberately does not do

**It does not choose the approver.** Routing is deterministic: lowest
sufficient clearance, requester excluded, ties broken by `user_id`. There is no
argument through which the agent could name an approver, which is a stronger
statement than a rule that ignores one.

**It does not decide anything.** `decide` records an outcome. Whether the
caller may decide — their role, their authority, and that they are not the
person who asked — is a `/pre` decision about `Approvals.Decide`, answered by
`apps/hooks` before this code runs and enforced in #19. `decide` therefore
declares **no** OAuth requirement: Arcade evaluates auth requirements *before*
`/pre`, so a credential refusal fires no hook, writes no audit row and shows
nothing on the panel — and the refusal of `decide` is precisely the beat the
demo needs to be visible.

**It does not hand out authority.** The link in the Slack message is a pointer
to a request id. No token, no signature, no capability, no query string. The
requester can read the DM she sent, so possession of the URL must not be the
same as permission. `tests/test_message.py` asserts this against the rendered
payload, because a signed link is the sort of convenience that gets added back
later by someone who does not know why it is absent.

## Routing, and how it is kept honest

`approvals/routing.py` is a parity port of
[`packages/governance-core/src/approver-router.ts`](../../packages/governance-core/src/approver-router.ts)
(#9). Two implementations of one rule in two languages is a real divergence
risk, so neither is argued to agree with the other: both load
[`packages/policy-schema/contract/approver-routing-cases.json`](../../packages/policy-schema/contract/approver-routing-cases.json)
and are checked row for row against it. A row added there is checked on both
sides on the next run.

    $95,000 from Dana ($50K) with Riley ($250K) and Morgan ($5M) on the roster
    → Riley. Morgan is recorded as a candidate and deliberately not bothered.

## Slack

Access is brokered by Arcade's **stock** Slack provider. There is no custom
Slack app, no bot token, and nothing to provision: the provider issues the
requester's own user token, so the DM arrives under her name with no APP badge.
Measured end to end in
[`docs/spikes/03-slack-scopes.md`](../../docs/spikes/03-slack-scopes.md) (#3),
which also records both fallbacks for a forker who wants a bot instead.

Four scopes, not three:

    chat:write  users:read  users:read.email  users.profile:read

`users:read` is a prerequisite for `users:read.email` — Slack refuses the
authorize request outright without it, before any consent screen.

⚠️ **This list differs from spike #3's by one scope, and the difference is
deliberate but unverified against live Slack.** The spike declared
`chat:write, im:write, users:read, users:read.email` and reached the DM with
`users.lookupByEmail → conversations.open → chat.postMessage`.
`conversations.open` is what needs `im:write`. Issue #18's `[control]` comment
and `.env.example` both pin `users.profile:read` in its place, so this toolkit
does not call `conversations.open` at all: it passes the approver's **user id**
as `chat.postMessage`'s `channel` and lets Slack resolve the DM. That path was
not exercised in the spike. If a live run returns `channel_not_found` on a user
id, add `im:write` and `conversations.open` back — the code for it is two lines
in `approvals/slack.py`, and the spike's transcript has the exact calls.

`SLACK_APPROVALS_CHANNEL` in `.env.example` is **not read by this toolkit**.
The message goes to the routed approver, because who was asked is the point
being demonstrated; a fixed channel would lose it.

## Where the approval request lives

Nowhere in this toolkit. A deployed `arcade deploy` worker is an ephemeral
container, and — the reason that actually settles it — the approval page in #19
runs in `apps/web` and has to read the record the tool wrote. So the request is
persisted where `DESIGN.md` says approvals live: `governance.db`, owned by
`apps/hooks`, reached over HTTP the same way Arcade reaches the hooks.

`approvals/store.py` is that client, and its module docstring is the contract:

    GET  /approvals/roster              -> { subjects: [...] }
    POST /approvals                     -> { request: ApprovalRequest, rule: {...}|null }
    POST /approvals/{id}/decision       -> { request: ApprovalRequest }

⚠️ **`apps/hooks` does not serve these three endpoints yet.** #12 is the
service and #19 is the approval flow. What lands in this slice is the client
and the contract, driven in the tests against a stand-in server that implements
exactly that shape (`tests/conftest.py`), the way `tools/loan/tests` drives a
stand-in `/oauth2/userinfo`. Read `FakeStore` as the specification the real
endpoint has to meet.

The store mints the request id and the creation timestamp — a server clock and
a server id. An id this toolkit invented would be an id the caller could
predict.

## Configuration

Three Arcade secrets, uploaded by `arcade deploy` from the repo's `.env`,
because a secret is the one configuration channel a deployed toolkit has. All
HOST-form, like every address in this repo; consumers add the scheme.

| secret | what |
|---|---|
| `HOOKS_PUBLIC_HOST` | the control plane, which owns `governance.db` |
| `WEB_PUBLIC_HOST` | used to build the approval link, and nothing else |
| `APPROVALS_STORE_TOKEN` | shared bearer the approvals endpoints require |

`APPROVALS_STORE_TOKEN` is not ceremony. Without it the approvals store would
accept a record from anyone on the internet, and that record is what a human
then acts on.

## Run and test

```sh
uv sync --extra dev
uv run --extra dev pytest        # boots stand-in store and Slack on OS-assigned ports
uv run server.py http            # Streamable HTTP on 127.0.0.1:8000
```

Nothing in the suite binds a fixed port and nothing reaches the internet.

## Deploy

```sh
arcade deploy                    # from this directory
```

`arcade deploy` starts `server.py`, reads `serverInfo.name` and `version` off
its `initialize` response, and ships the package under that name — the
`MCPApp(name=...)` in `approvals/__init__.py`, not the package name in
`pyproject.toml`.

`name="approvals"` PascalCases to the toolkit **`Approvals`**, and `arcade-mcp`
PascalCases the tools itself, so these are `Approvals.RequestApproval` and
`Approvals.Decide`; the MCP wire names through a gateway are
`Approvals_RequestApproval` and `Approvals_Decide`.

⚠️ **That is derived from `tools/loan`'s measurement, not observed here.** #34
measured `loan` → `Loan` and `loan_mcp_probe` → `LoanMcpProbe` on a real
deploy; this package had no tools to deploy at the time. Thirty seconds after
the first deploy: read `toolkit.name` off `GET /v1/workers/<server>/tools`,
correct `ARCADE_APPROVALS_TOOLKIT` in `.env.example` if it differs, and report
on #35. A policy rule keyed on the wrong string matches nothing, which is
indistinguishable from a rule that permits.

The toolkit also has to be added to the gateway (#13) before the agent can call
it, and every persona who can trigger act 2 authorizes Slack once. Rehearse
that authorization; a scope refusal happens upstream of every hook and leaves
the panel dark.
