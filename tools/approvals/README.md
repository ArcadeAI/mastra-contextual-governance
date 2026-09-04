# tools/approvals

The human-in-the-loop toolkit: `request_approval` routes to the
minimum-sufficient approver and posts Slack Block Kit as the requester;
`decide` records the outcome and is itself a governed tool call.

Both are stubs at this point — see #18 and #19.

## How it ships

Like its sibling [`tools/loan`](../loan/README.md), this is a Python
`arcade-mcp` toolkit, and it deploys with:

```sh
uv sync
arcade deploy
```

`arcade-mcp` is the framework the agent's tools are built with, and it is
Python-only — so both toolkits are Python, while everything under `apps/` and
`packages/` is TypeScript. The boundary is tool authoring, not domain. Arcade
hosts the toolkits, which keeps the Render blueprint to the services Render is
actually responsible for.

Slack scopes are settled: the stock provider grants a user token with
`chat:write`, and the tool must request four scopes, not three — `users:read`
is a prerequisite for `users:read.email`. See
[`docs/spikes/03-slack-scopes.md`](../../docs/spikes/03-slack-scopes.md).
