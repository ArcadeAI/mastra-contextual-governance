# Spike 05 — one tool call as Dana: the User Source at hop 1, the custom verifier at hop 2

**Status: hop 1 measured and blocked on #61. Hop 2 built and not yet measured.**

This spike is about **one full tool call as Dana through `cg-demo-us`, with a
`/pre` payload carrying `user_id` = her lowercase email.** Getting there crosses
two hops, and they are governed by two different mechanisms that round 1 of this
spike ran together:

| | Hop | Mechanism | Where it stands |
|---|---|---|---|
| **1** | MCP client → gateway `cg-demo-us` | **User Source** `cg-idp` | **measured.** Arcade brokers to our IdP; Dana signs in and consents there; Arcade then fails to exchange the code. #61 (PR #78) is the inferred fix |
| **2** | tool-level OAuth, `cg-idp` auth provider | **custom user verifier** | **unmeasured.** The verifier is built, tunnelled and reachable. Arcade has never called it, because the dashboard route was never saved |

Round 1 asked whether a custom verifier moves the *hop 1* login. That question is
answered — it does not, the User Source does — and it was the wrong question. A
verifier is what lets someone who is **not an Arcade project member** authorize a
*tool*, which is precisely what the personas become the moment hop 1 stops going
through Arcade's own accounts. So hop 2 is where the verifier earns its place, and
hop 2 is what is still open:

- **H2-a** — on Dana's first tool authorization, does Arcade redirect her browser
  to the verifier at all? **Unmeasured.**
- **H2-b** — does `confirm_user` complete the flow and let the tool call through?
  **Unmeasured.**
- **H2-c** — is `context.user_id` on the `/pre` payload the exact lowercase email
  the verifier confirmed? **Unmeasured.**

Every one of those needs a human at a dashboard and a working hop 1. The
measurement sitting runs after #61 deploys and the `cg-idp` auth provider is
flipped to `client_secret_basic`; until then this document records what is
measured, names what is not, and does not guess at the difference.

Resolves [#75](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/75).
Follows [#65](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/65)
([`04-user-source.md`](04-user-source.md)). Feeds the #14 gate. Raw transcripts,
redacted, in [`evidence/05-custom-verifier-transcript.md`](evidence/05-custom-verifier-transcript.md).

Scripts, all discardable, all outside `apps/`:

| | |
|---|---|
| [`evidence/05-verifier.ts`](evidence/05-verifier.ts) | the verifier: binds `:0`, tunnels itself, OIDC against the **live** IdP, `confirm_user` |
| [`evidence/05-verifier-flow.ts`](evidence/05-verifier-flow.ts) | walks a gateway's authorization chain, both hops, and names the host that rendered every page |
| [`evidence/05-redirect-allowlist.ts`](evidence/05-redirect-allowlist.ts) | reads an OAuth client's redirect-URI allowlist from outside, unauthenticated |
| [`evidence/05-token-auth-methods.ts`](evidence/05-token-auth-methods.ts) | maps `apps/idp`'s token-endpoint refusals to causes. Self-contained: boots its own IdP, needs no credential |
| [`evidence/05-drive.ts`](evidence/05-drive.ts) | the browserless user agent, carried forward from spike 04 with two fixes |

Two of those are runnable right now from a clean checkout with nothing configured:

```sh
bun docs/spikes/evidence/05-token-auth-methods.ts        # exits 0, boots and tears down its own IdP
bun docs/spikes/evidence/05-redirect-allowlist.ts        # exits 0, reads the live allowlist

PROBE_ONLY=1 ARCADE_MCP_URL=https://api.arcade.dev/mcp/cg-demo-us \
  PERSONA_EMAIL=nobody@example.invalid PERSONA_PASSWORD=unused \
  bun docs/spikes/evidence/05-verifier-flow.ts           # exits 0, types no password
```

## What the human has to do, in order

These are #24 material. Steps 1–2 are the blockers; 3–4 are the sitting this spike
is waiting for.

1. **Land #61 (PR #78) and flip the `cg-idp` auth provider to `client_secret_basic`.**
   Hop 1 reaches our IdP and then dies at Arcade's token exchange. The cause is
   inferred, not measured — see [hop 1](#hop-1--the-user-source-measured-and-blocked)
   — and #61 is the fix for the likelier of the two candidates.
2. **Give `apps/idp` a request log.** One line per `POST /oauth2/token` that does
   not return 200, with the status and the `error` field. Not dressing: this spike
   could not distinguish two causes of a production failure because the service
   says nothing about what it refuses. Belongs with #61.
3. **Arcade dashboard → Auth → Settings → Custom verifier route.** Paste the
   tunnel URL `05-verifier.ts` prints at startup. This is what hop 2 needs and it
   has never been set.
4. **`IDP_OAUTH_REDIRECT_URIS` on the `cg-idp` Render service.** Append the
   verifier's `/callback`, keeping every existing entry — the list already carries
   the User Source's `.../oauth2/intermediate_callback` and the auth provider's
   per-provider `.../api/v1/oauth/<provider-id>/callback`, and both must survive.
   `evidence/05-redirect-allowlist.ts <url>` confirms the change landed without
   opening the dashboard.

## Setup

| | |
|---|---|
| IdP | `https://cg-idp-or5b.onrender.com` — `apps/idp` on Render, after #70. RS256, `jwks_uri`, `email` on the ID token, PKCE S256 required, `client_secret_post` |
| IdP OAuth client | one, `RskTFjl6AqkUO8FKYWjpDCLd139YE36F`, published on `/health`. Secret stored hashed; `/oauth2/register` returns 403 |
| User Source | `cg-idp`, `us_3JA8GcvHfT17WNnnRazx6FZpxeg`, attached to `cg-demo-us` and published in its protected-resource document |
| Auth provider | `cg-idp`, the one `tools/loan` declares as `OAuth2(id="cg-idp")`. Same name, same IdP, a **separate** registration with its own secret and its own per-provider callback |
| Gateway under test | `cg-demo-us` → `https://api.arcade.dev/mcp/cg-demo-us` |
| Control gateway | `cg-demo` → `https://api.arcade.dev/mcp/cg-demo`, "Members of this Project" mode |
| Verifier | local Bun server on a port it binds as `:0`, behind `ngrok`; never deployed |
| Control plane | `https://cg-hooks.onrender.com`, `/events` SSE and `/audit` over HTTP, both unauthenticated (#62) |
| Personas | Dana, Sam, Riley, Morgan; passwords from `apps/idp/src/fixtures/people.json`, live addresses only in Render env |
| Client | raw `fetch` with a cookie jar. No browser, and no credential provisioned by the implementer |

## Hop 1 — the User Source. Measured, and blocked

**Where Dana logs in: our own IdP.** Measured 2026-09-11, and the answer changed
during the spike with no change on our side.

The control at 14:15Z — five hops to Arcade's account login, exactly what spike 04
reported a week earlier:

```
302 GET https://cloud.arcade.dev/oauth2/authorize
302 GET https://auth.arcade.dev/oauth2/auth
303 GET https://auth.arcade.dev/ui/login
303 GET https://auth.arcade.dev/self-service/login/browser
200 GET https://account.arcade.dev/login          ← page 1, Arcade's
```

The same gateway at 14:24Z — two hops, and the pages are ours:

```
302 GET https://cloud.arcade.dev/oauth2/authorize
302 GET https://cg-idp-or5b.onrender.com/oauth2/authorize
          client_id=RskTFjl6AqkUO8FKYWjpDCLd139YE36F
          redirect_uri=https://cloud.arcade.dev/oauth2/intermediate_callback
          scope=openid+profile+email, PKCE S256
200 GET https://cg-idp-or5b.onrender.com/login    ← page 1, ours
303 POST https://cg-idp-or5b.onrender.com/login   ← Dana signed in, for real
200 GET https://cg-idp-or5b.onrender.com/consent  ← page 2, ours
303 POST https://cg-idp-or5b.onrender.com/consent
302 GET https://cloud.arcade.dev/oauth2/intermediate_callback
```

`auth.arcade.dev` and `account.arcade.dev` are gone from the chain entirely. The
broker consults the gateway's `user_source_id`, resolves the User Source, and
redirects to the configured issuer. **Spike 04's candidate (A) — Arcade's broker
ignores `user_source_id`, a platform bug — is dead.**

**Nothing on our side changed between those two measurements**, and that stays on
the record rather than being smoothed over: the custom verifier route was never
saved, the User Source was not edited, the gateway was not recreated. Nine minutes
apart, same script, same persona, different upstream. The change was Arcade's.
Recording it as unexplained is the only honest option, and crediting the verifier
would have sent #14 to build a component hop 1 does not need.

### …and then the token exchange fails

Arcade takes the authorization code and comes back with:

```
?error=access_denied
&error_description=Token+exchange+with+identity+provider+failed
&iss=https%3A%2F%2Fcloud.arcade.dev%2Foauth2
```

Reproduced seven times between 14:24Z and 14:41Z, never once succeeding. Dana
authenticates and consents at our IdP; Arcade cannot trade the code for a token.
**So hop 1 yields no gateway token, and without one there is no `tools/call`, and
without that there is no hop 2 to measure.** That is the single dependency
between the two halves of this document.

Two candidate causes, and `apps/idp` separates them **by status code alone** —
four real single-use codes against a throwaway instance the script boots itself:

| What Arcade sent to `/oauth2/token` | Response |
|---|---|
| `client_secret_post`, correct secret | **200**, a token |
| `client_secret_post`, wrong secret | **400** `invalid_client` / *"invalid client_secret"* |
| `client_secret_basic`, correct secret | **401** `invalid_client` / *"client registered for `client_secret_post` cannot use `client_secret_basic`"* |
| no client authentication | **400** `invalid_client` / *"client registered for `client_secret_post` cannot use none"* |

One line of the `cg-idp` Render log would settle it. **That line does not exist:
`apps/idp` logs its boot and nothing else.** So the cause below is an
**inference, labelled as one**, and the missing log is a finding in its own right.

**Most likely: the auth method, not the secret.** The secret in the User Source was
entered from `oauth-client`'s output at the #65 sitting and #70 preserved that
client rather than rotating it, so a stale secret has no obvious way to have
happened. The User Source form has no auth-method control. And the *auth provider*
of the same name only worked at #13 once its auth method was forced to
post-in-params — the same mismatch, already seen once on this project, against the
same IdP. That is [#61](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/61)'s
first item, and if it is the cause then **re-entering the secret cannot fix it**.

The **live** IdP cannot be asked this directly: it validates the authorization code
before the client, so a probe with a junk code returns `invalid_grant / invalid
code` whether it carries no secret, a wrong secret or Basic auth.

## Hop 2 — the custom verifier. Built, not measured

This is what the spike is for, and it is the part that has not happened.

### What exists

`evidence/05-verifier.ts` is a complete implementation of Arcade's custom-verifier
contract, pointed at the live IdP:

1. `GET /verify?flow_id=…` — records Arcade's whole query string rather than
   picking out the field it expected, and starts an authorization-code + PKCE login
   at `https://cg-idp-or5b.onrender.com`.
2. `GET /callback?code&state` — exchanges the code, reads `email` off
   `/oauth2/userinfo`, lowercases it (DESIGN.md rule 3).
3. `POST https://cloud.arcade.dev/api/v1/oauth/confirm_user` with
   `{flow_id, user_id}`, then 303 to the `next_uri` Arcade returns.

It binds `:0`, tunnels itself with `ngrok`, logs every request it receives, and
exposes `GET /state` so the whole conversation can be read back. Credentials come
from the untracked, gitignored `docs/spikes/evidence/.env.local`; the process names
which source they came from and prints neither.

**Why the live IdP and not a local one.** Round 1 proved the route against a local
`apps/idp` — same code, real logins by three seeded personas, `confirm_user` parked
and resumed, `next_uri` followed. That established the route's own contract and
nothing about Arcade. Hop 2's interesting question is a round-trip count: hop 1
already signs Dana in at `cg-idp-or5b.onrender.com`, so the browser arriving at
`/verify` carries that session, and whether hop 2 reuses it or asks her to log in
again is only answerable on the same origin. A local IdP answers a different
question.

**The one manual step.** `confirm_user` is authenticated with the Arcade project
API key, which the implementer of a spike does not hold and must not. With
`ARCADE_API_KEY` set the verifier makes the call itself — that is the production
path and the code a real deployment runs. Without one it prints the exact `curl`
with the real `flow_id` and `user_id`, parks the browser, and resumes when the
response is posted back to `POST /confirm`. One human action per flow, and the same
code runs afterwards either way, so the manual path is not a second design. **This
spike will use the manual path**, and the write-up says so rather than implying an
automated flow was observed.

### What is not known, and what will answer it

| | Question | How it gets answered |
|---|---|---|
| **H2-a** | On Dana's first tool authorization, does Arcade redirect her browser to the verifier? | `05-verifier-flow.ts` walks the URL the tool call hands back, with the same cookie jar as hop 1, and prints every host. The verifier logs every request it receives; `GET /state` shows whether Arcade arrived |
| **H2-b** | Does `confirm_user` complete it, and does the tool call then succeed? | the exact `curl` per `flow_id`, run by the human; then the `tools/call` result |
| **H2-c** | Is `/pre`'s `context.user_id` the email the verifier confirmed? | `GET https://cg-hooks.onrender.com/audit`, or `/events` with `last-event-id: 0` (#62) |
| **H2-d** | Does a second persona work without logging the first out? | repeat H2-b as Sam for `Loan_SearchLoans`. Explicitly optional; if the sitting runs short it stays unmeasured |

**And a real possibility this document will not pretend away: Arcade may never
call the verifier at all.** A User Source persona already has an Arcade-side
identity from hop 1, and the verifier's documented job is to establish one. If the
chain skips it, that is a result, not a failure — it would mean a User Source
persona bypasses the verifier entirely, and #14 needs no verifier route. The
measurement is written to record what the chain did instead.

### What is measured about hop 2 today

Only the mechanism underneath it, at `apps/idp`, which bounds the round-trip count
whatever Arcade does:

| Run | Persona state | Pages rendered |
|---|---|---:|
| First ever authorization | no session, no prior consent | **2** — `/login`, then `/consent` |
| Later authorization, new browser | no session, consent on record | **1** — `/login` |
| Second authorization, same browser | live session, consent on record | **0** — entirely silent |

Two complete flows back to back through one cookie jar:

```
== flow spike75-riley-a: pagesShown=2 pageHosts=["localhost:4423","localhost:4423"]
== flow spike75-riley-b: pagesShown=0 pageHosts=[]
```

Confirmed on the **live** IdP too: Dana's second hop-1 run, at 14:29:47Z, rendered
one page rather than two, because her consent from 14:24Z was on record.

So if Arcade does route hop 2 through the verifier, the expected shape — **an
expectation, not a measurement** — is two authorizations against one IdP session:
`login` + `consent` for the gateway, then nothing or a single `consent` for the
tool, because Better Auth holds the session cookie on `cg-idp-or5b.onrender.com`
and both go to that host. The thing that would break it is the auth provider and
the User Source being **different OAuth clients** at the IdP: consent is per
client, so a second client means a second consent. `apps/idp` has exactly one
client today, so today they are the same one — which is itself a problem, and the
next section says why.

## The one-client problem

`apps/idp` registers **exactly one** OAuth client, confidential,
`client_secret_post`, secret stored hashed since #70, with dynamic client
registration off by design (`POST /oauth2/register` → 403). Measured: there is no
PKCE-only path around the secret —

```
no client_secret (PKCE only) -> 400 {"error":"invalid_client",
  "error_description":"client registered for client_secret_post cannot use none"}
```

Three different relying parties now want to be that client: the **User Source**,
the **auth provider**, and the **verifier** (later, `apps/web`). They share a
secret that can be read exactly once, so rotating for one breaks the other two
until every dashboard field is updated by hand. **`apps/idp` needs to mint and
print additional clients**, the way it does the first. That is a #14 prerequisite
or its own small slice, and it is bigger than this spike.

## Findings

| # | Question | Verdict | Value |
|---|---|---|---|
| **Hop 1** | | | |
| 1 | Hop 1 on `cg-demo-us` reaches our IdP | **measured** | Yes, from 2026-09-11 ~14:24Z. Two hops to `cg-idp-or5b.onrender.com`, a real sign-in and a real consent |
| 1a | Spike 04's candidate (A), a platform bug | **measured, dead** | The broker does consult `user_source_id` and redirects to the configured issuer |
| 1b | What changed to make it work | **unexplained** | Nothing on our side. 14:15Z `account.arcade.dev`, 14:24Z `cg-idp` |
| 1c | Hop 1 completes | **measured, no** | `access_denied` / *"Token exchange with identity provider failed"*, seven times over 17 minutes |
| 1d | Why it fails | **inferred, not measured** | Most likely `client_secret_basic` against a `client_secret_post` registration (#61 item 1); a stale secret is the alternative |
| 1e | Why it could not be measured | **measured** | `apps/idp` emits no request log lines at all — only boot lines |
| 1f | How the two causes differ, when a log exists | **measured** | **401** = auth-method mismatch; **400** = wrong secret; **200** = the exchange worked |
| 1g | Whether the live IdP can be probed for it | **measured, no** | It checks the code before the client; a junk code returns `invalid_grant` for every client-auth variant |
| 2 | Hop 1 on `cg-demo` (members mode) | **measured** | Unchanged: five hops to `account.arcade.dev`, so every persona would need an Arcade seat |
| 2a | Whether the hop-1 change was project-wide | **measured, no** | `cg-demo` did not move at all while `cg-demo-us` moved completely |
| **Hop 2** | | | |
| 3 | **H2-a** — Arcade redirects to the verifier on first tool authorization | **UNMEASURED** | The dashboard route was never saved; Arcade has never called the tunnel. Blocked on #61 and a sitting |
| 4 | **H2-b** — `confirm_user` completes the flow and the tool call succeeds | **UNMEASURED** | Same block |
| 5 | **H2-c** — `/pre`'s `context.user_id` equals Dana's lowercase email | **UNMEASURED** | No `/pre` frame has been produced by this spike at all |
| 6 | **H2-d** — a second persona without logging the first out | **UNMEASURED** | Optional within the sitting |
| 7 | Whether a User Source persona bypasses the verifier entirely | **UNMEASURED, and a live possibility** | Hop 1 already gives Arcade an identity; the verifier's job is to establish one |
| 8 | The verifier implements the contract | **measured (local IdP, round 1)** | Five flows, three personas: OIDC login, `email` off `/oauth2/userinfo`, `confirm_user`, `next_uri` followed. Against a local `apps/idp`, not against Arcade |
| **Both** | | | |
| 9 | Round trips at `apps/idp` per authorization | **measured** | 2 pages first ever, 1 with consent on record, **0** on a second authorization in the same browser |
| 10 | The IdP's redirect-URI allowlist, from outside | **measured** | Readable unauthenticated off the 302 target. The live client allows the User Source's `.../oauth2/intermediate_callback` **and** the auth provider's per-provider `.../api/v1/oauth/<provider-id>/callback` |
| 10a | `.env.example`'s documented default | **measured, wrong** | It ships `https://cloud.arcade.dev/api/v1/oauth/callback`, which the live IdP rejects. Arcade's real auth-provider callback carries a per-provider path segment |
| 11 | A verifier can be an unattended OAuth client of `apps/idp` | **measured, no** | One client, secret hashed since #70, DCR 403, PKCE-only refused. Three relying parties want that one client |

## Confidence

| Claim | |
|---|---|
| `cg-demo-us` sends the persona to `cg-idp-or5b.onrender.com` | ✅ full chain, a real login and a real consent, reproduced all afternoon |
| `cg-demo` still sends the persona to `account.arcade.dev` | ✅ measured after the other gateway had already moved |
| Arcade's broker consults the gateway's `user_source_id` | ✅ it redirects to the configured issuer with the configured client id |
| Nothing on our side caused the hop-1 change | ✅ the human confirmed the verifier route was never saved and the User Source untouched |
| Hop 1's token exchange fails, and where | ✅ `access_denied`, seven times |
| The two candidate causes and how a log tells them apart | ✅ four real codes against a self-booted instance; 401 vs 400, asserted by the script |
| `apps/idp` has no request logging | ✅ the human read the live log: boot lines only |
| `apps/idp` refuses a PKCE-only token request | ✅ exact error text |
| The live allowlist carries both Arcade callbacks | ✅ probed from outside, ALLOWED on both, REJECTED on five decoys |
| Page counts at `apps/idp` for 1st / later / same-session | ✅ three runs, and the live IdP agreed on the second |
| The verifier completes a real flow against `apps/idp` | ✅ five flows, three personas — against a **local** instance, never against Arcade |
| **H2-a — Arcade calls the verifier** | ⬜ **unmeasured.** Route never saved; zero requests from Arcade |
| **H2-b — `confirm_user` completes the tool call** | ⬜ **unmeasured** |
| **H2-c — `/pre` carries Dana's lowercase email** | ⬜ **unmeasured.** No `/pre` frame produced |
| **H2-d — two personas at once** | ⬜ **unmeasured** |
| **Whether a User Source persona needs a verifier at all** | ⬜ **unmeasured.** Genuinely open, and the answer changes #14's scope |
| Which cause hop 1's token exchange failed for | ⬜ **inferred.** Needs one log line that does not currently get written |
| What Arcade changed at ~14:24Z | ⬜ **unexplained.** Ours to notice, not ours to know |
| Hop 2's real round-trip count | ⬜ **unmeasured.** Reasoned from `apps/idp`'s consent behaviour |

## Recommendation for #14 — provisional

**Provisional, and it says so**, because the measurement that would settle hop 2
has not run. What follows is what the measured half already decides, and what the
sitting has to decide.

**Decided by measurement: take the User Source for hop 1.** `cg-demo-us` sends the
persona to our IdP with no Arcade account in the chain; `cg-demo` cannot, because
members mode is Arcade's account login by construction. Option (2) costs four
Arcade seats and makes the demo's own personas Arcade users, which is the story
this demo exists to contradict. Members mode stays a genuine fallback — it costs
the identity story, not the governance story, since layers 1–4 key off
`context.user_id` and that is the same lowercase address either way.

**Contingent: #61 first.** Hop 1 reaches our IdP and yields no token. Nothing about
hop 2 can be measured, and nothing in #14 can be built against it, until that
exchange succeeds. **Do not start #14's gateway wiring until `05-verifier-flow.ts`
prints a `user_id` on a `/pre` frame.**

**Open, and it is the expensive one: does `apps/web` need a verifier route at all?**
Two outcomes, and they differ by real work:

- If Arcade **does** route hop 2 through the verifier, `apps/web` needs two route
  handlers — one to start the check, one to take the IdP's callback — plus the
  Arcade API key server-side, plus **a second OAuth client at `apps/idp`**, which
  the IdP cannot currently mint. Carry over one property from
  `evidence/05-verifier.ts`: it starts a fresh login per flow and never reads a
  session of its own, because a verifier that trusts its own session collapses all
  four personas onto whoever logged in last.
- If Arcade **does not** — if a User Source persona is already identified and hop 2
  skips the verifier — then #14 needs none of that, and this spike's verifier is
  deleted rather than promoted.

**Arcade Headers is not considered.** The human ruled the mode out on 2026-09-11.

## Nothing under `apps/` changed

`git diff --name-only main` is `docs/spikes/` and nothing else. The verifier is
deliberately not an app: no database, no tests, no deployment, and it holds a
client secret in its environment, read from a gitignored file.

## Follow-ups

- **#61 is hop 1's only remaining gate**, plus one log line. Not fixed here: it is
  a change to `apps/idp`, and this spike may not make one.
- **`apps/idp` needs request logging.** A service that refuses a request and says
  nothing about it is this project's own failure mode wearing someone else's
  clothes.
- **`apps/idp` needs to mint more than one OAuth client.** Three relying parties
  currently share one, with a secret readable once. See
  [the one-client problem](#the-one-client-problem).
- **`.env.example`'s `IDP_OAUTH_REDIRECT_URIS` default is not a real Arcade
  callback.** The auth provider's carries a per-provider path segment, readable
  only from the dashboard. A forker who leaves the default alone gets an
  `invalid_redirect` at a step that fires no hook.
- **The `cg-idp` name is overloaded** — an auth provider and a User Source, same
  name, same IdP, separate registrations, separate secrets, and in this spike they
  govern different hops. Spike 04 raised it; this spike tripped over it twice and
  round 1 got the framing wrong because of it.
- **Spike 04's recommendation is superseded.** It chose Arcade Headers because the
  User Source "cannot be reached at all". It can.
