# Spike 05 — one tool call as Dana: the User Source at hop 1, the custom verifier at hop 2

**Status: hop 1 completes. Hop 2's verification works; its token exchange does not, yet.**

This spike is about **one full tool call as Dana through `cg-demo-us`, with a
`/pre` payload carrying `user_id` = her lowercase email.** That call has not
happened. What did happen is that every step before it is now measured, and the
gap is one field wide.

Getting there crosses two hops, governed by two different mechanisms that round 1
of this spike ran together:

| | Hop | Mechanism | Where it stands |
|---|---|---|---|
| **1** | MCP client → gateway `cg-demo-us` | **User Source** `cg-idp` | **measured, and it works.** Dana signs in at our IdP, Arcade issues a gateway token, eight tools list, and every `/access` frame carries her lowercase email. #61 was the fix |
| **2** | tool-level OAuth, `cg-idp` auth provider | **custom user verifier** | **measured up to Arcade's default verifier.** The IdP session is reused silently; Arcade then routes to `callback_verify`, which without a custom route sends the persona to `account.arcade.dev`. What a *saved* route does is still unmeasured |

Round 1 asked whether a custom verifier moves the *hop 1* login. That question is
answered — it does not, the User Source does — and it was the wrong question. A
verifier is what lets someone who is **not an Arcade project member** authorize a
*tool*. Hop 2's chain now shows that is exactly what our personas are:

> ```
> 302 → cloud.arcade.dev/api/v1/oauth/<provider-id>/callback
> 303 → cloud.arcade.dev/api/v1/oauth/callback_verify?flow_id=4bb88623-…
> 303 → auth.arcade.dev/self-service/login/browser
> 303 → account.arcade.dev/login          ← Arcade's account wall
> ```

**`callback_verify` is the verifier's hook point**, and the `flow_id` a custom
verifier is documented to receive is already on its query string. **A User Source
persona does not bypass it**: hop 1's identity does not carry into hop 2 at all.
That settles the question this document previously left open as "the verifier may
turn out to be unnecessary" — it is necessary, and it is load-bearing for #14.

What is left is narrow and one run away:

- **H2-a** — with the route saved, does `callback_verify` redirect to the verifier
  instead of to `account.arcade.dev`? **Unmeasured.** The route has never been saved.
- **H2-b** — does `confirm_user` complete the flow and let the tool call through?
  **Unmeasured.**
- **H2-c** — is `context.user_id` on the `/pre` payload the exact lowercase email
  the verifier confirmed? **Unmeasured.** `/access` already carries it; `/pre` needs
  the tool to actually run.
- **H2-d** — a second persona without logging the first out? **Unmeasured.**

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

These are #24 material. Steps 1–2 are **done** and recorded so a forker knows they
are required; 3–5 are the sitting this spike is waiting for.

1. ~~**Land #61 (PR #78) and register the `cg-idp` client `client_secret_basic`.**~~
   **Done, `aa98780`.** `/health` on the live IdP now reports
   `token_endpoint_auth_method: "client_secret_basic"` with
   `client_secret_state: "unchanged"`, and hop 1's token exchange succeeds. The
   auth-method mismatch was the cause, and it is now measured rather than inferred.
2. ~~**Flip the `cg-idp` auth provider to `client_secret_basic` in the dashboard.**~~
   **Done.** Hop 2's authorize reaches our IdP and returns a code.
3. **Arcade dashboard → Auth → Settings → Custom verifier route.** Paste the tunnel
   URL `05-verifier.ts` prints at startup. **This has never been set**, and it is
   the only reason H2-a–d are unmeasured.
4. **`IDP_OAUTH_REDIRECT_URIS` on the `cg-idp` Render service.** Append the
   verifier's `/callback`, keeping every existing entry — the list already carries
   the User Source's `.../oauth2/intermediate_callback` and the auth provider's
   per-provider `.../api/v1/oauth/<provider-id>/callback`, and both must survive.
   `evidence/05-redirect-allowlist.ts <url>` confirms the change landed without
   opening the dashboard.
5. **Write `docs/spikes/evidence/.env.local`** with `IDP_CLIENT_ID` and
   `IDP_CLIENT_SECRET`. Gitignored at any depth; the verifier re-reads it per flow,
   so no restart and no change to the URL already pasted in step 3.

**Worth raising with Arcade while you are in there.** Hop 1 now renders Arcade's own
gateway consent screen at `cloud.arcade.dev/oauth2/consent` — *"Authorize access /
Allow this application to access your **Arcade.dev account**?"* — to a persona who
has just signed in at the bank's IdP. One extra click per persona per MCP client, and
the wording undercuts the claim the demo is making. Arcade documents an allowlist of
MCP client IDs that bypasses that screen. Not blocking; #24 material.

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

## Hop 1 — the User Source. Measured, and it works

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

### …and until #61, the token exchange failed

Between 14:24Z and 14:41Z, seven runs, Arcade took the authorization code and
answered:

```
?error=access_denied
&error_description=Token+exchange+with+identity+provider+failed
```

Two candidate causes, separable **by status code alone** — four real single-use
codes against a throwaway instance `05-token-auth-methods.ts` boots itself:

| What Arcade sent to `/oauth2/token` | Response |
|---|---|
| `client_secret_post`, correct secret | **200**, a token |
| `client_secret_post`, wrong secret | **400** `invalid_client` / *"invalid client_secret"* |
| `client_secret_basic`, correct secret | **401** `invalid_client` / *"client registered for `client_secret_post` cannot use `client_secret_basic`"* |
| no client authentication | **400** `invalid_client` / *"client registered for `client_secret_post` cannot use none"* |

The `cg-idp` Render log could not say which, because `apps/idp` logs its boot and
nothing else — a finding in its own right, and still open. So the cause was
**inferred**: Arcade sends `client_secret_basic` and the client was registered
`client_secret_post`, which is [#61](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/61)'s
first item.

### …and with #61 it succeeds

`aa98780` registered the client `client_secret_basic`, the live IdP redeployed, and
at 15:25:40Z the same script as Dana:

```
302 GET  https://cloud.arcade.dev/oauth2/authorize
302 GET  https://cg-idp-or5b.onrender.com/oauth2/authorize
200 GET  https://cg-idp-or5b.onrender.com/login                  ← page 1, ours
303 POST https://cg-idp-or5b.onrender.com/login                  ← Dana signs in
200 GET  https://cloud.arcade.dev/oauth2/intermediate_callback   ← page 2, Arcade's
303 POST https://cloud.arcade.dev/oauth2/consent
→ callback: code, iss, state — state matches, no error
token exchange -> 200  {"access_token":"<redacted>","expires_in":900,
                        "refresh_token":"<redacted>","scope":"mcp offline_access"}
```

**The inference is now a measurement.** Nothing else changed between the failing
and succeeding runs.

`tools/list` returns the eight tools the gateway carries:

```
System_ManageAuthorization  Arcade_ListApps
Loan_GetLoan  Loan_SearchLoans  Loan_ApproveLoan  Loan_DenyLoan
Approvals_RequestApproval  Approvals_Decide
```

### The second page is Arcade's, and it is new

`cloud.arcade.dev/oauth2/intermediate_callback` used to be a redirect. It now
renders a consent screen — *"Authorize access. Allow this application to access
your Arcade.dev account?"*, the MCP client's name, a Development Mode warning
because the redirect is a loopback, and one form:

```html
<form method="POST" action="/oauth2/consent">
  <input type="hidden" name="flow_state" value="…" />
  <button type="submit" name="action" value="deny">Deny</button>
  <button type="submit" name="action" value="allow">Allow</button>
</form>
```

Two consequences for the demo. It is **one extra click per persona per MCP client**.
And it says *"your Arcade.dev account"* to someone who just authenticated at the
bank's IdP, which is precisely the sentence this demo exists to make untrue. Arcade
documents an MCP-client-ID allowlist that skips it; worth asking for on #24.

### The join key, measured

**This is DESIGN.md's third identity rule, observed rather than expected.** That
`tools/list` produced **8278 `/access` frames** on `cg-hooks` — Arcade evaluates the
access hook against its whole tool catalogue — and every single one carries:

```
user_id = dana.okafor@…      (exact, lowercase)
```

The six gateway tools `allow`; everything else `deny`. Arcade's `user_id` is
byte-equal to the address `apps/idp` holds and to the one `loans.db` will record.
**This is layer 1, not layer 3** — `/pre` needs the tool to actually execute, and
hop 2 is what stands between here and there.

## Hop 2 — the custom verifier. Measured up to Arcade's default

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

### Without a custom verifier: Arcade's account wall

Measured 15:29:21Z, before the route was saved. `Loan_GetLoan` for `LN-2291` returns
`isError: true` and a text block whose body is JSON — `{authorization_url,
llm_instructions, message}`. Walking that URL **with the same cookie jar hop 1
used**:

```
GET  https://cg-idp-or5b.onrender.com/oauth2/authorize
       ?client_id=RskTFjl6…&scope=openid+email&state=…
       &redirect_uri=…%2Fapi%2Fv1%2Foauth%2F<provider-id>%2Fcallback   (PKCE S256)
302 → https://cloud.arcade.dev/api/v1/oauth/<provider-id>/callback?code=<redacted>&…
303 → https://cloud.arcade.dev/api/v1/oauth/callback_verify?flow_id=…
303 → https://auth.arcade.dev/self-service/login/browser
303 → https://account.arcade.dev/login          ← Arcade's account wall
```

**`callback_verify` is the verifier's hook point, and a User Source persona does not
bypass it.** Hop 1's identity does not carry into hop 2's tool authorization. The
verifier is not optional scaffolding a User Source makes redundant; it is
load-bearing.

### With the route saved: Arcade calls the verifier

**H2-a — measured, yes.** Repeatedly, from 16:08Z onward. `callback_verify` and
`account.arcade.dev` disappear from the chain entirely:

```
302 GET  https://cg-idp-or5b.onrender.com/oauth2/authorize
303 GET  https://cloud.arcade.dev/api/v1/oauth/<provider-id>/callback
303 GET  https://<tunnel>/verify?flow_id=9d80728c-…          ← ours
302 GET  https://cg-idp-or5b.onrender.com/oauth2/authorize   ← the verifier's own leg
303 GET  https://<tunnel>/callback
200 GET  https://cloud.arcade.dev/api/v1/oauth/callback_success
```

**Arcade sends exactly one parameter.** The verifier records the whole query string
rather than picking out the field it expected, and the record is:

```
[verifier] GET /verify — Arcade sent 1 parameter(s) {"flow_id":"9d80728c-4b82-46c6-9784-8c22fd4da762"}
```

No user hint, no provider, no return URL. A verifier gets a `flow_id` and must
establish identity entirely on its own — which is exactly why it must not read a
session of its own if the caller runs a persona switcher.

**The persona is not asked to log in again.** Line 4 above is a bare `302`: hop 1's
IdP session is still live, so the verifier's own authorization-code + PKCE login
completes silently. Dana authenticates **once**, at hop 1.

**And it binds the identity our IdP asserts.** The full verifier log for one flow:

```
[verifier] GET /verify — Arcade sent 1 parameter(s) {"flow_id":"9d80728c-…"}
[verifier] 303 to the IdP for flow 9d80728c-…
[verifier] IdP token exchange, client_secret_basic -> 200 {"access_token":"<redacted>",…}
[verifier] IdP /oauth2/userinfo -> 200 {"sub":"9d8c2228-…","email":"dana.okafor@…"}
[verifier] POST confirm_user -> 200
             {"auth_id":"ar_3JBpvQoFcPv8Pyb1mgAuz5smr8B",
              "next_uri":"https://cloud.arcade.dev/api/v1/oauth/callback_success"}
```

`confirm_user` returned **200, not `user_mismatch`**, for the address our IdP put on
`/oauth2/userinfo`. That is the direct answer to a question raised during the
sitting: with Arcade's *default* verifier the binding follows whichever Arcade
account the browser is signed into; with a custom verifier there is no Arcade
account in the chain at all, and the only identity available is the one
`confirm_user` is handed.

Note `sub` there is an opaque uuid. If the User Source were keyed on `sub` instead
of `email`, that uuid is the string Arcade would hold and the panel would show —
DESIGN.md's open risk 4 in one line.

### …and the grant still does not store

**H2-b — half measured.** The *verification* half is complete and correct: Arcade
called the verifier, the verifier proved who the persona was, `confirm_user`
accepted it, and the browser reached `callback_success` with a 200. The *token*
half fails. Retrying `Loan_GetLoan` immediately afterwards — and again in a
completely fresh MCP session with a fresh gateway token — returns `isError: true`
with a brand-new `authorization_url` every time.

What sits between those two is Arcade exchanging, at our IdP, the code it took at
its own provider callback. #61's token logging caught it:

```
2026-09-11T16:35:45.537Z [idp] POST /oauth2/token rejected: status=400
  error=invalid_grant error_description="invalid code"
  client_auth="client_secret_post" client_id=RskTFjl6AqkUO8FKYWjpDCLd139YE36F
```

Read `client_auth="client_secret_post"`. That is not the verifier — the verifier is
in the same window sending `client_secret_basic` and getting 200. It is **Arcade's
`cg-idp` auth provider**, still putting the secret in the body after #61 registered
that client `client_secret_basic`. It could not have succeeded with any code. The
`invalid_grant` in front of it hides the method problem, because the IdP validates
the code before the client (finding 1g).

**The dashboard said otherwise, and that is a finding.** The provider's
Authentication Method dropdown read *"Client Secret Basic"*, greyed out, with the
tooltip *"Currently, client secret basic is the only supported authentication
method."* Underneath, its Token Settings and Refresh Token Settings each carried
Request Parameters rows `client_id={{client_id}}` and `client_secret={{client_secret}}`
— left over from the #13 sitting's template — and **those rows are what decided the
wire behaviour**. A control that reports itself as one thing and does another, in
the console this demo depends on, is precisely the failure mode this project exists
to keep out.

Removing the rows did not switch it to a Basic header. It made the provider send
**no client credentials at all**:

```
2026-09-11T16:48:41.847Z [idp] POST /oauth2/token rejected: status=400
  error=invalid_request error_description="client_id is required"
  client_auth="absent" client_id=(not the registered client)
```

### Reading the configuration back beats reading the console

Two dashboard errors in one evening, both found in seconds by asking Arcade's admin
API what it had actually stored. `evidence/05-auth-provider-config.ts` does that,
read-only, with every secret-shaped value scrubbed before it reaches a terminal. It
is the cheapest thing this spike produced and the one worth keeping.

The **pre-existing** provider, created 2026-09-10, stored this:

```json
"token_request": {
  "endpoint": "https://cg-idp-or5b.onrender.com/oauth2/token",
  "method": "POST",
  "params": { "grant_type": "authorization_code", "redirect_uri": "{{redirect_uri}}" },
  "request_content_type": "application/x-www-form-urlencoded"
}
```

**No `auth_method` field at all** — while the sibling `user_info_request` block has
one (`"auth_method": "bearer_access_token"`), so the concept exists in the schema
and was simply absent here. For that record, the only path to the token endpoint
was `params`, which is `client_secret_post` by construction.

A provider **recreated the same evening** stores something different:

```json
"token_request": {
  "endpoint": "https://cg-idp-or5b.onrender.com/oauth2/token",
  "method": "POST",
  "auth_method": "client_secret_basic",
  "params": { "client_id": "{{client_id}}", "client_secret": "<redacted>",
              "grant_type": "authorization_code", "redirect_uri": "{{redirect_uri}}" }
}
```

`auth_method: "client_secret_basic"` is present. **So the incompatibility this spike
first reported — that an Arcade auth provider can only ever send credentials in the
body, and therefore cannot share one IdP client with a User Source — is a property
of the older record, not of Arcade.** That correction matters enough to state
plainly: an earlier draft of this document recommended `apps/idp` mint one OAuth
client per relying party on the strength of the first reading. See
[the one-client problem](#the-one-client-problem) for what survives of it.

Recreating also rotated the provider's callback path, from
`.../api/v1/oauth/f4c6b_ap_GvSAhPpynQRj/callback` to
`.../api/v1/oauth/f4c6b_ap_1cWxRQzV98W4/callback`. **A provider recreate invalidates
the redirect URI allowlisted at the IdP**, which is a step for #24's runbook and a
failure that fires no hook if missed.

The recreated provider then failed one step earlier still, on a misfiled field —
its Client ID held the token endpoint URL:

```
"client_id": "https://cg-idp-or5b.onrender.com/oauth2/token"

GET  cg-idp-or5b/oauth2/authorize?client_id=https%3A%2F%2F…%2Foauth2%2Ftoken
302 → cg-idp-or5b/error?error=invalid_client&error_description=client_id+is+required
```

**So H2-c and H2-d are unmeasured, and `/pre` has never fired for a loan tool.**
A layer-2 refusal produces no hook — DESIGN.md's open risk 2, met again — so the
control plane shows nothing at all for any of this. Only `/access` frames exist.

### How many pages a persona sees, at our IdP

Measured, and it bounds the demo's rehearsal cost whatever Arcade does at
`callback_verify`:

| Run | Persona state | Pages rendered |
|---|---|---:|
| First ever authorization | no session, no prior consent | **2** — `/login`, then `/consent` |
| Later authorization, new browser | no session, consent on record | **1** — `/login` |
| Second authorization, same browser | live session, consent on record | **0** — entirely silent |

Two flows back to back through one cookie jar, against a local instance:

```
== flow spike75-riley-a: pagesShown=2 pageHosts=["localhost:4423","localhost:4423"]
== flow spike75-riley-b: pagesShown=0 pageHosts=[]
```

and the live IdP agrees — hop 2's authorize at 15:29Z rendered **0** pages, reusing
hop 1's session. The reason it works is that the User Source and the auth provider
are configured against the **same** OAuth client at `apps/idp`: consent is per
client, so one consent covers both. That is luck rather than design, and the next
section says why it is also a problem.

## The one-client problem

`apps/idp` registers **exactly one** OAuth client, confidential, secret stored
hashed since #70, with dynamic client registration off by design
(`POST /oauth2/register` → 403). Measured: there is no PKCE-only path around the
secret —

```
no client_secret (PKCE only) -> 400 {"error":"invalid_client",
  "error_description":"client registered for client_secret_post cannot use none"}
```

Three relying parties want to be that client: the **User Source**, the **auth
provider**, and the **verifier** (later, `apps/web`). What that costs, measured
rather than argued:

- **One client has one auth method, and `apps/idp` refuses the other outright.**
  #61 registered it `client_secret_basic` to fix hop 1. Within the hour the verifier
  — pointed at the same client — was refused: *"client registered for
  `client_secret_basic` cannot use `client_secret_post`"*. Fixed by having the
  verifier read the method off the IdP's `/health` rather than assume one.
- **One client has one secret, readable once.** It was rotated during this sitting,
  which meant re-entering it in the User Source *and* the auth provider by hand, and
  a registration that misses the rotation fails at a step no hook observes.
- **One client means one consent.** Hop 2's authorization at our IdP is silent
  precisely because the User Source and the auth provider are the same client and
  consent is per client. **Split them and each will consent separately**, so the
  round-trip count in the section above changes. Design for it rather than
  discovering it in #14.

**What this spike does *not* establish** is that one client is unworkable. An
earlier reading of the pre-existing provider record — no `auth_method` on its token
request — suggested the User Source (Basic) and the auth provider (body) could never
share a client. A provider recreated the same evening stores
`auth_method: "client_secret_basic"`, so that conclusion does not hold in general.
The costs above are real; the impossibility was not.

## Findings

| # | Question | Verdict | Value |
|---|---|---|---|
| **Hop 1 — the User Source** | | | |
| 1 | Hop 1 on `cg-demo-us` reaches our IdP | **measured** | Yes, from 2026-09-11 ~14:24Z. Two hops to `cg-idp-or5b.onrender.com`, a real sign-in |
| 1a | Spike 04's candidate (A), a platform bug | **measured, dead** | The broker does consult `user_source_id` and redirects to the configured issuer |
| 1b | What changed to make it start doing so | **unexplained** | Nothing on our side. 14:15Z `account.arcade.dev`, 14:24Z `cg-idp` |
| 1c | Hop 1 completes | **measured, yes, after #61** | `aa98780` registered the client `client_secret_basic`; at 15:25:40Z the token exchange returned 200 with a 900s access token. It had failed seven times over the preceding 17 minutes |
| 1d | Why it failed before | **measured** | The auth method. Inferred at 14:41Z, confirmed at 15:25Z by changing exactly that and nothing else |
| 1e | Which auth method a User Source sends | **measured** | `client_secret_basic`. That is the whole content of 1c–1d |
| 1f | `apps/idp` request logging | **measured, shipped on #61** | It paid for itself four times in one evening; every diagnosis below rests on one of its lines |
| 1g | The IdP validates the code before the client | **measured** | A junk code returns `invalid_grant` for every client-auth variant, which is why a method problem hides behind a code problem |
| 1h | Arcade shows its own consent screen on hop 1 | **measured, new** | `cloud.arcade.dev/oauth2/consent`, Deny/Allow, *"Allow this application to access your Arcade.dev account?"*. One extra click per persona per MCP client |
| 1i | `tools/list` through the gateway | **measured** | Eight tools: four `Loan_*`, two `Approvals_*`, `Arcade_ListApps`, `System_ManageAuthorization` |
| 2 | Hop 1 on `cg-demo` (members mode) | **measured** | Unchanged: five hops to `account.arcade.dev`, so every persona would need an Arcade seat |
| **The join key** | | | |
| 3 | `user_id` Arcade hands the hooks | **measured** | `dana.okafor@…`, exact and lowercase, on **all 8278** `/access` frames one `tools/list` produced. DESIGN.md rule 3 observed, not assumed |
| 3a | Which layer that is | **measured** | Layer 1, `/access`. The six gateway tools `allow`, the rest of Arcade's catalogue `deny` |
| 3b | `/pre` for a loan tool | **never fired** | Layer-2 refusals produce no hook (DESIGN open risk 2). The control plane shows nothing at all for hop 2 |
| **Hop 2 — the custom verifier** | | | |
| 4 | **H2-a** — does Arcade redirect to a saved custom verifier | **measured, YES** | `303 → <tunnel>/verify?flow_id=…`. `callback_verify` and `account.arcade.dev` disappear from the chain |
| 4a | What Arcade sends the verifier | **measured** | Exactly one parameter: `flow_id`. No user hint, no provider, no return URL |
| 4b | `callback_verify` is the hook point | **measured** | With no route set it is the hop between the provider callback and `account.arcade.dev` |
| 4c | Does a User Source persona bypass the verifier | **measured, no** | Hop 1's identity does not carry into hop 2. The verifier is load-bearing |
| 5 | Does the persona log in twice | **measured, no** | Hop 2's IdP leg is a bare `302`: hop 1's session is reused, zero pages. Dana authenticates once |
| 6 | Does `confirm_user` accept the verifier's identity | **measured, yes** | 200, `{auth_id, next_uri}`, no `user_mismatch`, for the address our IdP put on `/oauth2/userinfo` |
| 6a | What the verifier binds to | **measured** | The email our IdP asserts. There is no Arcade account anywhere in the chain to bind to instead |
| 6b | `sub` from our IdP | **measured** | An opaque uuid. A User Source keyed on `sub` would put that in `user_id` — DESIGN open risk 4, concretely |
| 6c | `confirm_user` run by hand | **measured, unreliable** | Succeeded once at ~8 min, then `{"code":400,"msg":"Bad request"}` with no reason for a flow Arcade still recognised. Arcade accepts it only while the flow awaits verification; that window is shorter than a human. It also 401s on the key before reading the body |
| 6d | Arcade finalises the grant only once `next_uri` is fetched | **measured** | A `confirm_user` that returned 200 left the tool unauthorized because nothing landed on `callback_success` |
| 7 | **H2-b** — does the tool then execute | **UNMEASURED** | The verification half is complete and correct; the token half never succeeded. Three separate causes, each fixed and replaced by the next |
| 7a | Cause 1: provider sent `client_secret_post` | **measured** | `client_auth="client_secret_post"` in the IdP log, against a client registered `client_secret_basic` |
| 7b | Cause 2: provider sent nothing | **measured** | After the parameter rows were removed: `client_auth="absent"`, *"client_id is required"* |
| 7c | Cause 3: recreated provider's Client ID held a URL | **measured** | `"client_id": "https://cg-idp-or5b.onrender.com/oauth2/token"` → `invalid_client` at our authorize endpoint |
| 8 | **H2-c** — `/pre`'s `context.user_id` | **UNMEASURED** | Blocked behind 7 |
| 9 | **H2-d** — two personas at once | **UNMEASURED** | Never reached |
| **Configuration, read back** | | | |
| 10 | The dashboard's auth-method label is decorative | **measured** | It read *"Client Secret Basic"*, greyed out, while the provider sent `client_secret_post` — decided by Request Parameters rows, not by the label |
| 10a | A provider created 2026-09-10 | **measured** | No `auth_method` on `token_request` at all, though `user_info_request` has one |
| 10b | A provider created 2026-09-11 | **measured** | `auth_method: "client_secret_basic"` present. So 10a is a property of the old record, not of Arcade |
| 10c | Recreating a provider rotates its callback path | **measured** | `…/f4c6b_ap_GvSAhPpynQRj/callback` → `…/f4c6b_ap_1cWxRQzV98W4/callback`, invalidating the URI allowlisted at the IdP |
| 10d | Reading config back beats reading the console | **measured** | Two dashboard errors found in seconds by `GET /v1/admin/auth_providers/cg-idp` |
| **Both hops** | | | |
| 11 | Round trips at `apps/idp` per authorization | **measured** | 2 pages first ever, 1 with consent on record, **0** on a second authorization in the same browser — live and local agree |
| 12 | The IdP's redirect-URI allowlist, from outside | **measured** | Readable unauthenticated off the 302 target; used all evening to confirm the human's Render edits without a second ask |
| 12a | `.env.example`'s documented default | **measured, wrong** | It ships `https://cloud.arcade.dev/api/v1/oauth/callback`, which the live IdP rejects. The real one carries a per-provider path segment that changes when the provider is recreated |
| 13 | A verifier can be an unattended OAuth client of `apps/idp` | **measured, no** | One client, secret hashed since #70, DCR 403, PKCE-only refused |

## Confidence

| Claim | |
|---|---|
| `cg-demo-us` sends the persona to `cg-idp-or5b.onrender.com` | ✅ full chain, a real login, reproduced all afternoon |
| Hop 1 completes and yields a gateway token | ✅ token exchange 200, MCP session, `tools/list` of eight |
| #61's auth method was the cause of hop 1's earlier failure | ✅ seven failures, then that one change, then success |
| A User Source sends `client_secret_basic` | ✅ that is what 1c–1d measured, in both directions |
| `user_id` is Dana's exact lowercase email | ✅ 8278 `/access` frames, no exceptions |
| **Arcade redirects hop 2 to a saved custom verifier (H2-a)** | ✅ measured repeatedly; the verifier's own log, and `callback_verify` gone from the chain |
| **Arcade sends the verifier only `flow_id`** | ✅ the verifier records the whole query string and there is one key in it |
| **The persona authenticates once, not twice** | ✅ hop 2's IdP leg is a bare 302, zero pages |
| **`confirm_user` accepts the identity our IdP asserted** | ✅ 200 with `auth_id` and `next_uri`, no `user_mismatch` |
| A custom verifier has no Arcade account to bind instead | ✅ there is none in the chain; the only identity is the one `confirm_user` is handed |
| Arcade finalises the grant only after `next_uri` is fetched | ✅ a 200 `confirm_user` left the tool unauthorized until something landed there |
| Running `confirm_user` by hand is unreliable | ✅ one success, one unexplained 400 for a flow Arcade still recognised |
| `apps/idp` has no second OAuth client, and refuses PKCE-only | ✅ exact error text; DCR 403 |
| The dashboard's auth-method label is decorative | ✅ label said Basic, wire said post, then absent; and the stored record explains both |
| A provider recreated today carries `auth_method` | ✅ read back from the admin API, verbatim |
| Recreating a provider rotates its callback path | ✅ both paths, and the allowlist probe on each |
| Page counts at `apps/idp` for 1st / later / same-session | ✅ three runs, and the live IdP agreed on the second |
| **H2-b — the tool executes** | ⬜ **unmeasured.** Three causes found and fixed in sequence; the last is a misfiled Client ID holding a URL. Nothing suggests a fourth, and nothing here proves there isn't one |
| **H2-c — `/pre` carries Dana's lowercase email** | ⬜ **unmeasured.** `/access` does. `/pre` has never fired for a loan tool, because a layer-2 refusal fires no hook |
| **H2-d — two personas at once** | ⬜ **unmeasured** |
| Whether one IdP client can serve all three relying parties | ⬜ **not settled.** The costs are measured; the impossibility this document first claimed was read off an old provider record and does not generalise |
| What Arcade changed at ~14:24Z to start honouring the User Source | ⬜ **unexplained.** Ours to notice, not ours to know |

## Recommendation for #14

Marked where it is provisional. The hop-1 half is settled by measurement; the
hop-2 half rests on a chain that completed except for its last step.

**Take the User Source for hop 1. Settled.** `cg-demo-us` signs Dana in at our IdP,
issues a gateway token, lists eight tools, and hands the hooks her exact lowercase
address on every `/access` frame. `cg-demo` cannot do any of that without four
Arcade seats, because members mode is Arcade's account login by construction.
Members mode remains a real fallback — it costs the identity story, not the
governance story, since layers 1–4 key off `context.user_id` and that is the same
string either way — but there is no longer a reason to take it.

**`apps/web` needs a verifier route. Settled, and this is the reversal.** An earlier
draft held open the possibility that a User Source persona would already be
identified and hop 2 would skip the verifier, which would have deleted this code
rather than promoting it. Measured: it does not. With no route configured,
`callback_verify` sends a User Source persona to `account.arcade.dev`, and our
personas have no Arcade accounts. With a route configured, Arcade calls it. So #14
builds:

- **two route handlers** — one to take Arcade's `flow_id` and start the identity
  check, one to take the IdP's callback — plus the Arcade API key server-side.
  `evidence/05-verifier.ts` is a working reference for both.
- **the key server-side, not a manual step.** Measured: `confirm_user` by hand is
  unreliable, because Arcade accepts it only while the flow awaits verification and
  that window is shorter than a human's turnaround. Hold the key and it is one
  in-flow call.
- **a fetch of `next_uri`.** Arcade does not finalise the grant until something
  lands there. A verifier that returns the 303 and assumes a browser follows it is
  correct for a browser and wrong for anything else.
- **one property to preserve**: start a fresh login per flow and never read a
  session of its own. A verifier that trusts its own session collapses all four
  personas onto whoever logged in last, and the persona switcher is the demo.

**One interactive login per persona. Settled.** Hop 2's authorize at our IdP renders
zero pages — hop 1's session is reused. Rehearsal is four logins, one per persona,
and `apps/web` stores four gateway tokens and switches between them. Add one click
per persona for Arcade's own gateway consent screen unless the MCP client id is
allowlisted, which Arcade documents.

**Provisional: whether `apps/idp` needs a second OAuth client.** ⬜ Three relying
parties share one today, and the measured costs are one auth method, one
once-readable secret to rotate into two dashboards, and one shared consent. The
last of those is currently load-bearing in our favour — it is *why* hop 2 is
silent — so splitting clients would add a consent per persona. **Do not open that
slice on this spike's authority.** It needs the human's DESIGN gate, and the case
for it is weaker than an earlier draft of this document claimed.

**Provisional, and it is the one that matters: H2-b.** ⬜ Whether the tool actually
executes and `/pre` carries the right `user_id` is unmeasured. Three causes were
found and fixed in sequence, each revealing the next, and the last is a one-field
data-entry error. **The measurement is one field and one run away**, and
`05-verifier-flow.ts` prints the `/pre` `user_id` on the run that succeeds. Until
it does, do not wire #14's tool-authorization path on the assumption that it works.

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
