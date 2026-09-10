# apps/web — the demo UI

Next.js. Eventually the split screen: a deliberately boring enterprise loan app on the
left, the Arcade control plane on the right (#22). Today it carries the control-plane
panel (#21) and the scaffold's placeholder home page.

```sh
PORT=4420 bun run --cwd apps/web dev     # then open /panel
bun test apps/web
bun run --cwd apps/web build
```

⚠️ `bun run dev:web` binds **3000**, not the `PORT` in this directory's `.env.local`.
`next dev --port ${PORT:-3000}` is expanded by the shell, which never reads that file —
unlike the three Bun services, where the runtime loads it. Pass `PORT` explicitly until
[#50](https://github.com/ArcadeAI/mastra-contextual-governance/issues/50) is fixed.

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
