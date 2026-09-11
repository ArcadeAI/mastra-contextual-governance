# Spike 05 — does a custom user verifier against `apps/idp` make the gateway log personas in at our IdP?

**Answer: the custom verifier is not what does it, and something else already did.**

Three things, and the second is the one to read twice:

1. **A custom verifier was built, tunnelled, proven against a real `apps/idp`, and
   Arcade never called it.** It handled five complete flows: real logins by three
   seeded personas, `email` read off `/oauth2/userinfo`, `confirm_user` invoked,
   `next_uri` followed. The Arcade dashboard setting was **never saved** — the
   human confirmed it afterwards — so this spike cannot say from measurement
   whether a custom verifier participates in gateway sign-in. From Arcade's own
   documentation it does not: the verifier exists to bind a **tool** authorization
   to *"the ID specified at the start of the authorization flow"*, and a gateway
   sign-in has no such ID, because the sign-in is what establishes it.
2. **Hop 1 on `cg-demo-us` started working anyway, during the spike, with no
   change by us.** At 14:15Z the persona was sent to `account.arcade.dev`, five
   hops, exactly as spike 04 recorded. At 14:24Z the same gateway sent her to
   `https://cg-idp-or5b.onrender.com/login`, two hops, and she signed in and
   consented at our IdP for real. Nothing on our side changed in between: the
   verifier was not saved, the User Source was not touched, the gateway was not
   touched. **Spike 04's candidate (A) — Arcade's broker ignores the gateway's
   `user_source_id`, a platform bug — is dead.**
3. **The flow still does not complete.** Arcade takes the authorization code and
   answers `error=access_denied`, *"Token exchange with identity provider
   failed"*. The cause is **inferred, not measured**, and the reason it could not
   be measured is itself a finding: `apps/idp` writes no request log lines at all,
   so the one line that would settle it does not exist.

**Recommendation for [#14](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/14):
(1) User Source, contingent on [#61](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/61).**
Reasoning in [the last section](#recommendation-for-14). Arcade Headers, which
spike 04 recommended, is no longer on the table.

Resolves [#75](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/75).
Follows [#65](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/65)
([`04-user-source.md`](04-user-source.md)). Feeds the #14 gate. Raw transcripts,
redacted, in [`evidence/05-custom-verifier-transcript.md`](evidence/05-custom-verifier-transcript.md).

**Reproduced.** Every measurement here is from 2026-09-11 against the live
services, headlessly, as the seeded personas. No credential was provisioned by
the implementer and no browser was used.

Scripts, all discardable, all outside `apps/`:

| | |
|---|---|
| [`evidence/05-verifier.ts`](evidence/05-verifier.ts) | the verifier: binds `:0`, tunnels itself with `ngrok`, OIDC against `apps/idp`, `confirm_user` |
| [`evidence/05-verifier-flow.ts`](evidence/05-verifier-flow.ts) | walks a gateway's authorization chain and names the host that rendered every page |
| [`evidence/05-redirect-allowlist.ts`](evidence/05-redirect-allowlist.ts) | reads an OAuth client's redirect-URI allowlist from outside, unauthenticated |
| [`evidence/05-token-auth-methods.ts`](evidence/05-token-auth-methods.ts) | maps `apps/idp`'s token-endpoint refusals to causes |
| [`evidence/05-drive.ts`](evidence/05-drive.ts) | the browserless user agent, carried forward from spike 04 with two fixes |

## What the human has to do, in order

These are #24 material. Steps 1 and 2 are what is left; steps 3 and 4 are already
true on the live services and are here so a forker knows they are required.

1. **Fix the token exchange.** Arcade cannot trade the authorization code for a
   token at `cg-idp`. Do this in the order below and stop at the first one that
   works, re-running `evidence/05-verifier-flow.ts` after each:
   1. **Arcade dashboard → User Sources → `cg-idp` → rotate/re-enter the client
      secret.** `apps/idp` stores it hashed since #70, so if nobody wrote it down,
      `bun run oauth-client --rotate` on the `cg-idp` Render shell mints a new one
      under the same client id. It then has to go into **both** the User Source and
      the `cg-idp` auth provider — two separate registrations that share a name.
   2. **Land [#61](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/61)'s
      first item** — register the client `client_secret_basic`, reconciled onto the
      existing row. This is the likelier cause; see [question 1](#and-then-the-token-exchange-fails).
2. **Give `apps/idp` a request log.** Not optional dressing: this spike could not
   distinguish two causes of a production failure because the service says nothing
   about the requests it refuses. One line per `POST /oauth2/token` that does not
   return 200, with the status and the `error` field, would have turned an
   inference into a measurement. Belongs with #61.
3. **`IDP_OAUTH_REDIRECT_URIS` on the `cg-idp` Render service** must carry *both*
   Arcade callbacks, comma-separated — the User Source's and the auth provider's.
   Already correct on the live service; verified from outside by
   `evidence/05-redirect-allowlist.ts`, which needs no dashboard and no secret.
4. **Arcade dashboard → Auth → Settings → custom verifier route**, *only* when #14
   needs tool authorization to work for people who are not Arcade project members.
   It is not needed for gateway sign-in. `evidence/05-verifier.ts` prints the exact
   URL to paste, and the IdP has to allowlist that verifier's `/callback` too.

## Setup

| | |
|---|---|
| IdP | `https://cg-idp-or5b.onrender.com` — `apps/idp` on Render, after #70. RS256, `jwks_uri`, `email` on the ID token, PKCE S256 required, `client_secret_post` |
| IdP OAuth client | one, `RskTFjl6AqkUO8FKYWjpDCLd139YE36F`, published on `/health`. Secret stored hashed; `/oauth2/register` returns 403 |
| User Source | `cg-idp`, `us_3JA8GcvHfT17WNnnRazx6FZpxeg`, attached to `cg-demo-us` and published in its protected-resource document |
| Gateway under test | `cg-demo-us` → `https://api.arcade.dev/mcp/cg-demo-us` |
| Control gateway | `cg-demo` → `https://api.arcade.dev/mcp/cg-demo`, "Members of this Project" mode |
| Verifier | local Bun server on a port it bound as `:0`, behind `ngrok`; never deployed, torn down at the end of the spike |
| Control plane | `https://cg-hooks.onrender.com/events`, unauthenticated SSE, `last-event-id: 0` replays (#62) |
| Personas | Dana, Sam, Riley, Morgan; passwords from `apps/idp/src/fixtures/people.json`, addresses only in Render env |
| Client | raw `fetch` with a cookie jar. Two fixes over spike 04's, both forced by bugs this spike hit — see [`evidence/05-drive.ts`](evidence/05-drive.ts) |

## Before anything else: a verifier cannot be an unattended OAuth client of `apps/idp`

The first thing #75 hit, and a constraint on anything that ever wants to talk
OAuth to this IdP.

`apps/idp` registers **exactly one** OAuth client, confidential,
`client_secret_post`, and since #70 stores the secret **hashed** — readable only
by the run that created or rotated it. Dynamic client registration is off by
design (`allowDynamicClientRegistration: false`, `POST /oauth2/register` → 403),
so a verifier cannot mint its own. And there is no PKCE-only path around it;
measured against a local instance of the same code:

```
no client_secret (PKCE only) -> 400 {"error":"invalid_client",
  "error_description":"client registered for client_secret_post cannot use none"}
```

So the verifier was proven against a **local** `apps/idp` whose client this spike
minted and therefore holds the secret for. That is not a compromise on the
verifier's own contract — same code as `cg-idp`, real authorization-code logins by
real seeded personas — but it bounds what [question 3](#question-3--hop-2-the-tools-own-oauth-and-how-many-times-dana-logs-in)
could be asked. No credential belonging to the live services was ever handled.

What the verifier does, in full, is in [`evidence/05-verifier.ts`](evidence/05-verifier.ts).
One design note worth keeping: **`confirm_user` needs the Arcade project API key,
which the implementer of a spike must not hold.** With `ARCADE_API_KEY` set the
verifier makes the call itself — that is the production path, and it is the code
a real deployment runs. Without one it prints the exact `curl` with the real
`flow_id` and `user_id`, parks the browser, and resumes the moment the response is
posted back to `POST /confirm`. One human action per flow, and the same code runs
after the response arrives either way, so the manual path is not a second design.

## Question 1 — hop 1 on the User Source gateway: where does the persona log in?

**Measured, and the answer changed mid-spike: at our own IdP.**

The control, re-measured at 14:15Z — five hops to Arcade's account login, exactly
what spike 04 reported a week earlier:

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
redirects to the configured issuer with the configured client id. **Spike 04's
candidate (A) is dead.**

**Nothing on our side changed between those two measurements**, and that is on the
record rather than smoothed over: the custom verifier URL was never saved in the
dashboard, the `cg-idp` User Source was not edited, and `cg-demo-us` was not
recreated. Nine minutes apart, same script, same persona, different upstream. The
change was Arcade's. This spike cannot say what it was, and a write-up that
claimed the verifier caused it would be wrong in the most expensive possible way —
it would send #14 to build a component the demo does not need.

### …and then the token exchange fails

The flow does not complete. Arcade takes the code and comes back with:

```
http://localhost:57503/callback
  ?error=access_denied
  &error_description=Token+exchange+with+identity+provider+failed
  &iss=https%3A%2F%2Fcloud.arcade.dev%2Foauth2
```

Reproduced seven times between 14:24Z and 14:41Z, every two minutes, never once
succeeding. The persona authenticates at our IdP and consents; Arcade cannot trade
the code for a token.

From outside there are exactly two candidate causes, and `apps/idp` separates them
cleanly — **by status code alone**, four real single-use codes against a local
instance:

| What Arcade sent to `/oauth2/token` | Response |
|---|---|
| `client_secret_post`, correct secret | **200**, a token |
| `client_secret_post`, wrong secret | **400** `invalid_client` / *"invalid client_secret"* |
| `client_secret_basic`, correct secret | **401** `invalid_client` / *"client registered for `client_secret_post` cannot use `client_secret_basic`"* |
| no client authentication | **400** `invalid_client` / *"client registered for `client_secret_post` cannot use none"* |

One line of the `cg-idp` Render log would settle it. **That line does not exist:
`apps/idp` logs its boot and nothing else, no request logging at all.** So the
cause below is an **inference, labelled as one**, and the missing log is filed as
its own finding.

**Most likely: the auth method, not the secret.** The secret in the User Source was
entered from `oauth-client`'s output at the #65 sitting and #70 preserved that
client rather than rotating it, so a stale secret has no obvious way to have
happened. The User Source form has no auth-method control. And the *tool-level*
`cg-idp` provider only worked at #13 once its auth method was forced to
post-in-params — the same mismatch, already seen once on this project, against the
same IdP. That is [#61](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/61)'s
first item, and if it is the cause then **re-entering the secret cannot fix it**.

Note the **live** IdP cannot be asked this question directly: it validates the
authorization code before the client, so a probe with a junk code returns
`invalid_grant / invalid code` whether it carries no secret, a wrong secret or
Basic auth. `05-token-auth-methods.ts` therefore runs against a local instance.

## Question 2 — hop 1 on the members-mode gateway `cg-demo`

**Measured. Unchanged.**

At 14:26:13Z, after the User Source gateway had already moved:

```
302 GET https://cloud.arcade.dev/oauth2/authorize
302 GET https://auth.arcade.dev/oauth2/auth
303 GET https://auth.arcade.dev/ui/login
303 GET https://auth.arcade.dev/self-service/login/browser
200 GET https://account.arcade.dev/login
```

Byte for byte the control. `cg-demo` publishes no `urn:arcade:oauth:user_source_id`
and its sign-in is Arcade's own account login. **Whatever changed was scoped to the
User Source, not to the project** — which is also the cleanest evidence available
that a project-level setting, and the custom verifier is a project-level setting,
is not what moved question 1.

Members mode therefore still means every persona needs an Arcade account that is a
member of the project. Arcade's documentation is explicit:

> each end user [must] sign in to an Arcade account that is a member of your project

Four Arcade seats, four rehearsed logins at `account.arcade.dev`, and the demo's
identity story becomes "our personas are Arcade users" — the opposite of the claim
the demo makes.

## Question 3 — hop 2, the tool's own OAuth, and how many times Dana logs in

**Unverified against the live services; the mechanism that decides it is measured
against a local `apps/idp`.**

Unverified because hop 1 does not complete: no gateway token, so no `tools/call`,
so no tool authorization is ever triggered. `05-verifier-flow.ts` walks hop 2 with
the same cookie jar the moment hop 1 yields a token, and prints which hosts
rendered pages and which domains the jar holds. The measurement is written and
waiting on the token exchange.

What **is** measured is how `apps/idp` behaves on a second authorization for the
same person:

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

Confirmed on the **live** IdP too: Dana's second run through hop 1, at 14:29:47Z,
rendered one page rather than two, because her consent from 14:24Z was on record.

So the expected shape for a persona's first use, **as an expectation and not a
measurement**: two authorizations against one IdP session — `login` + `consent` for
the gateway, then nothing or a single `consent` for the tool, because Better Auth
holds the session cookie on `cg-idp-or5b.onrender.com` and both authorizations go
to that host. The thing that would break it is the tool's `cg-idp` **auth
provider** being a different OAuth client at the IdP from the one the **User
Source** uses: consent is per client, so a second client means a second consent.
`apps/idp` has only one client today, so today they are the same one. Check it
when hop 2 first runs.

## Question 4 — the join key: `user_id` on the `/pre` frame

**Unverified.** No tool call completed, so no `/pre` frame exists to read. Same gap
spike 04 left, one step further along the chain.

The expectation is unchanged — lowercase `dana.okafor@…` — and the chain now
supports it concretely rather than by hope: the User Source's subject claim is
`email`, `apps/idp` puts `email` lowercased on the ID token
(`src/auth.ts:idTokenIdentityClaims`), `/oauth2/userinfo` returns the same string,
and #58 lowercased every holder in both databases. **It is still an expectation.**
DESIGN.md's open risk 4 is precisely that identity splits silently, and nothing
here has yet observed both ends of the join at once. Do not build #14 on it
unmeasured.

## Question 5 — can `apps/web` hold two personas at once?

**Unverified, reasoned from the measured flow.** Yes for tokens, no for browser
sessions, and the work that closes the gap belongs to #14.

Everything interactive in this chain is a cookie. `apps/idp` sets
`better-auth.session_token` on `cg-idp-or5b.onrender.com`, and a browser holds one
per host; a second persona signing in replaces the first. The measured "0 pages on
a second authorization" result is that same stickiness seen from its useful side.

Two consequences, opposite in cost:

**Per-persona browser sessions are not needed.** What `apps/web` holds per persona
is the **gateway access token**, not a browser session. Authorization is
interactive once; after that the MCP client sends a bearer token and the IdP is out
of the loop. Four personas is four stored tokens keyed by persona, the switcher
picks one, and `/pre` sees whichever `user_id` that token carries. No re-login per
switch.

**But the first authorization per persona is interactive and cannot be automated.**
Four real logins at `cg-idp`, rehearsed before the demo, each leaving a token
`apps/web` stores. And `apps/web` on Render cannot use `MCPClient.authenticate()`
to collect them — spike 04 measured the refusal, *"the provider's redirect URL must
be a loopback address"* — so #14 drives `MCPOAuthClientProvider` and takes the
callback on its own route handler.

One thing to carry over if a custom verifier is ever added: **a verifier that reads
"the currently signed-in user" from its own session would collapse all four
personas onto whoever logged in last.** The one built here does not — it starts a
fresh OIDC login per flow and never consults a session of its own. That was not an
accident and it is the property #14 needs.

## Findings

| # | Question | Verdict | Value |
|---|---|---|---|
| 1 | Hop 1 on `cg-demo-us` reaches our IdP | **measured** | Yes, from 2026-09-11 ~14:24Z. Two hops: `cloud.arcade.dev/oauth2/authorize` → `cg-idp-or5b.onrender.com/oauth2/authorize` → our `/login` and `/consent`, a real sign-in |
| 1a | Spike 04's candidate (A), a platform bug | **measured, dead** | The broker does consult the gateway's `user_source_id` and redirects to the configured issuer |
| 1b | What changed to make it work | **unexplained** | Nothing on our side. Verifier never saved, User Source untouched, gateway untouched. 14:15Z `account.arcade.dev`, 14:24Z `cg-idp` |
| 1c | The flow completes | **measured, no** | `error=access_denied`, *"Token exchange with identity provider failed"*, seven times over 17 minutes |
| 1d | Why it fails | **inferred, not measured** | Most likely `client_secret_basic` against a `client_secret_post` registration (#61 item 1). A stale secret is the alternative |
| 1e | Why it could not be measured | **measured** | `apps/idp` emits no request log lines at all — only boot lines. The one line that discriminates does not exist |
| 1f | How the two causes differ, when a log exists | **measured** | **401** = auth-method mismatch; **400** = wrong secret; **200** = the exchange worked and the cause is elsewhere |
| 1g | Whether the live IdP can be probed for it | **measured, no** | It checks the code before the client; a junk code returns `invalid_grant` for every client-auth variant |
| 2 | Hop 1 on `cg-demo` (members mode) | **measured** | Unchanged: five hops to `account.arcade.dev` |
| 2a | Whether the change was project-wide | **measured, no** | `cg-demo` did not move at all while `cg-demo-us` moved completely |
| 3 | Does a custom verifier take part in gateway sign-in | **unverified** | The dashboard setting was never saved. Arcade never called the verifier in five flows' worth of tunnel uptime. Arcade's documentation binds the verifier to a `user_id` *"specified at the start of the authorization flow"*, which a sign-in does not have |
| 3a | The verifier works at all | **measured** | Five complete flows against a real `apps/idp`: OIDC login, `email` off `/oauth2/userinfo`, `confirm_user`, `next_uri` followed |
| 4 | Round trips on a persona's first use | **partly measured** | At `apps/idp`: 2 pages first ever, 1 with consent on record, **0** on a second authorization in the same browser. Live hop 2 unverified — no gateway token to reach it with |
| 5 | `user_id` on the `/pre` frame | **unverified** | No `/pre` frame produced. Expected lowercase `dana.okafor@…` |
| 6 | Two personas at once in `apps/web` | **unverified, reasoned** | Yes for stored gateway tokens, no for browser sessions. First authorization each is interactive and rehearsed |
| 7 | The IdP's redirect-URI allowlist, from outside | **measured** | Readable unauthenticated off the 302 target. The live client allows the User Source's `.../oauth2/intermediate_callback` **and** the auth provider's per-provider `.../api/v1/oauth/<provider-id>/callback`. Both correct |
| 7a | `.env.example`'s documented default | **measured, wrong** | It ships `https://cloud.arcade.dev/api/v1/oauth/callback`, which the live IdP rejects. Arcade's real auth-provider callback carries a per-provider path segment and can only be read off the dashboard |
| 8 | A verifier can be an unattended OAuth client of `apps/idp` | **measured, no** | One client, secret hashed since #70, DCR 403, PKCE-only refused |
| 9 | `apps/idp` renders consent once per client, not per flow | **measured** | Second and later authorizations skip `/consent`. A *different* client id would consent again |

## Confidence

| Claim | |
|---|---|
| `cg-demo-us` sends the persona to `cg-idp-or5b.onrender.com` | ✅ full chain, a real login and a real consent, reproduced all afternoon |
| `cg-demo` still sends the persona to `account.arcade.dev` | ✅ measured after the other gateway had already moved |
| Arcade's broker consults the gateway's `user_source_id` | ✅ it redirects to the configured issuer with the configured client id |
| Nothing on our side caused that change | ✅ the human confirmed the verifier was never saved and the User Source untouched |
| The token exchange fails, and where | ✅ `access_denied` / *"Token exchange with identity provider failed"*, seven times |
| The two candidate causes and how a log tells them apart | ✅ four real codes against a local instance; 401 vs 400 |
| `apps/idp` has no request logging | ✅ the human read the live log: boot lines only |
| `apps/idp` refuses a PKCE-only token request | ✅ exact error text |
| The live allowlist carries both Arcade callbacks | ✅ probed from outside, ALLOWED on both, REJECTED on five decoys |
| Page counts at `apps/idp` for 1st / later / same-session | ✅ three runs, and the live IdP agreed on the second |
| The verifier completes a real flow | ✅ five flows, three personas, `confirm_user` and `next_uri` |
| **Which cause the token exchange failed for** | ⬜ **inferred.** #61's auth-method mismatch is the likelier of two. Needs one log line that does not currently get written |
| **What Arcade changed at ~14:24Z** | ⬜ **unexplained.** Ours to notice, not ours to know |
| **Whether a custom verifier applies to gateway sign-in** | ⬜ **unverified.** The setting was never saved. Arcade's documentation says it applies to tool authorization |
| `user_id` on `/pre` | ⬜ **not measured.** Expectation only |
| Hop 2's real round-trip count | ⬜ **not measured.** Reasoned from `apps/idp`'s consent behaviour |

## Recommendation for #14

**Take (1) User Source, and treat the custom verifier as hop 2's problem, not hop
1's. Contingent on #61.**

The choice #75 was asked to make is between *User Source + custom verifier* and
*members mode + custom verifier*. The measurements collapse it, because the
verifier turns out to be orthogonal to the thing that separates them:

**Hop 1 is decided by the User Source alone, and it now works.** `cg-demo-us`
sends the persona to `cg-idp-or5b.onrender.com`, she signs in and consents at our
IdP, and no Arcade account is involved. `cg-demo` does not and cannot: members
mode is Arcade's account login by construction, so option (2) requires four Arcade
seats and makes the demo's own personas Arcade users. That is the story this demo
exists to contradict — the enterprise's identity provider is supposed to be the
enterprise's. **This is the whole argument, and it does not depend on the
verifier.** The custom verifier was never in either chain.

**What is contingent.** Hop 1 reaches our IdP and then fails at Arcade's token
exchange, so today the User Source is a login that does not produce a token. The
gate is #61: register the `cg-idp` client `client_secret_basic`, reconcile the
existing row, and give `apps/idp` a request log so the next failure of this class
is a measurement instead of a guess. That is a small, well-understood change to a
service we own. **Do not start #14's gateway wiring until `05-verifier-flow.ts`
prints a `user_id` on a `/pre` frame** — one run, about two minutes, and it closes
questions 4 and 5 at once.

**Keep members mode as the fallback, and it is a real one.** If #61 does not fix
the exchange, `cg-demo` works today with four Arcade member accounts. It costs the
identity story, not the governance story: layers 1–4 key off `context.user_id`, and
that is the same lowercase address either way. It is a worse demo, not a broken
one.

**The custom verifier keeps its place, one hop later.** It is what lets a person
who is not an Arcade project member authorize a *tool*, which is exactly what the
personas are once hop 1 stops going through Arcade's accounts. That is the
documented purpose, `evidence/05-verifier.ts` is a working implementation of it
against `apps/idp`, and #14 will need it the moment hop 2 is first exercised. The
one property to preserve when it moves into `apps/web`: it must start a fresh
login per flow rather than read its own session, or the persona switcher can only
ever hold one persona.

**Arcade Headers is not considered.** Spike 04 recommended it on the grounds that
the User Source could not be reached at all. It can now, and the human ruled the
mode out on 2026-09-11 regardless.

## Nothing under `apps/` changed

`git diff --stat main` touches `docs/spikes/` only. The verifier is deliberately
not an app: no database, no tests, no deployment, and it holds a client secret in
its environment. The tunnel and every process this spike started were shut down
before it reported.

**Proposed #14 scope item.** When the custom verifier is needed for tool
authorization, it belongs in `apps/web` as two route handlers — one to start the
check, one to take the IdP's callback — not as a service. It needs the signed-in
persona and the Arcade API key, both of which `apps/web` already holds. Carry over
the fresh-login-per-flow property from `evidence/05-verifier.ts`.

## Follow-ups

- **The token exchange is the only remaining gate on hop 1**, and it is #61's
  first item plus one log line. Not fixed here: it is a change to `apps/idp`, and
  this spike may not make one.
- **`apps/idp` needs request logging.** A service that refuses a request and says
  nothing about it is this project's own failure mode wearing someone else's
  clothes. One line per non-200 at `/oauth2/token`, with the status and the
  `error` field.
- **`.env.example`'s `IDP_OAUTH_REDIRECT_URIS` default is not a real Arcade
  callback.** The auth provider's callback carries a per-provider path segment,
  readable only from the dashboard. The shipped default cannot work, and a forker
  who leaves it alone gets an `invalid_redirect` at a step that fires no hook.
- **The `cg-idp` name is still overloaded** — an auth provider and a User Source,
  same name, same IdP, separate registrations, separate secrets. Spike 04 raised
  it; this spike tripped over it twice.
- **Spike 04's recommendation is superseded.** It chose Arcade Headers because the
  User Source "cannot be reached at all". It can.
