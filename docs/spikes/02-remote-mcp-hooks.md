# Spike 02 — Do contextual-access hooks fire for Remote MCP server tools?

**Answer: yes.** All three hooks — `/access`, `/pre`, `/post` — fire for tools served by a
Remote MCP server registered in Arcade, with a payload identical in shape to the one hosted
toolkits produce. `DESIGN.md`'s architecture holds: `apps/loan-mcp` can be an external Bun
service.

Resolves [#2](https://github.com/ArcadeAI/mastra-contextual-governance/issues/2).
Clears open risk 1 in `DESIGN.md`.

> **Read [Confidence](#confidence-what-is-established-and-what-is-not) before acting on any
> specific string in this document.** The answer above is the finding. Two of the details
> below — the toolkit-name normalisation and the failure-mode default — are the parts you
> must confirm against your own deployment rather than take from here.

## How this was answered

Verified internally against Arcade's engine behaviour. That implementation is not public, so
this document records **what the platform does**, without citations or internal identifiers.

That is a real weakness and it is worth naming rather than glossing: an unattributable answer
cannot be checked by a second person. The fallback #2 specified — register a trivial remote
server, attach a deny-all pre-hook, call through a gateway — was **not** run, and it should
be. See [Outstanding](#outstanding-the-experiment-that-closes-this-out) for the exact
procedure and what it needs.

Where a claim below is also covered by Arcade's public documentation, it is cited. What is
left uncited is what only the internal check vouches for, and that is deliberate — it is the
set of things to be careful with.

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

This is a description of the execution path, not an observation of a denial. It is the part
the experiment below exists to convert into evidence.

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

**No field identifies the tool's origin.** A hook server cannot tell a remote MCP tool from a
hosted-toolkit tool by payload alone; it must derive that from `tool.toolkit`. That is what
makes the naming rules below load-bearing rather than cosmetic — and what makes getting them
wrong silent.

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

### This contradicts Arcade's published example. Reconciling it.

The [third-party-MCP announcement](https://www.arcade.dev/blog/bring-third-party-mcp-server-to-arcade/)
says you reference a remote tool as `render-mcp-server.get_key_value`. Run `render-mcp-server`
through the rule above and you get `Render.get_key_value`. Both cannot be right.

The rule above describes the **resolved** tool name — what lands in `tool.toolkit` on a hook
payload. The blog is describing the server you registered. Three observations, all checkable
without any internal access, say the blog example is prose about registration rather than a
literal resolved name:

1. **Registered identifier and resolved prefix are demonstrably different strings.** In the
   Arcade gateways attached to this workstation, gateway slug `arcade-x` fronts tools named
   `X_PostTweet` / `X_LookupTweetById`, and gateway slug `youtubetools` fronts
   `YoutubeTools_GetMyChannel`. The lowercase hyphenated registered identifier appears nowhere
   in the resolved names; a PascalCase alphanumeric one does.
2. **Every toolkit name Arcade exposes anywhere is alphanumeric PascalCase** — `Gmail`,
   `GoogleCalendar`, `Slack`, `Github`, `X`, `YoutubeTools`. `render-mcp-server` is not
   well-formed under that scheme, and neither is `granola-1p` from the same docs page
   (`Granola1P` would be).
3. Under the blog's reading, a fully-qualified name would contain the `.` separator *and*
   hyphens from the slug, which no Arcade tool name does.

That is corroboration for the **shape** of the claim — the prefix is a normalised name, not
the registered ID. It is **not** proof of the exact normalisation, in particular the
`mcp`/`server` substring strip. That specific step rests on the internal check alone.

### Before you write a policy rule: read the toolkit name off the wire

Whatever this document or the vendor's blog says, #12 and #13 must not hardcode a toolkit
string from either. After registering `loan-mcp`, log one real `/pre` payload and read
`tool.toolkit` out of it:

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
silently, which is the precise failure the demo exists to disprove. This step costs five
minutes and is correct whether or not the normalisation above is.

## Timeouts

- default hook timeout **5s**, configurable per extension and overridable per hook — public,
  per [Build your own](https://docs.arcade.dev/en/guides/contextual-access/build-your-own).
- retry is optional and off unless enabled; only transient failures (5xx, timeout, connection
  error) are retried, 4xx is not — also public, same page.
- response caching is off by default.
- `timeout_ms` accepted range: I recorded 100ms–120s, with some hook create/patch paths
  capping at 30s. **Treat that range as unverified.** Set `timeout_ms` explicitly and confirm
  the value is accepted, rather than relying on a bound from this document.

## Failure mode: set it explicitly, do not inherit it

I recorded the default as fail-closed. Arcade's published docs
([how hooks work](https://docs.arcade.dev/en/operate/governance/contextual-access/how-hooks-work),
[build your own](https://docs.arcade.dev/en/guides/contextual-access/build-your-own)) present
failure mode as a per-hook-configuration choice and **state no default**, and I did not
re-verify the dashboard's default. Treat the default as unknown.

**Set failure mode explicitly to fail-closed on every hook configuration in #13.** If it were
to default to fail-open, a hook server that GCs for six seconds past a 5s timeout would let
act 1 and act 2 both fail *open* on stage — Sam sees `approve_loan`, Dana's $95K goes through
— and a governance demo would quietly stop governing.

Fail-closed is the right setting for this demo's thesis, and it carries a consequence worth
designing for: a hook server that is down or slow blocks every governed tool call, including
`loan-app`'s read-only ones. That makes `apps/hooks` a hard dependency of the stage demo
rather than a side-car — it needs a real health check and a rehearsal failure drill.

## Confidence: what is established and what is not

| Claim | Status |
|---|---|
| Hook payload shapes, response codes, 5s default, retry semantics | **Public**, cited above, independently checkable |
| Resolved tool prefix is a normalised PascalCase name, not the registered server ID | **Corroborated** by observable gateway naming, above |
| `/access`, `/pre`, `/post` fire for remote MCP server tools | **Internal check only.** Not reproduced. The experiment below closes it |
| `mcp`/`server` stripped as substrings; `loan-mcp` → `Loan` | **Internal check only.** Contradicts a published example; treat as unconfirmed and read the value off the wire |
| Failure-mode default is fail-closed | **Unverified.** Set it explicitly |
| `timeout_ms` bounds 100ms–120s / 30s cap | **Unverified.** Set explicitly and confirm |
| Denial flattens to `isError` + prefixed text over MCP | **Internal check only.** See below |

## Outstanding: the experiment that closes this out

Not run, and it should be before #14 depends on it. It is roughly an hour:

1. One HTTP service exposing **both** a Streamable-HTTP MCP server with a single trivial tool
   **and** `/access` `/pre` `/post`. One process, one public URL, one tunnel.
2. The hook logs every inbound request verbatim, returns `OK` for everything, and
   `CHECK_FAILED` **only** for its own test tool. Scoped that narrowly it proves the hooks
   fire while keeping the blast radius off every other tool in the project — which matters,
   because a fail-closed deny-all bound at project scope takes down every tool call in it.
3. Register the server, attach the extension, call the tool through a gateway.
4. Paste the hook's inbound log. It settles all of it at once: that the hooks fire for a
   remote MCP tool, the literal `tool.toolkit` string, the payload shape, and the denial's
   wire form.

**What it needs:** working Arcade admin credentials. Every credential on this workstation is
stale — the CLI's refresh token 400s against `auth.arcade.dev/oauth2/token`, and the prod,
demos and staging API keys all return 401 from `api.arcade.dev`. A fresh `arcade login` or a
current API key unblocks it. Running it against a staging project rather than a production one
would be better still.

## Incidental, outside this slice

**What survives a denial over MCP** (`DESIGN.md` risk 2, owned by #6). It flattens, as
suspected: the agent receives a tool result with `isError: true` whose text is the hook's own
`error_message` behind a fixed prefix, `Tool execution was denied by an extension policy:`.
Good for act 2 — the remediation text reaches the model verbatim, so "the hook writes the
remediation instruction" survives. Bad for the panel — `execution_id` and the typed error kind
do not cross the MCP boundary, so correlation over MCP will be heuristic.

Same provenance caveat as the rest: internal check, not reproduced. **#6 should not
string-match on that prefix without confirming it on the wire first.** Pointer left on #6.
