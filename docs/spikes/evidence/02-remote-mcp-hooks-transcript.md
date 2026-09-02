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

