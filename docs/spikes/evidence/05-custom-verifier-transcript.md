# Spike 05 — raw transcript

Every run is against the live services on **2026-09-11** unless it says otherwise.
Secrets are redacted by `05-drive.ts:redact`; the persona domain is redacted by
hand, as in spikes 03 and 04. The ngrok hostname is left in: the tunnel was dead
within the hour and it is the only way to read the flow.

Scripts: [`05-verifier.ts`](05-verifier.ts), [`05-verifier-flow.ts`](05-verifier-flow.ts),
[`05-redirect-allowlist.ts`](05-redirect-allowlist.ts), [`05-drive.ts`](05-drive.ts).

---

## 1. The blocker found before anything else: the verifier needs a client secret, and it cannot be read back

`apps/idp` registers exactly one OAuth client. The live one, off the public
`/health`, no secret in it:

```console
$ curl -s https://cg-idp-or5b.onrender.com/health
{"status":"ok","service":"idp","issuer":"https://cg-idp-or5b.onrender.com","people":4,
 "oauth":{"client_id":"RskTFjl6AqkUO8FKYWjpDCLd139YE36F",
          "authorize":"https://cg-idp-or5b.onrender.com/oauth2/authorize",
          "token":"https://cg-idp-or5b.onrender.com/oauth2/token",
          "userinfo":"https://cg-idp-or5b.onrender.com/oauth2/userinfo",
          "jwks":"https://cg-idp-or5b.onrender.com/jwks",
          "id_token_signing_alg":"RS256",
          "client_secret_state":"unchanged",
          "client_secret_note":"stored hashed; it cannot be printed again — `bun run oauth-client --rotate` mints a new one"}}
```

Dynamic client registration is off, so the verifier cannot mint its own:

```console
$ curl -s -o /dev/null -w '%{http_code}\n' -X POST https://cg-idp-or5b.onrender.com/oauth2/register \
    -H 'content-type: application/json' -d '{"client_name":"probe","redirect_uris":["http://localhost:1/cb"]}'
403
```

(`apps/idp/src/auth.ts` sets `allowDynamicClientRegistration: false`, deliberately —
"Arcade is registered by hand, so nothing needs `/oauth2/register`.")

And there is no PKCE-only path around the secret. Measured against a **local**
`apps/idp` at the same version, driving a real login for Dana and then exchanging
the same kind of code three ways:

```
=== no client_secret (PKCE only) -> HTTP 400
{"error_description":"client registered for client_secret_post cannot use none","error":"invalid_client"}

=== wrong client_secret -> HTTP 400
{"error_description":"invalid client_secret","error":"invalid_client"}

=== correct client_secret -> HTTP 200
{"access_token":"<redacted>","expires_in":3600,"token_type":"Bearer","scope":"openid email","id_token":"<redacted>"}

userinfo -> 200 {"sub":"ab7cb2b0-…","email":"dana.okafor@…","email_verified":true}
id_token claims: {"iss":"http://localhost:4423","aud":"k93D04bR2YHYSe2paqsG9eQgrG00mX0l","email":"dana.okafor@…","sub":"ab7cb2b0…"}
```

Note the live token endpoint checks the **code before the client**, so probing it
with a junk code tells you nothing:

```console
$ curl -s -X POST https://cg-idp-or5b.onrender.com/oauth2/token \
    -d 'grant_type=authorization_code&code=notacode&…&client_id=RskTFjl6AqkUO8FKYWjpDCLd139YE36F&code_verifier=…'
{"error_description":"invalid code","error":"invalid_grant"}      # with no secret
{"error_description":"invalid code","error":"invalid_grant"}      # with a wrong secret
```

That ordering is why the local instance was needed to answer it.

---

## 2. The live IdP's redirect-URI allowlist, read from outside

`apps/idp` answers `/oauth2/authorize` with a 302 either way: onward to `/login`
for an allowlisted URI, to `/error?error=invalid_redirect` for anything else.
Unauthenticated, no dashboard, no secret.

```console
$ bun docs/spikes/evidence/05-redirect-allowlist.ts
redirect-URI allowlist on https://cg-idp-or5b.onrender.com, client RskTFjl6AqkUO8FKYWjpDCLd139YE36F

ALLOWED   https://cloud.arcade.dev/oauth2/intermediate_callback
REJECTED  https://cloud.arcade.dev/api/v1/oauth/callback
            -> https://cg-idp-or5b.onrender.com/error?error=invalid_redirect
               invalid+redirect+uri
REJECTED  https://cloud.arcade.dev/api/v1/oauth/callback/
REJECTED  https://cloud.arcade.dev/oauth/callback
REJECTED  https://api.arcade.dev/v1/oauth/callback
REJECTED  https://example.com/definitely-not-allowlisted
```

`https://cloud.arcade.dev/oauth2/intermediate_callback` is the redirect URL
Arcade's User Source documentation names. `https://cloud.arcade.dev/api/v1/oauth/callback`
is the one `apps/idp/src/config.ts` carries as `DEFAULT_ARCADE_REDIRECT_URI` for
the **auth provider** the loan tools use.

---

## 3. Control: both gateways, with no custom verifier configured

Re-measured today, so the "after" has a same-day "before" to sit next to. Spike 04
got the same answer a week earlier.

```console
$ PROBE_ONLY=1 ARCADE_MCP_URL=https://api.arcade.dev/mcp/cg-demo-us \
    bun docs/spikes/evidence/05-verifier-flow.ts
```

```
─── 08 302 https://auth.arcade.dev/oauth2/auth -> https://auth.arcade.dev/ui/login
─── 09 303 https://auth.arcade.dev/ui/login -> https://auth.arcade.dev/self-service/login/browser
─── 10 303 https://auth.arcade.dev/self-service/login/browser -> https://account.arcade.dev/login
─── 11 page 1: account.arcade.dev rendered a form

─── 12 hop 1 — hosts that rendered a page
{
  "pageHosts": ["account.arcade.dev"],
  "pagesShown": 1,
  "reachedTheVerifier": false,
  "reachedTheIdP": false
}

─── 13 hop 1 — redirect chain
[
  "302 GET https://cloud.arcade.dev/oauth2/authorize",
  "302 GET https://auth.arcade.dev/oauth2/auth",
  "303 GET https://auth.arcade.dev/ui/login",
  "303 GET https://auth.arcade.dev/self-service/login/browser",
  "200 GET https://account.arcade.dev/login"
]
```

`cg-demo` (members mode) is byte-identical hop for hop, same upstream
`client_id=4eabdfa1-482e-4296-ba72-ba5fde2a3812`, same
`redirect_uri=https://cloud.arcade.dev/oauth2/intermediate_callback`, and it
stops on the same `account.arcade.dev` login page.

The protected-resource documents still differ exactly as spike 04 recorded:
`cg-demo-us` publishes `"urn:arcade:oauth:user_source_id":"us_3JA8GcvHfT17WNnnRazx6FZpxeg"`,
`cg-demo` publishes no such field.

---

## 4. The verifier, proven end to end against a real `apps/idp`

Before asking a human for anything, the verifier was run against a local
`apps/idp` (an instance of the same code as `cg-idp`, on this worktree's own port
4423, with a client this spike minted and therefore holds the secret for), and a
stand-in for Arcade drove it. This proves the verifier's own contract; it does
not prove anything about Arcade.

Startup:

```
spike 05 verifier — local :52571, public https://63be-…-3130.ngrok-free.app
  IdP issuer         http://localhost:4423
  IdP client         k93D04bR2YHYSe2paqsG9eQgrG00mX0l
  confirm_user       manual — the curl is printed per flow

  Two values for the human:
    Arcade dashboard, Auth → Settings → custom verifier :  https://63be-…-3130.ngrok-free.app/verify
    IdP IDP_OAUTH_REDIRECT_URIS, one more entry         :  https://63be-…-3130.ngrok-free.app/callback
```

A whole flow, second time for this persona (so consent was already granted):

```
─── 01 303 https://63be-….ngrok-free.app/verify -> http://localhost:4423/oauth2/authorize
─── 02 302 http://localhost:4423/oauth2/authorize -> http://localhost:4423/login
─── 03 page 1: login at http://localhost:4423/login
       { "action": "http://localhost:4423/login", "fields": ["oauth_query","email","password"] }
─── 04 303 https://63be-….ngrok-free.app/callback -> https://cloud.arcade.dev/pretend/next
─── 05 the chain lands back on the redirect URI

== result {
  "visited": [
    "303 GET https://63be-….ngrok-free.app/verify",
    "302 GET http://localhost:4423/oauth2/authorize",
    "200 GET http://localhost:4423/login",
    "303 POST http://localhost:4423/login",
    "303 GET https://63be-….ngrok-free.app/callback"
  ],
  "pagesShown": 1,
  "pageHosts": ["localhost:4423"]
}
```

What the verifier itself recorded, off `GET /state`:

```json
{
  "flow_id": "spike75-local-1",
  "started_at": "2026-09-11T14:14:53.622Z",
  "arcade_query": { "flow_id": "spike75-local-1", "provider": "cg-idp" },
  "email": "dana.okafor@…",
  "waiting": true
}
```

and the manual `confirm_user` step, resumed by hand because this spike holds no
Arcade API key:

```console
$ curl -sS -X POST https://63be-….ngrok-free.app/confirm -H 'content-type: application/json' \
    -d '{"flow_id":"spike75-local-1","response":{"auth_id":"ac_fake123","next_uri":"https://cloud.arcade.dev/pretend/next?ok=1"}}'
{"resumed":"spike75-local-1"}
```

`auth_id`/`next_uri` there are stand-ins, not Arcade's: this run never reached
Arcade. It exercises the resume path and the final 303.

### How many pages a persona sees at `apps/idp`

Three runs, same verifier, same IdP:

| Run | Persona state | Pages rendered |
|---|---|---:|
| First ever authorization | no session, no prior consent | **2** — `/login`, then `/consent` |
| Later authorization, new browser | no session, consent on record | **1** — `/login` |
| Second authorization, same browser | live session, consent on record | **0** — entirely silent |

The third row is the one that matters for #75 question 3, and it is measured:

```
== flow spike75-riley-a: pagesShown=2 pageHosts=["localhost:4423","localhost:4423"] jar=["localhost"]
== flow spike75-riley-b: pagesShown=0 pageHosts=[]                                  jar=["localhost"]
```

Two complete authorization flows through the verifier, one cookie jar. The second
showed the persona nothing at all.
