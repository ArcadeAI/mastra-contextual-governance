# Spike 02 — Do contextual-access hooks fire for Remote MCP server tools?

**Answer: yes.** All three hooks — `/access`, `/pre`, `/post` — fire for tools served by a
Remote MCP server registered in Arcade, with a payload identical in shape to the one hosted
toolkits produce. `DESIGN.md`'s architecture holds: `apps/loan-mcp` can be an external Bun
service.

Resolves [#2](https://github.com/ArcadeAI/mastra-contextual-governance/issues/2).
Clears open risk 1 in `DESIGN.md`.

**Reproduced.** Run end to end on 2026-09-02 against a throwaway project: a probe MCP server
registered as a Remote MCP server, a webhook extension with all three hooks, one allow pass
and one deny pass. Raw payloads in
[`evidence/02-remote-mcp-hooks-transcript.md`](evidence/02-remote-mcp-hooks-transcript.md).

## How this was answered

The experiment #2 specified. A probe service exposing one trivial MCP tool was registered as a
Remote MCP server; a webhook extension was attached with `/access`, `/pre` and `/post`; the
tool was called once with the hooks permitting and once with the pre-hook denying. The probe
logged every inbound hook request verbatim.

All three hooks fired. The full transcript, including every payload, is in
[`evidence/02-remote-mcp-hooks-transcript.md`](evidence/02-remote-mcp-hooks-transcript.md) —
anyone can re-run it and diff.

One leg is **not** covered: the call was made over the SDK execute path, not through an MCP
gateway. See [Outstanding](#outstanding).

## What holds, and why it is stable

A Remote MCP server is not a special case in Arcade's execution path. It is registered as the
same kind of tool-serving backend as a hosted toolkit, differing only in the transport used to
reach it. The hook pipeline runs around that transport, not inside it: the pre-execution hook
runs, the tool is dispatched to whichever backend serves it, the post-execution hook runs.
Access filtering is applied to tool *definitions* during discovery, before transport enters
the picture.

Consequences worth relying on:

- The governance layer is not handed anything that distinguishes a remote MCP tool from a
  hosted-toolkit tool, so it does not treat them differently. This is not a coverage feature
  that could regress for remote servers alone.
- Calls arriving over an MCP gateway (`https://api.arcade.dev/mcp/{gateway}`, which is what
  Mastra's `MCPClient` will use) are governed on the same path as SDK calls. `tools/list` over
  that surface is access-filtered; `tools/call` runs pre and post.

Observed directly. With the hooks permitting, the probe saw
**`/access` → `/pre` → tool reached the backend → `/post`**. With the pre-hook denying, it saw
**`/access` → `/pre`** and nothing further: the backend was never reached and `/post` never
ran. `execution_id` was identical across `/pre` and `/post`, so the two correlate exactly on
the SDK path.

## Payload: identical to hosted toolkits

All of this section is public — it matches
[Build your own](https://docs.arcade.dev/en/guides/contextual-access/build-your-own) field for
field. The finding here is only that a remote MCP server produces the *same* shape.

`/pre` receives `{ execution_id, tool: { name, toolkit, version }, inputs, context }`.
`/post` receives the same plus `{ success, output, execution_code, execution_error }`.
`/access` receives `{ user_id, toolkits }`, keyed by toolkit name with each toolkit's `tools`
map keyed by raw tool name, and answers with `only` / `deny` lists.
`/pre` and `/post` answer `{ code, error_message?, override? }`, `code` being one of `OK`,
`CHECK_FAILED`, `RATE_LIMIT_EXCEEDED`.

**No field identifies the tool's origin** — confirmed on the captured payloads, which carry no
`servers` and no `headers`. A hook server cannot tell a remote MCP tool from a hosted-toolkit
tool by payload alone; it must derive that from `tool.toolkit`. That is what makes the naming
rules below load-bearing rather than cosmetic — and what makes getting them wrong silent.

The engine passes caller identity to the MCP server itself out-of-band, in
`_meta.arcade_context` on the `tools/call` params.

## Tool namespacing

The toolkit name for a remote MCP server's tools is **not** the server ID you type into the
dashboard. It is derived from the `serverInfo.name` the MCP server itself returns in its
`initialize` response, normalised:

1. lowercase
2. **remove every occurrence of `mcp` and `server`** — as substrings, case-insensitively, not
   as whole words
3. split on non-alphanumeric characters
4. title-case each part and join
5. if nothing survives, fall back to `Tools`

Tool names pass through untouched. Version comes from `serverInfo.version`, reduced to
letters, numbers, `-` and `.`, falling back to `0.0.0`.

Separators: `.` for the Arcade fully-qualified name, `@` for version, `_` for the MCP /
function wire name.

For a server reporting `serverInfo.name = "loan-app"`, `version = "1.0.0"`, exposing
`approve_loan`:

| Surface | Form |
|---|---|
| Arcade fully-qualified name | `LoanApp.approve_loan@1.0.0` |
| MCP wire name (what Mastra's `MCPClient` sees) | `LoanApp_approve_loan` |
| `/pre` and `/post` payload | `tool.toolkit = "LoanApp"`, `tool.name = "approve_loan"` |
| `/access` payload | `toolkits["LoanApp"].tools["approve_loan"]` |

**The trap:** `loan-mcp` or `loan-mcp-server` collapses to `Loan`, because `mcp` and `server`
are stripped as substrings, not words. Choose a `serverInfo.name` containing neither, and pin
it.

### This contradicts Arcade's published example. Measured.

The [third-party-MCP announcement](https://www.arcade.dev/blog/bring-third-party-mcp-server-to-arcade/)
says you reference a remote tool as `render-mcp-server.get_key_value`, i.e. by the registered
server ID. That is not what the platform does.

The experiment was built to discriminate. The probe was registered under ID `spike-02-probe`
while reporting `serverInfo.name = "loan-mcp-server"` — so the three candidate rules predicted
three different strings:

| Rule | Predicted toolkit | Observed |
|---|---|---|
| Registered server ID (the blog's reading) | `spike-02-probe` | ✗ |
| Naive passthrough of `serverInfo.name` | `loan-mcp-server` | ✗ |
| Normalisation described above | `Loan` | ✓ |

Arcade resolved it to **`Loan.ping_probe@1.0.0`**. The `mcp` and `server` substrings are
stripped from `loan-mcp-server`, leaving `loan` → `Loan`.

**The published example is wrong**, or at best is loose prose about the server you registered
rather than the name a tool resolves to. A policy rule written against `render-mcp-server.*`
would match nothing. That is filed upstream as #26.

### Before you write a policy rule: read the toolkit name off the wire

The rule is now measured rather than asserted, but #12 and #13 should still confirm the value
rather than inherit it from here — the normalisation is undocumented, so it is not a contract
Arcade owes us and it can change. After registering `loan-mcp`, log one real `/pre` payload
and read `tool.toolkit` out of it:

```ts
// apps/hooks — temporary, delete once the value is pinned
app.post('/pre', async (c) => {
  const body = await c.req.json()
  console.log('PRE tool =', JSON.stringify(body.tool))   // the only authority
  return c.json({ code: 'OK' })
})
```

Pin the observed string in one shared constant and key every rule off it. **A policy rule
that matches nothing is indistinguishable from a rule that permits** — act 2 would fail open
silently, which is the precise failure the demo exists to disprove. Five minutes, and it
survives the normalisation changing under us.

## Timeouts

- default hook timeout **5s**, configurable per extension and overridable per hook — public,
  per [Build your own](https://docs.arcade.dev/en/guides/contextual-access/build-your-own).
- retry is optional and off unless enabled; only transient failures (5xx, timeout, connection
  error) are retried, 4xx is not — also public, same page.
- response caching is off by default.
- **`timeout_ms` exists at two levels and they are not the same field.** Creating the
  extension with `timeout_ms: 10000` on each webhook *endpoint* stored 10000 on the endpoint
  but left each *hook* at `5000`. If 5s is not what you want, set the hook-level value
  explicitly and read it back. The accepted bounds were not probed.

## Failure mode: there is no default — you must state it

Measured, and this corrects an earlier draft of this document that claimed the default was
fail-closed. It isn't fail-closed, and it isn't fail-open: creating a webhook extension
without `failure_mode` is **rejected**.

```
400 malformed_request
webhook_config.endpoints.access: failure_mode is a required field
```

Arcade's published docs are right to present it as a per-hook choice and to state no default.
There is nothing to inherit. **#13 must set `failure_mode` explicitly on all three hooks**, and
fail-closed is the setting this demo's thesis requires.

That carries a consequence worth designing for: a hook server that is down or slow blocks every
governed tool call, including `loan-app`'s read-only ones. It makes `apps/hooks` a hard
dependency of the stage demo rather than a side-car — it needs a real health check and a
rehearsal failure drill.

Two related defaults, both observed: retry is stored `enabled: false` (3 attempts, exponential
from 100ms, on 5xx / timeout / connection_error), and **a newly created extension is
`status: inactive`** — it must be activated before any hook fires. A hook that silently never
runs because the extension was left inactive is the same silent fail-open as a rule that
matches nothing.

## Confidence

| Claim | Status |
|---|---|
| `/access`, `/pre`, `/post` all fire for a remote MCP server tool | **Measured.** Full transcript in `evidence/` |
| Pre-hook denial blocks before the backend is reached; `/post` is skipped | **Measured** |
| `execution_id` correlates `/pre` and `/post` | **Measured**, on the SDK execute path |
| Toolkit resolves to `Loan` from `serverInfo.name = loan-mcp-server` | **Measured.** Discriminated against both rival rules |
| Payload carries no field identifying tool origin | **Measured** |
| No default `failure_mode`; the field is required | **Measured** |
| Extension is created inactive; retry off by default | **Measured** |
| Hook payload shapes, response codes, 5s default | **Public**, cited, and matches what was captured |
| Same behaviour when called through an **MCP gateway** rather than the SDK | **Not tested.** See Outstanding |
| Denial's wire form *over MCP* (`isError` + text) | **Not tested.** SDK path shows `CONTEXT_DENIED` + prefixed message |

## Outstanding

<a id="outstanding"></a>

One leg remains. The calls above went through the SDK execute path. **The MCP gateway path —
`https://api.arcade.dev/mcp/{gateway}`, which is what Mastra's `MCPClient` will use — was not
exercised**, because creating a gateway is a dashboard action and is not exposed on either API
surface reachable with a project key.

What it would settle:

- that `tools/list` over a gateway is access-filtered (act 1 depends on this specific path)
- the wire form of a denial over MCP, which `DESIGN.md` risk 2 and #6 both turn on — whether
  `execution_id` survives, or whether it flattens to `isError` + text

The rest of the setup is reusable: register the probe, attach the extension, create a gateway
exposing `Loan.ping_probe`, and call it over Streamable HTTP. Perhaps twenty minutes once a
gateway exists.

## Incidental, outside this slice

**What survives a denial** (`DESIGN.md` risk 2, owned by #6). On the SDK path, measured: the
hook's own `error_message` reaches the caller verbatim behind the fixed prefix
`Tool execution was denied by an extension policy: `, with `kind: CONTEXT_DENIED` and the raw
message repeated in `developer_message`. Good for act 2 — "the hook writes the remediation
instruction" holds.

**Over MCP this is still untested**, and that is the half #6 actually needs: whether
`execution_id` and the typed kind survive the boundary or flatten to `isError` + text
determines whether panel correlation is exact or heuristic. Do not string-match the prefix
until it has been seen on the MCP wire. Pointer left on #6.
