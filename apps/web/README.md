# apps/web — the demo UI

Next.js. Eventually the split screen: a deliberately boring enterprise loan app on the
left, the Arcade control plane on the right (#22). Today it carries the control-plane
panel (#21), the approval page (#19), and the scaffold's placeholder home page.

```sh
bun run --cwd apps/web dev               # then open /panel or /approvals/<id>
bun test apps/web
bun run --cwd apps/web build
```

`PORT` comes from this directory's own `.env.local`, the way it does for the three Bun
services: `dev` and `start` go through `scripts/next.ts`, which is a process Bun runs
directly so the file is loaded before Next starts ([#50](https://github.com/ArcadeAI/mastra-contextual-governance/issues/50),
fixed in #55). A real environment variable still wins, which is what
`PORT=4420 bun run --cwd apps/web dev` and Render's injected `PORT` rely on.

## The control-plane panel

`/panel` renders it full-screen. `<ControlPlanePanel>` is the component #22 drops into
the right half; it renders no `<html>` or `<body>` of its own.

Three lanes — Access, Pre, Post — fed by a `text/event-stream` of `GovernanceEvent`s
(#5). Green allow, red deny with the rule that fired, amber modify with a before/after
diff. Newest at the top of each lane, so the freshest card never moves.

### Which stream it watches

Read in the **server** component and passed down as a prop. Never a `NEXT_PUBLIC_`
variable — `.env.example` explains why at length: `next build` inlines those into the
client bundle while Render supplies service variables at runtime, so one would be
`undefined` in the deployed browser and perfectly fine under `next dev`.

| `GOVERNANCE_STREAM` | Stream |
|---|---|
| unset (default) | `/api/governance/fixture-stream` — this app, replaying #5's fixture sequence |
| `hooks` | `http(s)://$HOOKS_PUBLIC_HOST/events` |

**Fixture is the default deliberately.** `apps/hooks` does not serve `/events` yet —
that is #20 — so defaulting to it would open the panel on a connection that cannot
succeed, which reads as a broken app rather than an unfinished one. When #20 lands,
flip the default.

The panel labels which mode it is in. A rehearsal must not mistake a replay for the
live control plane.

### Watching it absorb a burst

A whole-project `/access` decides 10,844 tools in one call, so "handles a burst" is not
hypothetical. In fixture mode the page's own query string tunes the replay:

```
/panel?repeat=2000&delayMs=0     # 10,000 events, as fast as the socket carries them
/panel?delayMs=300               # the four acts, faster than the default 900ms pacing
```

Lanes are bounded **separately** — one shared window would let an `/access` sweep evict
the `/pre` denial act 2 turns on — and every event past a lane's window is counted in
that lane's header rather than discarded. An audit surface that quietly drops records
argues against the thing this project argues for.

### What it will not show you

Two limits, both deliberate.

**A removed value is never rendered.** `before` is replaced by a mask built from the
value's type and nothing else — not truncated, not partially shown, not hashed. The
panel is the one surface guaranteed to be on a projector; act 3's whole point is that a
bank account number did not reach the model, and printing it here would be worse than
having no diff. `after` *is* shown, because that is what the model received.

The mask says `text withheld` on a hatched field rather than drawing a row of dots. A
design review found the dots read, at projector distance, as a value in a masked font
rather than as the absence of one — and the phrasing leaks strictly less, since the dots
were length-proportional and these are not. `maskedDiff()` has an `annotation` slot
ready for `redactions[]` chips; #8 has landed the `RedactionRecord` type but
`GovernanceEvent` does not carry an array of them yet, so nothing populates it.

**A layer-2 refusal never reaches this panel, and an empty lane is not proof that
nothing was tried.** Arcade evaluates a tool's auth requirements *before* `/pre`, so a
persona without a token for a tool is refused upstream of every hook: no `/pre` event,
no audit row, nothing on screen (measured, spike #2; `DESIGN.md` open risk 2). Every
decision the access, pre and post hooks made is on the panel. That is not the same as
every refusal the persona met, and no beat that needs to be *seen* should be staged as
an auth failure.

This caveat used to be a paragraph in the panel's bottom-left corner. Design review cut
it, fairly: nobody at the back of a room reads a footnote, and the space it took
belonged to the lanes. It is true, it matters, and it belongs in the runbook rather than
on the projector.

### Correlation

`lib/governance/correlation.ts`, one `correlate()` over two keys — the swappable seam
the issue asks for. Denials carry the token `apps/hooks` embeds in the `error_message`
it owns (`[ref evt_…]`, #6); allows carry `execution_id` on the payload. It fails soft
in every direction: a message with no parseable token is an *uncorrelated* event,
rendered in its lane without a join, never dropped. The prefix Arcade puts ahead of our
text is theirs and undocumented, and a panel that went blank because Arcade edited a
string would be a bad thing to discover on stage.

### Why not `EventSource`

It cannot set a request header, so it cannot resume with `Last-Event-ID`, and its
reconnect timing is the browser's rather than ours — on stage that is an outage of
unpredictable length in the middle of an act. `fetch` over a `ReadableStream` gives both
back, and makes the whole path testable against a real server instead of a stub.

`lib/governance/subscribe.ts` is the only file that knows the wire contract, so when #20
settles the endpoint, one file changes.

## Fonts

GT Cinetype and GT Cinetype Mono are Arcade's licensed faces and are **not committed** —
this is a template anyone can fork. The stack names them first, because they are
installed on the machine that presents this, and falls back to the brand kit's own
documented websafe fallback everywhere else.

## `/approvals/{id}` — the approval page

The page the Slack DM links to. It is built on **one** read, `GET /approvals/{id}` on
`apps/hooks`, because the link carries an opaque id and nothing else: no token, no
signature, no query string. That response carries everything the page shows — who asked,
what for, how much, which rule was tripped, why, who it was routed to, and who was
sufficient and deliberately not asked.

**Opening the page is not permission.** The requester can read the DM she sent, so she can
open the link too, and the read answers her exactly as it answers the approver. Whether the
person looking may *decide* is settled when a button is pressed.

### Pressing a button is a governed tool call

Approve and Deny both call `Approvals.Decide` **through Arcade, as the clicking user**, so
the press passes `/access`, the auth requirements, `/pre` and `/post` like any other tool
call. There is deliberately no second path: `apps/web` never writes to `governance.db`, never
calls the approvals store to record a decision, and has no branch that records one when
Arcade refuses. A privileged path that made the demo work would also make it false.

Three outcomes, and they stay three:

| | what it means | what the page shows |
|---|---|---|
| recorded | the tool ran | the decision, and the details above update |
| refused | `/pre` said no | `CHECK_FAILED`, the hook's own message verbatim, and "the request is unchanged" |
| failed | Arcade unreachable, misconfigured, unexpected | "no control has spoken" |

Collapsing a failure into a refusal would make an outage look like a control firing. That is
the comfortable direction to get it wrong, and it is still wrong.

The refusal is styled as a deliberate screen rather than an error page, because it is a beat:
Dana clicking her own link sees the same `CHECK_FAILED` her agent saw, and there is an audit
row for it against her identity.

### Acting as

`lib/persona.ts` is the persona switcher, standing in for real login exactly as `DESIGN.md`
says: each persona is a real Arcade account with a real email, and the switcher chooses which
of them the tool call is made under. It defaults to the routed approver, so the link works
straight from Slack, and ignores a cookie naming somebody the control plane has never heard
of. It is not a permission — choosing the requester and pressing Approve is the beat, not a
hole.

### Configuration

`lib/config.ts` is the only place this service reads its environment, and
`APPROVALS_STORE_TOKEN` is the one variable it will not invent. Unset outside
production it takes the same development fallback `apps/hooks` takes, so a clean
checkout runs with no configuration at all; unset **under
`NODE_ENV=production` it throws**, with the same wording the control plane uses:

```
APPROVALS_STORE_TOKEN is required in production
```

That fallback is written out in the source, so a production service using it
would be authenticating to the approvals store with a value anyone can read —
and doing it quietly, because the fallback works locally. `test/config.test.ts`
pins both halves of the guard on both sides, and CI hands the token to the
`build web image` smoke the same way it hands it to `build hooks image`.

`/health` deliberately does not read configuration, so it answers `200` either
way; the guard fires on the first request that needs the token, which is any
view of an approval.

### Unverified

`lib/arcade.ts` has never spoken to `api.arcade.dev`: #13 registers the gateway and the
provider. The tests drive the real pre-hook through a stand-in that calls it the way the
engine does and runs the tool only on `OK`, so the refusals under test are produced by the
actual policy — but the live round trip is not evidence this slice can offer.
