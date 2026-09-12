# apps/web — the demo UI

Next.js. Eventually the split screen: a deliberately boring enterprise loan app on the
left, the Arcade control plane on the right (#22). Today it carries the identity
(#82), the control-plane panel (#21), the approval page (#19), and the scaffold's
placeholder home page.

```sh
bun run --cwd apps/web dev               # then open /panel or /approvals/<id>
bun test apps/web
bun run --cwd apps/web build
```

`PORT` comes from this directory's own `.env.local`, the way it does for the three Bun
services: `dev` and `start` go through `scripts/next.ts`, which is a process Bun runs
directly so the file is loaded before Next starts ([#50](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/50),
fixed in #55). A real environment variable still wins, which is what
`PORT=4420 bun run --cwd apps/web dev` and Render's injected `PORT` rely on.

## Identity — sign in, the gateway token, the verifier route

`DESIGN.md` → **Identity** and **Identity and OAuth**. There are two authentication
hops with two different mechanisms, and this service owns its side of both. Nothing
here is the agent; #14 puts the agent on top.

```
Dana, in her own Chrome profile
  → "Sign in as Dana"        GET /api/auth/signin?persona=dana
      OIDC code + PKCE against apps/idp as client C, prompt=login
    → cg-idp's login page, cg-idp's consent page
  → GET /api/auth/callback   code → token → /oauth2/userinfo → email
      sealed cookie { email }
  → hop 1                    GET /api/arcade/start
      401 on the gateway → resource metadata → authorization-server metadata
      → dynamic client registration → PKCE authorize → Arcade's consent screen
  → GET /api/arcade/callback sealed cookie { email, gateway access + refresh }
  ─── later, on the persona's FIRST tool authorization ───
  → hop 2                    GET /api/arcade/verify?flow_id=…
      email from the sealed session, never from the request
      → POST cloud.arcade.dev/api/v1/oauth/confirm_user   (server-side)
      → fetch next_uri                                     (server-side)
      → send the browser on
```

Five route handlers, and they are the whole of it:

| route | what it does |
|---|---|
| `GET /api/auth/signin` | starts sign-in at cg-idp as client C, `prompt=login` |
| `GET /api/auth/callback` | makes the session; completes a parked verification if there is one |
| `GET /api/arcade/start` | begins the gateway authorization for the signed-in persona |
| `GET /api/arcade/callback` | stores the gateway access + refresh token on the session |
| `GET /api/arcade/verify` | Arcade's custom user verifier |
| `POST /api/auth/signout` | forgets the persona and the gateway token together |

Each `app/api/**/route.ts` is a wrapper around a plain `(Request) => Promise<Response>`
in `lib/identity/handlers.ts`. That is what lets `test/identity-flow.test.ts` mount the
same functions behind a real `Bun.serve` and drive them with a cookie jar over real
HTTP, against a real `apps/idp` subprocess — so the suite asserts on the `Set-Cookie`
headers a browser would actually receive rather than on a mock's arguments.

### One sealed cookie, one persona per browser

No fourth database. The persona's email and the gateway access + refresh token live in
one cookie, **AES-256-GCM under `SESSION_SECRET`**, `HttpOnly; Secure; SameSite=Lax`,
chunked across `cg_session.0`, `cg_session.1`, … when it exceeds what a browser will
hold. Two JWTs and an email exceed 4KB comfortably, so chunking is the normal case; a
browser handed an oversized `Set-Cookie` drops it in silence, and the symptom is a
sign-in that appears to work and then forgets.

Encrypted rather than merely signed, because the value is a bearer token for the whole
gateway and a signed-but-readable cookie would put it in the persona's own DevTools.
There is no development fallback key, and a weak one is refused as firmly as an
absent one: `SESSION_SECRET` must be **at least 32 characters with at least 8 distinct
ones**, or `/health` reports all three capabilities `missing` and every identity route
answers `503` naming the minimum. 32 because the derived key is 256 bits and SHA-256
does not add entropy — a shorter secret is the part an attacker has to guess; the
distinct-character floor because length alone is satisfiable by padding.

That is not hypothetical tidiness. Round 1 of #84's review set `SESSION_SECRET=x`,
and the built service reached `Ready`, `/health` said `configured` three times, and
every sign-in worked — under a key anybody could guess, protecting two bearer tokens.
A refusal that fires only on an *absent* value misses the case a human produces.
`lib/identity/seal.ts::sessionSecretProblem` is the single definition, used by the
key derivation, by `/health` and by every route, so the three cannot disagree.

One persona per browser is a design, not a limitation — on stage each persona runs in
its own Chrome profile. Spike #75 named the trap: a verifier that reads a
browser-keyed session while four personas share one browser binds every tool call to
whoever signed in last.

### Switching persona forces a fresh login, and that is measured

`prompt=login` rides on **every** sign-in, not only on a detected switch: a switch that
has to be detected is a switch that can be missed, and being wrong costs every tool
call for the rest of the demo being made as the wrong person while the screen says
otherwise.

Measured against a real `apps/idp`, two sign-ins in one browser:

```
                              with prompt=login          without
after "Sign in as Dana"   dana.okafor@bank.example   dana.okafor@bank.example
after "Sign in as Sam"    sam.reyes@bank.example     dana.okafor@bank.example
pages shown by the switch                        2                          0
```

Without it the second authorization continues off the IdP session the first one left
behind, renders nothing, and the browser comes back as Dana.
`test/identity-flow.test.ts` pins both halves.

### The verifier never reads identity from the request

Arcade sends a verifier **exactly one** parameter, `flow_id` — measured on #75 by
recording the whole query string rather than reading the field we expected. So the
email comes from this browser's sealed session and from nowhere else, and a request
carrying `user_id`, `email`, `sub` or `login_hint` is refused with `400` rather than
quietly served. Ignoring them would be correct too; refusing them is testable from
outside.

Two measured facts shape the rest of it:

- **`confirm_user` is called server-side with `ARCADE_API_KEY`, in-flow.** Run by hand
  it is unreliable: Arcade accepts it only while the flow is still awaiting
  verification, and that window is shorter than a human's turnaround — the same call
  succeeded once at ~8 minutes and returned a bare `{"code":400,"msg":"Bad request"}`
  the next time, for a flow Arcade still recognised.
- **`next_uri` is fetched server-side.** Arcade does not finalise the grant until
  something lands there. A verifier that returns the 303 and trusts the browser to
  follow it is correct for a browser and wrong for everything else.

A `confirm_user` non-2xx or a `user_mismatch` renders a page carrying Arcade's own
words and says plainly that nothing was authorized. Nothing fails quietly.

**No session is the expected case**, on every fresh Chrome profile. The flow id is
parked in a sealed, ten-minute cookie, the browser is sent to sign in, and the same two
calls run from the sign-in callback. A parked flow that expires renders a page saying
so and what to do — it is never dropped in silence.

### Configuration, and what `/health` says

```
curl -s localhost:3000/health
{"status":"ok","service":"web","signin":"configured","gateway":"configured","verifier":"configured","panel_stream":"fixture"}
```

Four capabilities rather than one flag, because they fail independently and the person
reading this is trying to find out which step is outstanding.

`panel_stream` is the odd one out and has three values, not two: `live`, `fixture` or
`unconfigured`. A replay somebody asked for is a mode, not a fault — the panel says
`FIXTURE REPLAY` on screen — while `unconfigured` means the panel is watching nothing.
See [Which stream it watches](#which-stream-it-watches) and #81.

**`status` is `degraded` whenever any capability is `missing` or the panel is
`unconfigured`, and the response is still HTTP 200.** Round 2 of #84's review ran a
cg-web with sign-in configured and `ARCADE_GATEWAY_ID` absent and got `{"status":"ok", … "gateway":"missing"}` — the
field anybody actually reads, describing a deployment that could not make a tool call
as fine. The status line stays 200 on purpose: Render treats a non-200 on
`healthCheckPath` as a dead instance and abandons the deploy, and an instance that
never comes up is an instance whose `/health` nobody can read. CI asks the same
question with `curl -fsS` and keeps passing.

The home page carries the same news for whoever is not curling anything: a red
`role="alert"` banner above the persona buttons, listing the same sentences the 503
pages render, and the persona buttons go inert while sign-in itself is unconfigured.
Inert rather than hidden — hiding them would leave a visitor wondering whether this
demo has personas at all. `test/configuration-banner.test.tsx` pins the banner, the
disabled buttons, and the fully-configured case where neither appears.

| variable | what it is |
|---|---|
| `IDP_ISSUER` | `apps/idp`'s public origin, **as a URL** — not the HOST-form the cross-service keys use |
| `IDP_CLIENT_ID` / `IDP_CLIENT_SECRET` | client C, this service's own registration at the IdP |
| `SESSION_SECRET` | seals the session cookie. No fallback, and ≥32 characters / ≥8 distinct is enforced. `openssl rand -hex 32` |
| `PUBLIC_URL` | this service's own origin, with the scheme. Every `redirect_uri` is built from it |
| `ARCADE_GATEWAY_ID` | `cg-demo-us`, the User Source gateway hop 1 authorizes against |
| `ARCADE_API_KEY` | the project key `confirm_user` is authenticated with |
| `IDP_SCOPES` | defaults to `openid email`. `email` is the join key, so it is not optional |
| `ARCADE_CLOUD_URL` | defaults to `https://cloud.arcade.dev`, which is **not** `ARCADE_API_URL`. A test seam |
| `ARCADE_MCP_CLIENT_ID` | optional, and blank is correct. Pins the gateway's MCP client id instead of registering one per process |

Every one of them is in `.env.example` and is a `sync: false` entry on `cg-web` in
`render.yaml`. The first six a human sets; the last three have working defaults and
should be left blank — they are named in the blueprint so it is the whole list rather
than most of it.

Two steps are not environment variables on this service:

- **Client C must exist on cg-idp**, with `${PUBLIC_URL}/api/auth/callback` allowlisted:
  `IDP_OAUTH_CLIENTS=web` and `IDP_OAUTH_REDIRECT_URIS_WEB=…` there, then
  `bun run --cwd apps/idp oauth-client --client web --rotate`, which prints the secret
  exactly once (#70).
- **Arcade dashboard → Auth → Settings → Custom verifier route** must be
  `${PUBLIC_URL}/api/arcade/verify`. Without it Arcade uses its own verifier, which
  demands an Arcade account that is a project member — our personas are not, the grant
  binds to whoever is signed in at `account.arcade.dev`, and the tool re-challenges
  forever with nothing on the panel to say why (`DESIGN.md` open risk 4). Check it
  through the admin API, not the dashboard label.

### Running the identity locally

Two terminals, plus whatever port this worktree owns. `apps/idp` needs its own install
(`bun install --cwd apps/idp`) — see `DESIGN.md`.

```sh
# Terminal 1 — the identity provider, with client C
PORT=8083 IDP_PUBLIC_URL=http://localhost:8083 \
  IDP_OAUTH_CLIENTS=web \
  IDP_OAUTH_REDIRECT_URIS_WEB=http://localhost:3000/api/auth/callback \
  bun apps/idp/src/index.ts

# then, in the same environment, mint client C's secret (printed once)
IDP_PUBLIC_URL=http://localhost:8083 IDP_OAUTH_CLIENTS=web \
  IDP_OAUTH_REDIRECT_URIS_WEB=http://localhost:3000/api/auth/callback \
  bun run --cwd apps/idp oauth-client --client web --rotate

# Terminal 2 — the web app
PORT=3000 PUBLIC_URL=http://localhost:3000 \
  IDP_ISSUER=http://localhost:8083 \
  IDP_CLIENT_ID=<from above> IDP_CLIENT_SECRET=<from above> \
  SESSION_SECRET=$(openssl rand -hex 32) \
  bun run --cwd apps/web dev
```

Open `/`, press a persona, sign in with the fixture password from
`apps/idp/src/fixtures/people.json`. `/health` reports `signin: configured`; hop 1 and
the verifier need `ARCADE_GATEWAY_ID` and a real `ARCADE_API_KEY` and are exercised
locally by `test/identity-flow.test.ts` against a stand-in.

## The control-plane panel

`/panel` renders it full-screen. `<ControlPlanePanel>` is the component #22 drops into
the right half; it renders no `<html>` or `<body>` of its own.

Three lanes — Access, Pre, Post — fed by a `text/event-stream` of `GovernanceEvent`s
(#5). Green allow, red deny with the rule that fired, amber modify with a before/after
diff. Newest at the top of each lane, so the freshest card never moves.

**`/access` is called on `tools/list` for every tool in the gateway and again on each
call, so access rows outnumber pre rows by design.** That is the hook doing its job, not
a leak.

### Repeated access decisions share a row

Arcade calls `/access` once per tool-schema resolution, so one `tools/call` fans out
into several decisions about the same person and the same tool. Measured at the #13
sitting with retry off: one `Loan.GetLoan` produced **three** access rows and one
`Loan.ApproveLoan` produced **two** (#64).

The Access lane collapses **adjacent** decisions that share `user_id`, `tool` and
`decision` and land within `ACCESS_GROUP_WINDOW_MS` (three seconds,
`lib/governance/grouping.ts`) into one card carrying their count; the individual event
ids are on the card behind a disclosure. Three limits, all deliberate:

- **Presentation only.** Nothing is deduplicated in `audit_log` or in the stream, the
  timeline still holds every event, and both tallies still count every one of them. A
  card saying *3 decisions* is a claim that three were made.
- **Only adjacent decisions group.** Reaching past an intervening event to merge two
  matching ones would reorder the lane, and not reordering is the timeline's first
  property. A fan-out that arrives interleaved with something else stays several rows.
- **A row spans at most the window, measured from its newest member.** Chaining
  neighbour to neighbour would let a slow drip of matching decisions collapse into one
  row claiming they arrived together.

`/panel?fanout=1` replays the measured shape through the fixture stream, so the two
rows and their counts are something to look at rather than read about.

### Which stream it watches

Read in the **server** component and passed down as a prop. Never a `NEXT_PUBLIC_`
variable — `.env.example` explains why at length: `next build` inlines those into the
client bundle while Render supplies service variables at runtime, so one would be
`undefined` in the deployed browser and perfectly fine under `next dev`.

One knob, `GOVERNANCE_STREAM`, and three states:

| `GOVERNANCE_STREAM` | Stream | Badge on screen |
|---|---|---|
| `hooks` | `http(s)://$HOOKS_PUBLIC_HOST/events` | `LIVE · cg-hooks.onrender.com` |
| `fixture` | `/api/governance/fixture-stream` — this app, replaying #5's fixture sequence | `FIXTURE REPLAY` |
| unset, under `next dev` | the same replay | `FIXTURE REPLAY` |
| unset, **deployed** | nothing. `/panel` is an error state naming the variable | `NO STREAM` |

Anything else is refused by name rather than resolved to something, because a typo on
a Render service page would otherwise be a panel quietly showing the demo.

**The replay is the development default deliberately.** `apps/hooks` *does* serve
`/events` — the stream half of #20 landed on #54 — but it is a second service with a
database of its own, and most of the time a fresh clone does not have it running.
Defaulting to it would open the panel on a connection retrying against nothing, which
reads as a broken app rather than as a control plane nobody started. Opting in is two
variables:

```sh
GOVERNANCE_STREAM=hooks HOOKS_PUBLIC_HOST=localhost:4411 bun run --cwd apps/web dev
```

**That reasoning does not survive a deploy, which is #81.** A deployed panel is in
front of an audience and has a control plane to watch, so an unset variable there is
not a convenience — it is the panel answering "is this real?" with a replay. It did
exactly that: `render.yaml` never declared `GOVERNANCE_STREAM` for `cg-web` between #21
and #81, so every production deploy was in fixture replay by construction, and on
2026-09-11 a human made a real governed `Loan_GetLoan` against the live gateway and
watched the panel play #5's demo sequence instead. Nothing on the page said so.

So, deployed (`NODE_ENV=production`, or Render's `RENDER=true`):

- an unset `GOVERNANCE_STREAM`, or `hooks` with no `HOOKS_PUBLIC_HOST`, renders an
  error state in place of the lanes — naming the variable, opening no socket, and
  replaying nothing. A warning *above* a running replay would still be a running
  replay, and the rows are the lie.
- `GET /health` reports `"panel_stream"` as `live`, `fixture` or `unconfigured`, and
  answers `"status":"degraded"` on the last — beside the three identity capabilities
  #82 added, for the same reason and in the same shape.
- the replay is still available when it is asked for: `GOVERNANCE_STREAM=fixture`, or
  `/panel?fixture=1` for a single request. It says `FIXTURE REPLAY` on screen either way.

Both modes carry a badge, always. `LIVE` names the host, because "live" on its own is a
word a fixture could print and the host is the part somebody at the back of the room can
check. A rehearsal must not mistake a replay for the live control plane, and the answer
belongs on the projector rather than in the presenter's narration.

### Watching it absorb a burst

A whole-project `/access` decides 10,844 tools in one call, so "handles a burst" is not
hypothetical. In fixture mode the page's own query string tunes the replay:

```
/panel?repeat=2000&delayMs=0     # 10,000 events, as fast as the socket carries them
/panel?delayMs=300               # the four acts, faster than the default 900ms pacing
/panel?fanout=1                  # the acts, then the measured /access fan-out (#64)
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

`lib/governance/subscribe.ts` is the only file that knows the wire contract, and
`apps/hooks/src/events.ts` is the only file that writes it — #54 implemented that shape
rather than negotiating a new one, so the two halves have never had to be reconciled.

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

`/health` deliberately does not read *this* variable — it reports the identity
capabilities and the panel's stream, never the approvals token — so it answers
`200` either way; the guard fires on the first request that needs the token,
which is any view of an approval.

## Driving the two beats locally

Three terminals. No Arcade account, no network, no secrets to set: `apps/hooks`
and the stand-in both fall back to the same development bearers outside
production.

Pick your own ports — every service reads `PORT` and this worktree owns a block
of ten. The ports below are examples; substitute yours.

**Terminal 1 — the control plane.** Owns `governance.db`, serves the hooks and
the four `/approvals` endpoints.

```sh
PORT=4401 GOVERNANCE_DB_PATH=/tmp/cg/governance.db bun apps/hooks/src/index.ts
```

**Terminal 2 — the Arcade stand-in.** Prints the port it bound. It is a
development fixture, and it says so on every boot.

```sh
PORT=4402 HOOKS_PUBLIC_HOST=localhost:4401 bun run --cwd apps/web arcade-stand-in
```

Leave `PORT` off and it binds `:0` and tells you what it got.

**Terminal 3 — the web app**, pointed at the stand-in. `ARCADE_API_KEY` must be
non-empty; the stand-in ignores the value.

```sh
PORT=4400 HOOKS_PUBLIC_HOST=localhost:4401 \
  ARCADE_API_URL=http://localhost:4402 ARCADE_API_KEY=offline \
  bun run --cwd apps/web dev
```

Now create the escalation act 2 produces — normally `tools/approvals` writes
this after the pre-hook refuses Dana, and here you write it directly:

```sh
curl -s -X POST http://localhost:4401/approvals \
  -H "authorization: Bearer cg-approvals-store-dev-token-not-for-production" \
  -H 'content-type: application/json' \
  -d '{"requester_id":"dana.okafor@bank.example","action":"approve_loan",
       "resource_id":"LN-2291","amount":95000,
       "justification":"Eleven years in business, 742 credit score.",
       "approver_id":"riley.chen@bank.example",
       "candidate_approver_ids":["riley.chen@bank.example","morgan.ellis@bank.example"],
       "required_clearance":95000}'
```

It answers with the record; take the `id` and open
`http://localhost:4400/approvals/<id>`.

**Beat one — Riley approves.** The page opens acting as Riley Chen, the routed
approver. Press **Approve**. You get *Decision recorded*, the status chip turns
`approved`, and `governance.db` now holds a grant — `active`, single use,
pinned to `LN-2291`, ceiling 95,000.

**Beat two — Dana is refused.** Create a second request with the same curl.
On its page, switch **Act as** to *Dana Okafor* and press **Approve**. You get
the `CHECK_FAILED` screen carrying the pre-hook's own words —
*"Dana Okafor raised this approval request, and separation of duties means the
person who asks cannot also be the person who approves"* — plus the `[ref evt_…]`
token that joins it to the audit row. The request stays `pending`.

That refusal is the actual policy in `governance.db` refusing, reached through
the actual `/pre`. The stand-in cannot answer at all without asking first: see
`scripts/arcade-stand-in.ts`, which the test suite imports rather than
duplicating, so what you see here and what `bun test` pins are one
implementation.

To watch the decisions land:

```sh
sqlite3 /tmp/cg/governance.db \
  "SELECT hook, user_id, tool, decision, rule_id FROM audit_log ORDER BY seq DESC LIMIT 5;"
sqlite3 /tmp/cg/governance.db "SELECT id, status, authorizes, uses_remaining FROM grants;"
```

### Unverified

`lib/arcade.ts` has never spoken to `api.arcade.dev`: #13 registers the gateway and the
provider. The tests drive the real pre-hook through a stand-in that calls it the way the
engine does and runs the tool only on `OK`, so the refusals under test are produced by the
actual policy — but the live round trip is not evidence this slice can offer.
