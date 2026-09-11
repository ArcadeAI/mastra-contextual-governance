# Spike 04 — can `apps/idp` back an Arcade User Source, so one login opens the gateway and the loan tools?

**Answer: `apps/idp` is now capable of it, and the gateway `cg-demo-us` does not use it.**

Two separate findings, measured a week apart and both in this document:

1. **`apps/idp` could not back a User Source as it stood, and now can.** The Arcade
   dashboard refused the issuer with *"OIDC discovery document does not include a
   `jwks_uri`"*. That was fixed for real on [#70](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/70)
   (merged `0c1cdab`): the live discovery document now publishes `jwks_uri` and
   `id_token_signing_alg_values_supported: ["RS256"]`, and the human created a
   User Source `cg-idp` against it.
2. **An MCP client connecting to `cg-demo-us` is still sent to Arcade's own
   account login, not to `cg-idp`.** Every hop of the authorization chain is
   identical to the members-mode gateway `cg-demo`. No persona ever sees
   `cg-idp-or5b.onrender.com`. So questions 2 and 3 could not be measured, and
   they are marked unverified rather than guessed.

**Recommendation for [#14](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/14): (c) Arcade Headers.** Reasoning in
[the last section](#recommendation-for-14).

Resolves [#65](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/65).
Feeds the #14 gate. Raw transcripts, redacted, in
[`evidence/04-user-source-transcript.md`](evidence/04-user-source-transcript.md);
the two scripts that produced them are
[`evidence/04-user-source-flow.ts`](evidence/04-user-source-flow.ts) and
[`evidence/04-mastra-authprovider.ts`](evidence/04-mastra-authprovider.ts).

**Reproduced.** Run against the live services on 2026-09-11, headlessly, as Dana.

## Setup

| | |
|---|---|
| IdP | `https://cg-idp-or5b.onrender.com` — `apps/idp` on Render, after #70 |
| User Source | `cg-idp`: issuer as above, subject claim `email`, scopes `openid profile email` |
| Gateway under test | `cg-demo-us` → `https://api.arcade.dev/mcp/cg-demo-us`, six tools (`Loan_*`, `Approvals_*`), created in User Source mode |
| Control gateway | `cg-demo` → `https://api.arcade.dev/mcp/cg-demo`, "Members of this Project" mode |
| Control plane | `https://cg-hooks.onrender.com/events`, unauthenticated SSE, `last-event-id: 0` replays (#62) |
| Persona | Dana Okafor, password from `apps/idp/src/fixtures/people.json`; the address lives only in Render env vars |
| Client | two: raw `fetch` with a cookie jar, and `@mastra/mcp@1.17.3` |

No browser was used and no credential was provisioned. `apps/idp`'s login and
consent pages are server-rendered HTML forms, so a cookie jar and a regex form
parser are a sufficient user agent.

## How this was answered

`evidence/04-user-source-flow.ts` walks the MCP authorization spec end to end:

1. `POST` an `initialize` with no `Authorization` header, read `WWW-Authenticate`.
2. Fetch the protected-resource metadata it names, then the authorization server
   metadata that names.
3. Bind a loopback port (port 0, read back — never a guessed port), register a
   throwaway public client on it by dynamic client registration.
4. `GET /oauth2/authorize` with PKCE and follow every redirect by hand, filling in
   whatever forms appear.
5. Exchange the code, then `initialize`, `tools/list`, `tools/call Loan_GetLoan`.
6. Replay `/events` and print the `user_id` on the `/pre` frame.

The script carries one deliberate guard: **it will not type a persona's password
into a host that is not the configured issuer.** It stops, names the host that
served the page, and exits non-zero. That guard is what fired.

## Question 1 — does Arcade accept `apps/idp` as a User Source at all?

**Measured. No as `apps/idp` stood; yes after #70.**

The dashboard's refusal, quoted exactly:

> OIDC discovery document does not include a `jwks_uri`.

Measured against the discovery document at the time: `jwks_uri: null`,
`id_token_signing_alg_values_supported: ["HS256"]`. Arcade validates the ID token
against a JWKS, so an IdP that publishes no keys cannot back a User Source. There
is no symmetric-secret path around it.

**Why `apps/idp` had no JWKS**, and what the fix cost. This is the part worth
keeping, because a forker will hit the same trade. `apps/idp` set
`disableJwtPlugin: true` so that Better Auth would store the OAuth **client secret
encrypted**, which is what let `bun run oauth-client` re-print it. Better Auth only
permits encrypted client-secret storage with the JWT plugin off. Turning the plugin
on buys RS256 ID tokens and a `jwks_uri`, and costs:

- **hashed client-secret storage.** The secret is visible exactly once, at
  creation. That changed the operational story in `apps/idp/README.md`, the reset
  contract, and #61.
- **a client rotation on the live instance.** A new client row, so the `cg-idp`
  auth provider registered in Arcade has to be re-registered with the new secret.
  #70 handles the existing encrypted row explicitly and says in the boot log
  whether the client rotated.

Both were accepted by the human and shipped on #70. The live discovery document now
reads:

```json
{ "issuer": "https://cg-idp-or5b.onrender.com",
  "jwks_uri": "https://cg-idp-or5b.onrender.com/jwks",
  "id_token_signing_alg_values_supported": ["RS256"],
  "code_challenge_methods_supported": ["S256"],
  "claims_supported": ["sub","iss","aud","exp","iat","sid","scope","azp","name",
                       "picture","given_name","family_name","email","email_verified"] }
```

with one RS256 key at `/jwks`, `kid` `MNIE6RdQNKHOzcq78K6SbkXcEPB7MAfM`. The User
Source `cg-idp` was then created against it without complaint. **Arcade accepting
the issuer is therefore settled.** What follows is about whether a gateway then
uses it.

## Question 2 — does an MCP client complete the flow headlessly, and what `user_id` lands on `/pre`?

**Unverified, and blocked on Arcade-side configuration rather than on anything in
this repo.** The persona is never sent to `cg-idp`, so there is no ID token, no
subject claim, no tool call and no `/pre` frame to read a `user_id` off.

What was measured is the chain itself. `initialize` with no token:

```
HTTP/2 401
www-authenticate: Bearer resource_metadata="https://api.arcade.dev/.well-known/oauth-protected-resource/mcp/cg-demo-us", scope="mcp", error="invalid_token"

{"name":"invalid_authorization","message":"Missing Authorization header"}
```

That metadata document, and the authorization server it names:

```json
{"resource":"https://api.arcade.dev/mcp/cg-demo-us",
 "authorization_servers":["https://cloud.arcade.dev/oauth2"],
 "bearer_methods_supported":["header"],"scopes_supported":["mcp"],
 "resource_name":"contextual-governance (user source)"}
```

Dynamic client registration at `https://cloud.arcade.dev/oauth2/register` succeeds
and returns a public client (`token_endpoint_auth_method: "none"`, no secret), so
**a server process can register itself with Arcade without a human or a dashboard
visit.** That is genuinely useful, and it is the one part of the flow that came
out better than I expected.

Then `GET /oauth2/authorize`:

```
302 https://cloud.arcade.dev/oauth2/authorize
 -> https://auth.arcade.dev/oauth2/auth
      ?client_id=4eabdfa1-482e-4296-ba72-ba5fde2a3812
      &redirect_uri=https%3A%2F%2Fcloud.arcade.dev%2Foauth2%2Fintermediate_callback
      &scope=openid+profile+email
302 -> https://auth.arcade.dev/ui/login?login_challenge=…
303 -> https://auth.arcade.dev/self-service/login/browser?…
303 -> https://account.arcade.dev/login?flow=…
200    a login page served by account.arcade.dev
```

The shape is right and the host is wrong. `.../oauth2/intermediate_callback` is
exactly the redirect URI Arcade's User Source documentation names, so
`cloud.arcade.dev/oauth2` really is brokering to an upstream OIDC provider. The
upstream it picked is Arcade's own Ory/Hydra deployment, not
`cg-idp-or5b.onrender.com`.

Three checks that rule out the obvious alternative explanations:

- **It is not the `resource` parameter.** Dropping `resource` entirely produces a
  byte-identical first redirect.
- **It is not this gateway.** The members-mode gateway `cg-demo` produces the same
  five hops to the same login page. The two gateways are indistinguishable from a
  client's side; only `resource_name` differs.
- **It is not an unrendered "choose your IdP" step.** The Kratos flow behind that
  page offers *Work email*, GitHub, Google and Microsoft, and nothing else.
  Submitting `identifier=dana.okafor@…` with `method=identifier_first` returns an
  Arcade **password** form: Arcade resolves the persona as one of its own project
  members and never offers `cg-idp`.

So either the User Source is not attached to `cg-demo-us` (created in the User
Sources list, but the gateway's authentication mode not saved against it), or
Arcade's broker needs something the MCP authorization spec does not carry. From
outside the dashboard those two look the same, and reading the gateway's
configuration needs an Arcade API key an implementer does not hold. Flagged
on #65 for the human.

**What "unverified" costs, concretely:** the exact string and case of `user_id` on
the `/pre` payload under a User Source is unknown. The subject claim is configured
as `email`, and #58 made every holder in `idp.db` and `governance.db` lowercase, so
lowercase `dana.okafor@…` is the expectation. It is only an expectation, and
DESIGN.md's open risk 4 is exactly that identity can split silently. Do not build
#14 on it unmeasured.

## Question 3 — does the tool's own OAuth need a second consent?

**Unverified, for the same reason**, and one thing is already known well enough to
plan around.

`tools/loan/loan/__init__.py:56-64` declares `OAuth2(id="cg-idp", scopes=…)` on all
four loan tools. That is an Arcade **auth provider** also named `cg-idp`, a separate registration
from the **User Source** of the same name, pointed at the same IdP. Arcade's own gateway documentation is explicit that the two do not
collapse:

> Users will still need to authenticate to the tools within the MCP Gateway as normal.

So the best case is not one browser round trip. It is two authorizations against one login. The gateway login sends the persona to
`cg-idp` and leaves a session cookie there. The tool's authorization sends them to
`cg-idp` again, where that cookie should make the second pass consent-only or
silent. Whether Better Auth's consent page is
skipped on the second pass for an already-consented client is exactly the number
#65 asked for, and it was not measured. Recorded as **unverified: expected 2
authorizations / 1 credential prompt, unmeasured.**

## Question 4 — can Mastra's `MCPClient` drive this from a server with no browser?

**Measured, and the answer has two halves.**

Against `@mastra/mcp@1.17.3`:

**No, not `MCPClient.authenticate()` from a hosted route handler.** Given a provider
whose `redirectUrl` is the HTTPS callback a Render-hosted `apps/web` would use, it
refuses before touching the network:

```
threw: Cannot authenticate MCP server arcade: the provider's redirect URL must be
a loopback address, got https://cg-web-sa31.onrender.com.
```

`authenticate()` is built for a CLI. It binds a loopback port itself and waits for
a browser to hit it. `apps/web` on Render cannot use it. The library's own reference says as much, *"Hosts with custom redirect handling
(e.g. a web app with an HTTPS redirect URL) should drive `MCPOAuthClientProvider`
directly instead"*, and the error above is that sentence enforced.

**Yes to everything up to the human hop.** With a loopback redirect URL,
`authenticate()`:

- runs discovery and dynamic client registration against Arcade unattended, a
  fresh `client_id` each run, no dashboard step;
- hands the fully-formed authorization URL to `onRedirectToAuthorization`, PKCE
  challenge and `resource` included:

  ```
  https://cloud.arcade.dev/oauth2/authorize?response_type=code
    &client_id=db8ae1b0-ee87-40bb-b737-2131b896bae8
    &code_challenge=…&code_challenge_method=S256
    &redirect_uri=http%3A%2F%2Flocalhost%3A62287%2Foauth%2Fcallback
    &state=…&scope=mcp+offline_access&prompt=consent
    &resource=https%3A%2F%2Fapi.arcade.dev%2Fmcp%2Fcg-demo-us
  ```

- binds that loopback port and blocks until a code arrives.

The server process can start the flow and finish it. It cannot be the user agent
in the middle. In `apps/web` the workable arrangement is to drive `MCPOAuthClientProvider`
directly, redirect the persona's own browser to that URL, take the code on a route
handler at an HTTPS callback, and hand it back to the provider. That is ordinary web OAuth, and it is the only supported shape for a
hosted app.

**One behaviour #14 must not inherit.** Before authorization, `listTools()` returns `{}`, an empty object rather than a
throw, while `getServerAuthState('arcade')` returns `"needs-auth"`. The library logs the 401 and carries on. An agent wired up naively
would simply have no tools and would explain to the user, plausibly and wrongly,
that it cannot help. This is the same failure class DESIGN.md names for policy rules, silence that
reads as permission. **#14 must check `getServerAuthState`
rather than trusting an empty tool list.**

## Findings

| # | Question | Verdict | Value |
|---|---|---|---|
| 1 | Arcade accepts `apps/idp` as a User Source | **measured** | No with HS256 / no JWKS: *"OIDC discovery document does not include a `jwks_uri`"*. Yes after #70, with `jwks_uri` published, RS256, one key |
| 1a | Cost of the fix | **measured** | JWT plugin on means the client secret is hashed, printed once, and the live OAuth client rotates. Shipped on #70 |
| 2 | Headless MCP client completes the flow as Dana | **unverified** | The chain never reaches `cg-idp`; it lands on `account.arcade.dev` |
| 2a | `user_id` on the `/pre` payload | **unverified** | No `/pre` frame produced. Expected lowercase `dana.okafor@…` from subject claim `email` + #58 |
| 2b | Dynamic client registration against Arcade | **measured** | Works unattended; public client, no secret, no dashboard step |
| 2c | `cg-demo-us` vs `cg-demo` authorization chain | **measured** | Identical hop for hop; only `resource_name` differs |
| 2d | Arcade offers `cg-idp` at its login | **measured** | No. Work email / GitHub / Google / Microsoft; the persona resolves to an Arcade password form |
| 3 | Second consent for the tool's OAuth | **unverified** | Blocked. Tools declare `OAuth2(id="cg-idp")`; Arcade documents gateway and tool auth as separate, so expect 2 authorizations against 1 IdP session |
| 4 | `MCPClient.authenticate()` from a hosted route handler | **measured** | Refused: *"the provider's redirect URL must be a loopback address"* |
| 4a | `MCPOAuthClientProvider` from a server process | **measured** | Works up to the browser hop: discovery, DCR, PKCE, authorization URL emitted, loopback bound |
| 4b | Unauthenticated `listTools()` | **measured** | Returns `{}` and logs; `getServerAuthState` returns `"needs-auth"` |

## Confidence

| Claim | |
|---|---|
| Arcade refuses an issuer with no `jwks_uri` | ✅ the dashboard's own error text |
| `apps/idp` now publishes `jwks_uri` and RS256 | ✅ live discovery document and `/jwks` |
| `cg-demo-us` sends the persona to `account.arcade.dev`, not `cg-idp` | ✅ five hops, reproduced by two independent clients |
| Not caused by the `resource` parameter | ✅ identical redirect with it dropped |
| Not a gateway-specific quirk | ✅ `cg-demo` produces the same chain |
| No `cg-idp` option hidden in Arcade's login UI | ✅ Kratos flow nodes enumerated; identifier-first returns a password form |
| Arcade DCR works unattended | ✅ 201 with a `client_id`, twice, from two clients |
| `authenticate()` rejects a non-loopback redirect URL | ✅ exact error text |
| `listTools()` is empty rather than throwing when unauthorized | ✅ `[]` alongside `"needs-auth"` |
| **Why** `cg-demo-us` does not broker to `cg-idp` | ⬜ **not determined.** Attachment and a missing request parameter look the same from outside the dashboard, and reading the gateway's configuration needs an Arcade API key an implementer does not hold |
| `user_id` on `/pre` under a User Source | ⬜ **not measured.** Expectation only |
| Round trips on a persona's first use | ⬜ **not measured.** Expectation only, from Arcade's documentation |
| Whether `MCPOAuthClientProvider` completes against Arcade end to end | ⬜ **not measured.** Everything up to the browser hop was; the hop itself needs a login this spike could not reach |

## Recommendation for #14

**Take (c) Arcade Headers.** The gateway's login is not where this demo's identity claim lives. Layers 1 to 4
are, and all four key off `context.user_id`, so the only thing #14 needs from the
gateway is the ability to say which persona is acting, per call, from a Next.js
route handler, with no browser hop. Headers mode
does exactly that with an Arcade API key in `Authorization` and the persona's email
in `Arcade-User-ID`, and it is the only one of the three that works today and survives contact with a
hosted server. (b) User Source cannot be reached at all as `cg-demo-us` is
configured, and even once it can, question 4 shows a hosted `apps/web` must hand
the flow to the user's own browser and take the callback itself, which is four
personas and four interactive logins to rehearse live. (a) per-persona Arcade OAuth
is that same interactive cost plus token storage for four Arcade member accounts,
and it lands on the identical `user_id`. Headers mode does not
weaken the thesis, because the header is not the credential: the loan tools still
declare `OAuth2(id="cg-idp")`, so a forged `Arcade-User-ID` gets a governance
decision for a persona whose OAuth grant `apps/web` does not hold and the call dies
at layer 2, and `apps/loan-app` still derives its actor from the token rather than
from anything the header said. The one thing to keep honest is DESIGN.md's rule 3. The header must carry the same
lowercase address as the OAuth subject and the loan book's actor. **Revisit (b) when someone confirms the User Source is attached and
measures questions 2 and 3**: it is the better story for an enterprise audience, it
is what a forker with a real Okta should use, and this spike's script measures it in
about two minutes once the authorization chain reaches `cg-idp`.

## Follow-ups

- **#65 is answered; the Arcade-side configuration is not.** Whether `cg-demo-us`
  has the `cg-idp` User Source genuinely attached is a dashboard check for the
  human, noted on the issue. No repo change is proposed: `apps/idp` already does
  everything Arcade asks of it after #70.
- **#14 must not trust an empty tool list.** Check `getServerAuthState` (finding
  4b).
- **The `cg-idp` name is overloaded.** An Arcade *auth provider* and an Arcade *User
  Source* both carry it, pointed at the same IdP but configured separately and
  doing different jobs. Worth disambiguating in `.env.example` before either is
  wired, or a future reader will assume configuring one configures the other.
