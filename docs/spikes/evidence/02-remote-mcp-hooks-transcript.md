# Spike 02 — experiment transcript

Run 2026-09-02 against a throwaway project in the Arcade prod org, created for this test.

The probe is one process serving both a Streamable-HTTP MCP server and the three hook
endpoints, so a single public URL covers everything.

## Setup

| | |
|---|---|
| Registered remote MCP server ID | `spike-02-probe` |
| Probe's own `serverInfo.name` | `loan-mcp-server` |
| Probe's `serverInfo.version` | `1.0.0` |
| Tool exposed | `ping_probe` |

The three names are deliberately distinct so the resolved toolkit discriminates between
the competing naming rules: the registered ID (`spike-02-probe`), naive passthrough
(`loan-mcp-server`), or the normalisation this spike documents (`Loan`).

## 1. Toolkit resolution

`GET /v1/workers/spike-02-probe/tools`

```json
{
  "name": "ping_probe",
  "toolkit": {
    "name": "Loan",
    "description": "Spike 02 probe server.",
    "version": "1.0.0"
  },
  "fully_qualified_name": "Loan.ping_probe@1.0.0"
}
```

**Result: `Loan.ping_probe@1.0.0`.** Not the registered ID, not passthrough. `mcp` and
`server` are stripped as substrings from `loan-mcp-server`, leaving `loan`, PascalCased
to `Loan`. The toolkit `description` is carried from the MCP server's `instructions`,
and `version` from `serverInfo.version`.

## 2. Allow pass — all three hooks fire

Hook sequence observed by the probe: **ACCESS → PRE → MCP tools/call REACHED SERVER → POST**

### ACCESS

```json
{
  "toolkits": {
    "Loan": {
      "tools": {
        "ping_probe": [
          {
            "version": "1.0.0"
          }
        ]
      }
    }
  },
  "user_id": "mateo@arcade.dev"
}
```

### PRE

```json
{
  "context": {
    "authorization": [
      {}
    ],
    "user_id": "mateo@arcade.dev"
  },
  "execution_id": "tc_3Imptd2CPi796zhzuH9rKQkZODJ",
  "inputs": {
    "note": "hello-from-spike-02"
  },
  "tool": {
    "name": "ping_probe",
    "toolkit": "Loan",
    "version": "1.0.0"
  }
}
```

### MCP tools/call REACHED SERVER

```json
{
  "name": "ping_probe",
  "arguments": {
    "note": "hello-from-spike-02"
  },
  "_meta": {
    "arcade_context": {
      "authorization": {},
      "user_id": "mateo@arcade.dev"
    }
  }
}
```

### POST

```json
{
  "context": {
    "authorization": [
      {}
    ],
    "user_id": "mateo@arcade.dev"
  },
  "execution_id": "tc_3Imptd2CPi796zhzuH9rKQkZODJ",
  "inputs": {
    "note": "hello-from-spike-02"
  },
  "output": {
    "echoed": "hello-from-spike-02",
    "marker": "PROBE_REACHED_BACKEND"
  },
  "success": true,
  "tool": {
    "name": "ping_probe",
    "toolkit": "Loan",
    "version": "1.0.0"
  }
}
```

Execution result:

```json
{
  "id": "te_3ImptfH8D6Z67yu5CS92zygG4Nz",
  "execution_id": "tc_3Imptd2CPi796zhzuH9rKQkZODJ",
  "execution_type": "immediate",
  "finished_at": "2026-09-02T20:10:14Z",
  "duration": 145.147428,
  "status": "completed",
  "output": {
    "value": {
      "echoed": "hello-from-spike-02",
      "marker": "PROBE_REACHED_BACKEND"
    }
  },
  "success": true
}
```

Notes:

- `/access` enumerates the remote server's tools under the resolved toolkit key `Loan`.
- `execution_id` is identical on `/pre` and `/post` (`tc_3Imptd2CPi796zhzuH9rKQkZODJ`), so the two correlate exactly on the SDK path.
- **No field identifies the tool's origin.** No `servers`, no `headers`. A hook server
  cannot tell this from a hosted toolkit except by `tool.toolkit`.
- The engine passes caller identity to the MCP server out-of-band in `_meta.arcade_context`.

## 3. Deny pass — pre-hook blocks before the backend is reached

Same call, probe flipped to deny for its own tool only.

Hook sequence: **ACCESS → PRE**  — the backend was never reached, and `/post` never ran.

Execution result:

```json
{
  "id": "te_3ImptuuQVoF4oRQ3BvfQE9Uu8N9",
  "execution_id": "",
  "execution_type": "immediate",
  "finished_at": "0001-01-01T00:00:00Z",
  "duration": 0,
  "status": "failed",
  "output": {
    "error": {
      "message": "Tool execution was denied by an extension policy: SPIKE02_DENIED_BY_PRE_HOOK. If you can read this string, the pre-hook fired for a remote MCP server tool and its message reached the model.",
      "kind": "CONTEXT_DENIED",
      "can_retry": false,
      "developer_message": "SPIKE02_DENIED_BY_PRE_HOOK. If you can read this string, the pre-hook fired for a remote MCP server tool and its message reached the model."
    }
  },
  "success": false
}
```

The hook's own `error_message` reaches the caller verbatim behind a fixed prefix
(`Tool execution was denied by an extension policy: `), with `kind: CONTEXT_DENIED`
and the raw message repeated in `developer_message`.

## 4. Hook configuration defaults

Creating the webhook plugin without `failure_mode` is rejected:

```
400 malformed_request
webhook_config.endpoints.access: failure_mode is a required field
```

**There is no default failure mode — the API requires the caller to state it.** 
Stored configuration as created:

| hook point | status | phase | failure_mode | timeout_ms |
|---|---|---|---|---|
| `tool.access` | active | before | `fail_closed` | 5000 |
| `tool.pre` | active | before | `fail_closed` | 5000 |
| `tool.post` | active | after | `fail_closed` | 5000 |

Two things worth noting:

- `timeout_ms` was sent as `10000` on each **endpoint** and stored there, but each **hook**
  recorded `5000`. They are separate fields; the hook-level one fell back to the 5s default.
  Set the hook-level value explicitly if 5s is not what you want.
- Retry as stored: `enabled: false`, 3 attempts, exponential from 100ms, on 5xx / timeout /
  connection_error — matching the published documentation.

- The plugin is created `status: inactive` and must be PATCHed to `active` before any hook fires.


---

# Part 2 — over an MCP gateway

Gateway: `https://api.arcade.dev/mcp/gw_3ImsCcArZvgO537KghywE0nWIF8`, API-key audience,
exposing `Loan.ping_probe`. This is the path Mastra's `MCPClient` will use.

Two required headers beyond the bearer token: **`Arcade-User-Id`** (a request without it
is rejected `401 Missing Arcade-User-Id header`) and the usual `Mcp-Session-Id` after
`initialize`.

## 5. Wire name over MCP

`tools/list` returns:

```
Arcade_ListApps
Loan_ping_probe
```

Confirms the `_` separator form: `Toolkit_tool_name`. The gateway's own `serverInfo.name`
is its slug, `gw_3ImsCcArZvgO537KghywE0nWIF8`, with `title: loan-test`.

## 6. Allow pass over MCP

Hook sequence: **ACCESS → ACCESS → PRE → backend reached → POST**. Result:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"echoed\":\"over-the-gateway\",\"marker\":\"PROBE_REACHED_BACKEND\"}"
    }
  ],
  "structuredContent": {
    "echoed": "over-the-gateway",
    "marker": "PROBE_REACHED_BACKEND"
  }
}
```

## 7. Deny pass over MCP — this is the answer #6 needs

Hook sequence: **ACCESS → ACCESS → PRE**, backend never reached. The client receives:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "isError": true,
    "content": [
      {
        "type": "text",
        "text": "Tool execution was denied by an extension policy: SPIKE02_DENIED_BY_PRE_HOOK. If you can read this string, the pre-hook fired for a remote MCP server tool and its message reached the model."
      }
    ]
  }
}
```

The hook itself saw `execution_id = tc_3ImsQm7QawPEv3eaksCjfiUuyDF` on its `/pre` payload.
**None of that crosses the boundary.** Over MCP a denial is `isError: true` plus text —
no `execution_id`, no typed error kind, no `structuredContent`. Compare the SDK path,
which returns `kind: CONTEXT_DENIED` and a `developer_message`.

The hook's `error_message` does survive verbatim behind the fixed prefix
`Tool execution was denied by an extension policy: `.

**Consequence for the control-plane panel: correlation over MCP cannot be exact.** There is
no execution identifier in the client-visible payload to join on.

## 8. Access hook filtering — act 1's mechanic

With `/access` returning a deny list for `Loan.ping_probe`, `tools/list` over the gateway
returns only `Arcade_ListApps`. The tool is gone.

Calling it anyway by its wire name, to check the hiding is not merely cosmetic:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "error": {
    "code": -32602,
    "message": "tool not found",
    "data": {
      "internal_error": "failed to get tool loan.ping_probe@0: tool definition not found",
      "name": "Loan_ping_probe"
    }
  }
}
```

The backend was never reached — only ACCESS hooks fired, no `/pre`, no `tools/call`.
So the tool is both invisible and uncallable. Act 1 works over MCP.

## 9. Two operational findings

**The `/access` response shape is under-documented and fails closed when wrong.** `deny`
and `only` both take the same `Toolkits` shape as the request, so the innermost value is an
*array* of version objects:

```json
{ "deny": { "Loan": { "tools": { "ping_probe": [{ "version": "1.0.0" }] } } } }
```

Returning `{}` for that inner value instead produced this, on every tool in the project:

```
-32603 Your organization's tool access policy service could not be reached, so access
to this tool could not be verified.
```

A malformed hook response is indistinguishable from an unreachable hook server, and
fail-closed then blocks everything. The published guide documents `only`/`deny` as
"object" without an example; the canonical shape is in the public schema at
`ArcadeAI/schemas`, `logic_extensions/http/1.0/schema.yaml`.

**The access hook is called repeatedly, and at least once with the entire tool catalog.**
A single `tools/list` produced four `/access` calls, one scoped to `Loan` and one
enumerating every toolkit in the project (thousands of tools, ~1.6 MB). With a 5s
fail-closed timeout, `apps/hooks` must answer that quickly or every call in the project
fails. Do not do per-request I/O in the access hook without caching.

