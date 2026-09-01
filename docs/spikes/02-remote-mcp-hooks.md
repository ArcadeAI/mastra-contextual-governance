# Spike 02 — Do contextual-access hooks fire for Remote MCP server tools?

**Answer: yes.** All three hooks — `/access`, `/pre`, `/post` — fire for tools served by a
Remote MCP server registered in Arcade, with a payload identical in shape to the one hosted
toolkits produce. `DESIGN.md`'s architecture holds: `apps/loan-mcp` can be an external Bun
service.

Resolves [#2](https://github.com/ArcadeAI/mastra-contextual-governance/issues/2).
Clears open risk 1 in `DESIGN.md`.

## How this was answered

Not by experiment. The behaviour was verified internally against Arcade's engine
implementation, which is not public — so this document records **what the platform does**,
with no citations, quotations, or internal identifiers. Everything below is observable from
outside: register a remote server, attach a hook, and you can reproduce all of it.

Public documentation does not settle the question either way. The contextual-access guide
describes hooks purely in terms of "tools" and never scopes them to a tool source, and the
third-party-MCP announcement is silent on hooks. That gap is what made this spike necessary;
it is worth an upstream docs request.

## What holds, and why it is stable

A Remote MCP server is not a special case in Arcade's execution path. It is registered as
the same kind of tool-serving backend as a hosted toolkit, differing only in the transport
used to reach it. The hook pipeline runs around that transport, not inside it: the
pre-execution hook runs, then the tool is dispatched to whichever backend serves it, then the
post-execution hook runs. Access filtering is applied to tool *definitions* during discovery,
before any notion of transport enters the picture.

Two consequences worth relying on:

- The governance layer has no way to distinguish a remote MCP tool from a hosted-toolkit
  tool, so it cannot treat them differently — this is not a feature that could quietly
  regress for remote servers only.
- Calls arriving over an MCP gateway (`https://api.arcade.dev/mcp/{gateway}`, which is what
  Mastra's `MCPClient` will use) are governed on the same path as SDK calls. `tools/list`
  over that surface is access-filtered; `tools/call` runs pre and post.

## Payload: identical to hosted toolkits

`/pre` receives:

```
{ execution_id, tool: { name, toolkit, version }, inputs, context }
```

`/post` receives the same plus `{ success, output, execution_code, execution_error }`.

`/access` receives `{ user_id, toolkits }`, where `toolkits` is keyed by toolkit name and
each toolkit's `tools` map is keyed by raw tool name. It answers with `only` / `deny` lists.

`/pre` and `/post` answer with `{ code, error_message?, override? }`, where `code` is one of
`OK`, `CHECK_FAILED`, `RATE_LIMIT_EXCEEDED`.

**There is no field identifying the tool's origin.** A hook server cannot tell a remote MCP
tool from a hosted-toolkit tool by payload alone. If `apps/hooks` needs to know, it must
derive it from `tool.toolkit` — which makes the naming rules below load-bearing, not cosmetic.

## Tool namespacing — record this verbatim, it has a trap in it

The toolkit name for a remote MCP server's tools is **not** the server ID you type into the
dashboard. It is derived from the `serverInfo.name` the MCP server itself returns in its
`initialize` response, normalised like this:

1. lowercase
2. **remove every occurrence of `mcp` and `server`** — as substrings, case-insensitively,
   not as whole words
3. split on non-alphanumeric characters
4. title-case each part and join
5. if nothing survives, fall back to `Tools`

Tool names pass through untouched. Version comes from `serverInfo.version`, reduced to
letters, numbers, `-` and `.`, falling back to `0.0.0` if that leaves nothing.

Name forms and their separators:

| Separator | Where it appears |
|---|---|
| `.` | Arcade fully-qualified name: `Toolkit.tool_name` |
| `@` | version suffix: `Toolkit.tool_name@version` |
| `_` | MCP / function wire name: `Toolkit_tool_name` |

So for a server reporting `serverInfo.name = "loan-app"`, `version = "1.0.0"`, exposing
`approve_loan`:

| Surface | Form |
|---|---|
| Arcade fully-qualified name | `LoanApp.approve_loan@1.0.0` |
| MCP wire name (what Mastra's `MCPClient` sees, `tools/list` / `tools/call`) | `LoanApp_approve_loan` |
| `/pre` and `/post` payload | `tool.toolkit = "LoanApp"`, `tool.name = "approve_loan"`, `tool.version = "1.0.0"` |
| `/access` payload | `toolkits["LoanApp"].tools["approve_loan"]` |

**The trap:** name the server `loan-mcp` or `loan-mcp-server` and the toolkit collapses to
`Loan` — `mcp` and `server` are stripped as substrings, not as words. Pick a
`serverInfo.name` with neither substring in it, and pin it, because every policy rule, deny
list and panel label keys off the result.

Two further constraints on names:

- toolkit name: ASCII letters and numbers only — no `-`, no `_`. The normalisation
  guarantees this, which is also why the dashboard's server ID cannot itself be the toolkit
  name.
- tool name: ASCII letters, numbers, `-` and `_`.

## Timeouts and failure mode

- default hook timeout **5s**, applied per hook point
- configurable per endpoint via `timeout_ms`, accepted range **100ms–120s** (some hook
  create/patch paths cap at 30s)
- retry is **off by default**; when enabled: 3 attempts, exponential backoff from 100ms,
  retrying on 5xx, timeout and connection errors
- response caching is **off by default**; TTL configurable from 1s to 1 week
- **default failure mode is fail-closed.** A hook server that is down or slow blocks every
  governed tool call, including `loan-app`'s read-only ones. That is the right default for
  the demo's thesis, but it makes `apps/hooks` a hard dependency of the stage demo rather
  than a side-car — it needs a real health check and a rehearsal failure drill.

Hooks on the same hook point run as a priority-ordered pipeline; any denial stops the
pipeline and skips later phases.

## Incidental, outside this slice

Recording, not acting on: **what survives a denial over MCP** (`DESIGN.md` risk 2). It
flattens, as suspected. The agent receives a tool result with `isError: true` whose text is
the hook's own `error_message` behind a fixed prefix:

```
Tool execution was denied by an extension policy: <error_message>
```

Good for act 2 — the hook's remediation text reaches the model verbatim, so "the hook writes
the remediation instruction" survives. Bad for the panel — `execution_id` and the typed error
kind do **not** cross the MCP boundary, so correlation over MCP will have to be heuristic.
That belongs to the risk-2 spike; it is noted here only because it fell out of the same work.
