# apps/hooks — the control plane

The service Arcade calls on every tool call. Owns `governance.db`, serves the three
contextual-access hooks, and records every decision it makes.

```
POST /access   which tools this user may see       → { deny: Toolkits }
POST /pre      may this user make this call         → { code: OK | CHECK_FAILED, error_message? }
POST /post     pass-through until #16               → { code: OK }
GET  /health   policy revision, row counts, 503 while failing closed   (no auth)
```

Every hook endpoint requires `Authorization: Bearer $ARCADE_HOOK_SIGNING_SECRET`. Request and
response bodies are the generated types in `@cg/policy-schema` — `deny` takes the request's
`Toolkits` shape down to the innermost array of versions, which spike #2 measured is the one
shape that does not take every tool in the project down with it.

```sh
bun run dev:hooks                       # :8081
bun run --cwd apps/hooks test
bun run --cwd apps/hooks bench          # latency, over HTTP, including the 1.6 MB /access
```

## The HTTP layer is thin

`server.ts` authenticates, parses, hands the payload to a handler in `handlers.ts`, appends the
audit rows, and responds. The handlers translate Arcade's payloads into `PolicyEngine`'s inputs
(`@cg/governance-core`, #7) and its `Decision` back into the wire response. Nothing in this
service decides who may do what; if an `if` about that appears here, it belongs in
`packages/governance-core`.

## `governance.db`

Five tables you can read at a glance, because one gets edited live on stage:

| table | what | edited on stage? |
|---|---|---|
| `subjects` | the cast — `user_id` (email), `display_name`, `role`, `clearance` | yes: `UPDATE subjects SET clearance = 100000 WHERE display_name = 'Dana Okafor'` |
| `catalogue` | every governed tool and the arguments a call must supply | rarely |
| `policy_rules` | `/access` and `/pre` rules, one row each; `enabled = 0` switches one off | yes |
| `output_rules` | `/post` redaction rules, stored now and evaluated from #16 | — |
| `grants` | narrow permissions produced by approvals, written from #10/#19 | — |
| `audit_log` | one row per decision, append-only | never |

Seeded from `src/fixtures/governance.json` **only when the database has no schema** (decided on
#29). On Render it sits on a disk at `/data/governance.db`, so a clearance raised in act 1 is
still raised in act 3 and after a restart. Resetting is `scripts/reset` (#23), never a redeploy.
The schema and the seed rows go in as one transaction, so a seed that fails leaves no schema and
the next boot retries — rather than a green service with an empty cast, permanently, on a disk
that persists.

Two things in the fixture are substituted at seed time and nowhere else: the toolkit names
(`$LOAN`, `$APPROVALS` → `ARCADE_LOAN_TOOLKIT`, `ARCADE_APPROVALS_TOOLKIT`) and the persona
emails (`PERSONA_<KEY>_EMAIL`, the same four variables `apps/idp` reads, so the two databases
cannot disagree about who a persona is). Tool names are PascalCase — `ApproveLoan`, not
`approve_loan` — because that is what `arcade-mcp` produces (measured, #35). A rule keyed on the
wrong string is refused at boot by `compilePolicy`; it does not silently match nothing.

## The policy is served from memory, and edits still reach it

`/access` is called with the entire project catalogue — ~1.6 MB — against a 5s fail-closed
timeout (spike #2). Reading the database per call does not survive that, and the failure does
not look like a policy problem: every tool in the project fails with *"tool access policy
service could not be reached"*. So `policy-cache.ts` holds the compiled policy and the subject
roster, loaded before the port opens, and **a hook call reads nothing from the database** — the
only SQLite work on the request path is appending the audit rows. A test counts queries on the
cache's handle across twenty warm `/access` and `/pre` calls and asserts zero.

Edits still reach it, and not by a clock on the cached data. Triggers bump a single integer,
`policy_revision`, on every write to `subjects`, `catalogue` or `policy_rules`; a background
poller reads that one row every `POLICY_POLL_MS` (default 250 ms) and reloads when it moved. An
edit from any connection — this process, a `sqlite3` shell on the disk, the rule editor — is live
within a quarter of a second, the reload is logged, and `/health` reports `policy.revision`,
`policy.loaded_at` and `policy.last_poll_at`, so "did my edit take?" has an answer other than
rerunning the prompt.

Three states, one of which serves policy:

- **cold** — `start()` has not run. Every hook fails closed. Boot warms the cache before the port
  opens so this is never served in practice; it exists so a server constructed without a warm
  cache *denies* rather than performing, on Arcade's first 1.6 MB request, the very database load
  the cache was built to avoid.
- **ready** — serving the policy at `revision`.
- **failed** — the last reload failed: a hand-edited row that no longer parses, a rule naming a
  tool the catalogue does not list. Every hook fails closed, `/health` returns 503 with the
  compiler's problem list, and the next edit triggers the next attempt. Not "keep serving the
  last good policy": that would be a policy edit silently not taking effect, which is the failure
  this design exists to prevent.

A *poll* that fails is not a *reload* that fails. A transient error reading one integer says
nothing about the policy in memory, so the cache keeps serving it and retries next tick; only
when the revision has been unreadable for 20 consecutive ticks (~5 s) does it fail closed, because
at that point it can no longer promise an edit would be noticed.

Measured (`bun run --cwd apps/hooks bench`, M-series laptop, in-memory database, one audit row
per tool decided):

| call | payload | audit rows | p50 | p95 |
|---|---:|---:|---:|---:|
| `/access`, whole-project catalogue (271 toolkits, 10,844 tools) | 1.5 MB | 10,844 | 159 ms | 197 ms |
| `/access`, scoped to `Loan` | <1 KB | 4 | 0.1 ms | 0.2 ms |
| `/pre`, denial with rendered remediation | <1 KB | 1 | 0.1 ms | 0.1 ms |

The whole-project call is dominated by the audit insert, ~10 µs a row. The engine itself and
the JSON are single-digit milliseconds.

## Fails closed, and the failure is audited

Anything that goes wrong between the request arriving and the response leaving — an unparseable
body, a payload that is not a hook payload, a throw in the engine, a policy that will not load or
has not loaded, the audit write itself, our own budget — produces a denial and audit rows with
`rule_id: null` and a reason starting `FAIL-CLOSED:`, one per tool the request named where the
payload was readable. `/pre` and `/post` get a well-formed `CHECK_FAILED`; `/access` gets a `deny`
map covering everything the request named, or a 5xx when even that could not be read, which
Arcade's `failure_mode: fail_closed` (set on the extension, #13) turns into a denial.

`HOOK_DEADLINE_MS` (default 2500) is a budget inside Arcade's 5 s, checked at every stage
boundary: after the body is read (the one asynchronous step, raced against a timer), after the
policy is evaluated, and before the audit rows are written. JavaScript cannot interrupt
synchronous work, so a slow evaluation runs to completion — but its result is then discarded,
the call is denied, and the row says `Timeout`. What never happens is an allow returned after
Arcade has given up, or an allow recorded for a call that was in fact refused. Tested with a
cache that blocks for longer than the budget.

A user the roster does not know, a toolkit the catalogue does not govern, a tool name in the
wrong case, a call missing a required argument: all denied by the engine, all audited.

## The correlation token (#6)

Over MCP a denial reaches the agent as text with no execution id. The one thing that crosses
verbatim is the `error_message` this service writes, so the audit row's id rides at the end of
it, in brackets:

```
DENIED: approving LN-2291 for 95000 exceeds your approval authority of 50000. To proceed,
call Approvals.RequestApproval with … then retry Loan.ApproveLoan … unchanged. [ref evt_4k7xq2m9hz]
```

`correlation.ts` exports `CORRELATION_TOKEN` and `correlationId()`; the panel (#21) parses the
id back out and joins on `audit_log.id`. It must fail soft — a message without a token is an
uncorrelated event, never a dropped one — because the prefix Arcade puts ahead of our text is
theirs and undocumented. Allows carry `execution_id` on the hook payload and need no token.

## What the audit log is, and is not

`audit_log` is every decision *this service* made — one row per tool at `/access` (allowed or
hidden, governed toolkit or not), one per call at `/pre` and `/post`, and one per tool on every
fail-closed path where the request could be read. A whole-project `/access` is thousands of
rows; that is the price of a table from which a reviewer can reconstruct every decision with
its acting user, tool, effect, reason and `rule_id`, and the bench prices it. Append-only,
enforced by triggers, not convention.

It is **not** a complete record of every refusal a persona met. Arcade evaluates a tool's auth
requirements *before* `/pre`: a persona without a token for a tool is refused upstream of every
hook and leaves no row here (measured, spike #2; `DESIGN.md` open risk 2). Nothing in this
schema or on the panel should imply otherwise.

## Not here

- `RedactionEngine` at `/post` — #16. `/post` returns `OK` and records a pass-through.
- Grants at `/pre` — `GrantChecker` (#10) has not landed and the engine only accepts grants
  that have been through it. Until then a denial stands even after an approval.
- SSE fan-out — #20. The audit write is the seam.
- Reset — #23.
