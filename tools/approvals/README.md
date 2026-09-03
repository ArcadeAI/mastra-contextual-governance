# tools/approvals

The human-in-the-loop toolkit: `request_approval` routes to the
minimum-sufficient approver and posts Slack Block Kit as the requester;
`decide` records the outcome and is itself a governed tool call.

Both are stubs at this point — see #18 and #19.

## Why this one is different

Every other service in this repo is TypeScript and deploys from
`render.yaml`. This one is Python and deploys with:

```sh
uv sync
arcade deploy
```

That is on purpose. Arcade hosts it, so it demonstrates how a forker authors
their own governed custom toolkit — and it keeps the Render blueprint to the
three services Render is actually responsible for.

Slack scopes are settled: the stock provider grants a user token with
`chat:write`, and the tool must request four scopes, not three — `users:read`
is a prerequisite for `users:read.email`. See
[`docs/spikes/03-slack-scopes.md`](../../docs/spikes/03-slack-scopes.md).
