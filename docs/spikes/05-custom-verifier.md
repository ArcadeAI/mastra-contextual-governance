# Spike 05 — does a custom user verifier against `apps/idp` make the gateway log personas in at our IdP?

**Answer: the custom verifier is not what moves that login. The User Source is,
and on 2026-09-11 it started working.**

<!-- PENDING-SUMMARY -->

Resolves [#75](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/75).
Follows [#65](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/65)
([`04-user-source.md`](04-user-source.md)). Feeds the #14 gate. Raw transcripts,
redacted, in [`evidence/05-custom-verifier-transcript.md`](evidence/05-custom-verifier-transcript.md).

Scripts, all discardable, all outside `apps/`:

| | |
|---|---|
| [`evidence/05-verifier.ts`](evidence/05-verifier.ts) | the verifier: binds `:0`, tunnels itself, OIDC against `apps/idp`, `confirm_user` |
| [`evidence/05-verifier-flow.ts`](evidence/05-verifier-flow.ts) | walks a gateway's authorization chain and names the host that rendered every page |
| [`evidence/05-redirect-allowlist.ts`](evidence/05-redirect-allowlist.ts) | reads an OAuth client's redirect-URI allowlist from outside, unauthenticated |
| [`evidence/05-token-auth-methods.ts`](evidence/05-token-auth-methods.ts) | maps `apps/idp`'s token-endpoint refusals to causes |
| [`evidence/05-drive.ts`](evidence/05-drive.ts) | the browserless user agent, carried forward from spike 04 with two fixes |

## What the human has to do, in order

These are #24 material. Steps 1–3 were done during this spike; step 4 is what is
left.

1. **Arcade dashboard → Auth → Settings → custom verifier route.** Set it to the
   verifier's public `/verify` URL. `05-verifier.ts` prints the exact string at
   startup.
2. **`IDP_OAUTH_REDIRECT_URIS` on the `cg-idp` Render service.** Append the
   verifier's public `/callback` URL, keeping every existing entry. The client id
   and secret do not change; the client is updated in place at the next boot.
   `05-redirect-allowlist.ts` verifies the change landed, without the dashboard
   and without a secret.
3. **Arcade dashboard → User Sources → `cg-idp`.** Issuer
   `https://cg-idp-or5b.onrender.com`, client id off the IdP's public `/health`,
   subject claim `email`, scopes `openid profile email`. The client **secret** has
   to be the current one: `apps/idp` stores it hashed since #70, so if nobody
   wrote it down, `bun run oauth-client --rotate` on the `cg-idp` Render shell
   mints a new one under the same client id — and it then has to go into **both**
   the User Source and the `cg-idp` auth provider, which are two separate
   registrations that happen to share a name.
4. **Put the `cg-idp` auth provider's Redirect URL back on the IdP's allowlist.**
   Measured: the live IdP allows `https://cloud.arcade.dev/oauth2/intermediate_callback`
   — the **User Source** callback — and **rejects**
   `https://cloud.arcade.dev/api/v1/oauth/callback`, which is what `.env.example`
   ships as the value of this very variable and what `apps/idp/src/config.ts`
   carries as `DEFAULT_ARCADE_REDIRECT_URI` for the **auth provider** the loan
   tools use. `IDP_OAUTH_REDIRECT_URIS` takes a comma-separated list, and the live
   service needs **both**. As it stands, wiring the User Source appears to have
   replaced the entry rather than added to it. A tool-level authorization against
   that provider would die at our own IdP, at a step that fires no hook and shows
   nothing on the panel — DESIGN.md's open risk 2 exactly.

## Setup

| | |
|---|---|
| IdP | `https://cg-idp-or5b.onrender.com` — `apps/idp` on Render, after #70. RS256, `jwks_uri`, `email` on the ID token, PKCE S256 required, `client_secret_post` |
| IdP OAuth client | one, `RskTFjl6AqkUO8FKYWjpDCLd139YE36F`, published on `/health`. Secret stored hashed; `/oauth2/register` returns 403 |
| User Source | `cg-idp`, `us_3JA8GcvHfT17WNnnRazx6FZpxeg`, attached to `cg-demo-us` and published in its protected-resource document |
| Gateway under test | `cg-demo-us` → `https://api.arcade.dev/mcp/cg-demo-us` |
| Control gateway | `cg-demo` → `https://api.arcade.dev/mcp/cg-demo`, "Members of this Project" mode |
| Verifier | local Bun server on a port it binds as `:0`, behind `ngrok`; never deployed |
| Control plane | `https://cg-hooks.onrender.com/events`, unauthenticated SSE, `last-event-id: 0` replays (#62) |
| Personas | Dana, Sam, Riley, Morgan; passwords from `apps/idp/src/fixtures/people.json`, addresses only in Render env |
| Client | raw `fetch` with a cookie jar. No browser, and no credential provisioned by the implementer |

## Before anything else: the verifier needs a client secret, and it cannot be read back

This is the first thing #75 hit and it is worth stating plainly, because it is a
constraint on anything that ever wants to be an OAuth client of `apps/idp`.

`apps/idp` registers **exactly one** OAuth client, confidential,
`client_secret_post`, and since #70 stores the secret **hashed** — readable only
by the run that created or rotated it. Dynamic client registration is off by
design (`allowDynamicClientRegistration: false`), so a verifier cannot mint its
own. And there is no PKCE-only path around it; measured against a local instance
of the same code:

```
no client_secret (PKCE only) -> 400 {"error":"invalid_client",
  "error_description":"client registered for client_secret_post cannot use none"}
```

So the verifier was proven against a **local** `apps/idp` whose client this spike
minted and therefore holds the secret for. That is not a compromise on the
verifier's own contract — it is the same code as `cg-idp`, doing a real
authorization-code login for a real seeded persona — but it does bound what
question 3 could be asked to answer. Said again under that question.

## Question 1 — hop 1 on the User Source gateway: where does the persona log in?

**Measured, and the answer changed under this spike.** As of 2026-09-11 the
persona logs in at **`cg-idp-or5b.onrender.com`**, our own IdP. The custom
verifier is not in the chain.

The control, re-measured at 14:15Z on the same day — five hops to Arcade's own
account login, exactly what spike 04 reported a week earlier:

```
302 GET https://cloud.arcade.dev/oauth2/authorize
302 GET https://auth.arcade.dev/oauth2/auth
303 GET https://auth.arcade.dev/ui/login
303 GET https://auth.arcade.dev/self-service/login/browser
200 GET https://account.arcade.dev/login          ← page 1, Arcade's
```

The same gateway at 14:24Z — two hops, and the page is ours:

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

`auth.arcade.dev` and `account.arcade.dev` are gone from the chain entirely.
**Spike 04's candidate (A) — "Arcade's broker ignores the gateway's
`user_source_id` at the authorize step, a platform bug" — is dead.** The broker
consults it and redirects to the configured issuer. Candidate (B) was the right
one.

### …and then the token exchange fails

The flow does not complete. Arcade takes the code and comes back with:

```
http://localhost:57503/callback
  ?error=access_denied
  &error_description=Token+exchange+with+identity+provider+failed
  &iss=https%3A%2F%2Fcloud.arcade.dev%2Foauth2
```

Reproduced twice, 14:24:07Z and 14:29:47Z. The persona authenticates at our IdP,
consents, and Arcade cannot trade the code for a token. That is Arcade's side of
the OIDC client contract, and from outside it has exactly two candidate causes.
`apps/idp` separates them cleanly, and **by status code alone**:

| What Arcade sent to `/oauth2/token` | Response |
|---|---|
| `client_secret_post`, correct secret | **200**, a token |
| `client_secret_post`, wrong secret | **400** `invalid_client` / *"invalid client_secret"* |
| `client_secret_basic`, correct secret | **401** `invalid_client` / *"client registered for `client_secret_post` cannot use `client_secret_basic`"* |
| no client authentication | **400** `invalid_client` / *"client registered for `client_secret_post` cannot use none"* |

400 means the secret in the User Source is stale — re-enter it. 401 means Arcade
prefers the `Authorization: Basic` header and our client is registered for the
form field, which is [#61](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/61)'s
first item and **re-entering the secret would not help**. One line of the `cg-idp`
Render log settles it.

Note that the **live** IdP cannot be asked this question directly: it validates
the authorization code before the client, so a probe with a junk code returns
`invalid_grant / invalid code` whether it carries no secret, a wrong secret or
Basic auth. `05-token-auth-methods.ts` therefore runs against a local instance,
with four real single-use codes.

<!-- PENDING-Q1-CAUSE -->

## Question 2 — hop 1 on the members-mode gateway `cg-demo`

**Measured. Unchanged, and a custom verifier does not touch it.**

At 14:26:13Z, after the User Source gateway had already moved:

```
302 GET https://cloud.arcade.dev/oauth2/authorize
302 GET https://auth.arcade.dev/oauth2/auth
303 GET https://auth.arcade.dev/ui/login
303 GET https://auth.arcade.dev/self-service/login/browser
200 GET https://account.arcade.dev/login
```

Byte for byte the control. `cg-demo` publishes no `urn:arcade:oauth:user_source_id`,
and its sign-in is Arcade's own account login. **Whatever changed was scoped to the
User Source, not to the project**, which is itself the cleanest evidence that a
project-level setting — and the custom verifier is a project-level setting — is
not what moved question 1.

So members mode means every persona needs an Arcade account that is a member of
the project. Arcade's own documentation says so:

> each end user [must] sign in to an Arcade account that is a member of your project

Four rehearsed logins at `account.arcade.dev`, four Arcade seats, and the demo's
identity story becomes "our personas are Arcade users", which is the opposite of
the claim the demo is making.

## Question 3 — hop 2, the tool's own OAuth, and how many times Dana logs in

**Unverified against the live services, and partly measured against a local
`apps/idp`.**

It is unverified because hop 1 does not complete: without a gateway token there
is no `tools/call`, so no tool authorization is ever triggered. `05-verifier-flow.ts`
walks hop 2 with the same cookie jar the moment hop 1 yields a token, and prints
which hosts rendered pages and which domains the jar holds — the measurement is
written and waiting for the token exchange to be fixed.

What **is** measured, against a local `apps/idp`, is the thing that decides the
answer: how `apps/idp` behaves on a second authorization for the same person.

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

Confirmed independently on the **live** IdP at 14:29:47Z: Dana's second run
through hop 1 rendered one page, not two, because her consent from 14:24Z was on
record. Consent persists; the session cookie did not, only because each run used
a fresh jar.

So the expected shape for a persona's first use, **stated as an expectation and
not as a measurement**: two authorizations against one IdP session, `login` +
`consent` for the gateway, then `consent` alone or nothing at all for the tool,
because Better Auth holds the session cookie on `cg-idp-or5b.onrender.com` and
both authorizations go to that host. The thing that would break it is the tool's
`cg-idp` **auth provider** being a different OAuth client at the IdP from the one
the **User Source** uses — a second client means a second consent, since consent
is per client. That is worth checking when hop 2 is first run.

## Question 4 — the join key: `user_id` on the `/pre` frame

**Unverified.** No tool call completed, so no `/pre` frame exists to read. This is
the same gap spike 04 left and for the same reason, one step further along.

The expectation, unchanged: lowercase `dana.okafor@…`. The chain now supports it
concretely rather than by hope — the User Source's subject claim is `email`, the
ID token carries `email` lowercased (`apps/idp/src/auth.ts:idTokenIdentityClaims`),
`/oauth2/userinfo` returns the same string, and #58 lowercased every holder in
both databases. **It is still an expectation.** DESIGN.md's open risk 4 is exactly
that identity splits silently, and nothing here has yet observed both ends of the
join at once. Do not build #14 on it unmeasured.

## Question 5 — can `apps/web` hold two personas at once?

**Unverified, reasoned from the measured flow, and the answer is no — not without
work that belongs to #14.**

Everything in the chain is a cookie. `apps/idp` sets `better-auth.session_token`
on `cg-idp-or5b.onrender.com`; a browser holds one per host. A second persona
signing in replaces the first. The measured "0 pages on the second authorization"
result is the same mechanism seen from the useful side: it is silent *because*
the session is sticky, and sticky is exactly what a persona switcher cannot have.

Two things follow, and they are opposite in cost.

**Per-persona browser sessions are not required.** What `apps/web` needs to hold
per persona is the **gateway access token**, not a browser session. The
authorization is interactive once; after that the MCP client sends a bearer token
and the IdP is not in the loop. Four personas means four stored tokens, keyed by
persona, and the switcher picks one. `/pre` sees whichever `user_id` that token
carries. No re-login per switch.

**But the first authorization per persona is interactive, and cannot be
automated.** Four personas is four real logins at `cg-idp`, rehearsed before the
demo, each leaving a token `apps/web` stores. And `apps/web` on Render cannot use
`MCPClient.authenticate()` to get them — spike 04 measured the refusal, *"the
provider's redirect URL must be a loopback address"* — so #14 has to drive
`MCPOAuthClientProvider` and take the callback on its own route handler.

The interaction with the verifier, if a custom verifier ever does enter this
chain: a verifier that reads "the currently signed-in user" from **its own**
session would collapse all four personas onto whoever logged in last. The version
built here does not: it starts a fresh OIDC login per flow and never consults a
prior session of its own. That is the right shape for a persona switcher and it
was not an accident.

## Findings

| # | Question | Verdict | Value |
|---|---|---|---|
| 1 | Hop 1 on `cg-demo-us` reaches our IdP | **measured** | Yes, from 2026-09-11 ~14:24Z. Two hops: `cloud.arcade.dev/oauth2/authorize` → `cg-idp-or5b.onrender.com/oauth2/authorize` → our `/login` and `/consent` |
| 1a | Spike 04's candidate (A), a platform bug | **measured, dead** | The broker does consult the gateway's `user_source_id`; it redirects to the configured issuer |
| 1b | The flow completes | **measured, no** | `error=access_denied`, *"Token exchange with identity provider failed"*, twice |
| 1c | What that error can mean | **measured** | Two causes, separable by status: **401** = `client_secret_basic` against a `client_secret_post` registration (#61 item 1); **400** = wrong secret |
| 1d | Whether the live IdP can be probed for it | **measured, no** | It checks the code before the client; a junk code returns `invalid_grant` for every client-auth variant |
| 2 | Hop 1 on `cg-demo` (members mode) | **measured** | Unchanged: five hops to `account.arcade.dev`. No custom verifier appears |
| 2a | Whether the change was project-wide | **measured, no** | `cg-demo` moved not at all while `cg-demo-us` moved completely |
| 3 | Round trips on a persona's first use | **partly measured** | At `apps/idp`: 2 pages first ever, 1 page with consent on record, **0** on a second authorization in the same browser. Live hop 2 unverified — no gateway token to reach it with |
| 4 | `user_id` on the `/pre` frame | **unverified** | No `/pre` frame produced. Expected lowercase `dana.okafor@…` |
| 5 | Two personas at once in `apps/web` | **unverified, reasoned** | Yes for tokens, no for browser sessions. Store gateway tokens per persona; the first authorization each is interactive and rehearsed |
| 6 | The IdP's redirect-URI allowlist, from outside | **measured** | Allows `.../oauth2/intermediate_callback`, rejects `.../api/v1/oauth/callback` — which is the value `.env.example` ships. Readable unauthenticated off the 302 target |
| 7 | A verifier can be an OAuth client of `apps/idp` unattended | **measured, no** | One client, secret hashed since #70, DCR 403, and PKCE-only is refused: *"client registered for `client_secret_post` cannot use none"* |
| 8 | `apps/idp` renders consent once per client, not once per flow | **measured** | Second and later authorizations skip `/consent`; a *different* client id would consent again |

## Confidence

| Claim | |
|---|---|
| `cg-demo-us` sends the persona to `cg-idp-or5b.onrender.com` | ✅ full chain, twice, a real login and a real consent |
| `cg-demo` still sends the persona to `account.arcade.dev` | ✅ measured after the other gateway had already moved |
| Arcade's broker consults the gateway's `user_source_id` | ✅ it redirects to the configured issuer with the configured client id |
| The token exchange fails, and where | ✅ `access_denied` / *"Token exchange with identity provider failed"*, reproduced |
| The two causes and how to tell them apart | ✅ four real codes against a local instance; 401 vs 400 |
| The live IdP cannot be probed for the cause | ✅ junk code returns `invalid_grant` for every variant |
| `apps/idp` refuses a PKCE-only token request | ✅ exact error text |
| The IdP's allowlist rejects the auth-provider callback | ✅ `invalid_redirect` on five variants, allowed on one |
| Page counts at `apps/idp` for 1st / later / same-session | ✅ three runs, and the live IdP agreed on the second |
| **Whether a custom verifier participates in gateway sign-in** | ⬜ the verifier was tunnelled and reachable and Arcade never called it. Whether that is because it does not apply to gateway sign-in, or because the dashboard setting was not saved in time, is not separable from outside |
| **Which of the two causes the token exchange failed for** | ⬜ needs one line of the `cg-idp` Render log |
| `user_id` on `/pre` | ⬜ not measured. Expectation only |
| Hop 2's real round-trip count | ⬜ not measured. Reasoned from `apps/idp`'s consent behaviour |

## Recommendation for #14

**(1) User Source, and drop the custom verifier from the plan for now.**

<!-- PENDING-RECOMMENDATION -->

## Nothing under `apps/` changed

`git diff --stat main` touches `docs/spikes/` only. The verifier is deliberately
not an app: it has no database, no tests, no deployment, and it holds a client
secret in its environment.

**Proposed #14 scope item, if a custom verifier is ever needed** (for tool
authorization, not for gateway sign-in): it belongs in `apps/web` as a route
handler, not as a service. It needs the signed-in persona and the Arcade API key,
both of which `apps/web` already has to hold, and the shape is two handlers —
`/api/arcade/verify` to start the check and `/api/arcade/verify/callback` to
finish it. The thing to carry over from here is that it must **not** read "the
current user" from a session of its own if the persona switcher is to hold more
than one persona at a time.

## Follow-ups

- **The token exchange is the whole remaining gate on hop 1**, and it is one line
  of a Render log away from a fix. Filed as a follow-up on #75 rather than fixed
  here: if it is 401, it is #61's first item and it is a change to `apps/idp`,
  which this spike may not make.
- **`IDP_OAUTH_REDIRECT_URIS` on the live service has lost the auth provider's
  callback.** It allowlists the User Source's and rejects the one `.env.example`
  documents. The variable is a list; it needs both. That is a layer-2 failure,
  which DESIGN.md open risk 2 says fires no hook and shows nothing on the panel.
- **The `cg-idp` name is still overloaded** — an auth provider and a User Source,
  same name, same IdP, separate registrations, separate secrets. Spike 04 raised
  it; this spike tripped over it twice.
- **Spike 04's recommendation is superseded.** It chose Arcade Headers on the
  grounds that the User Source "cannot be reached at all". It can now.
