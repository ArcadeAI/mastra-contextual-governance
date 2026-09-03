# apps/idp — the enterprise identity provider

**This is a demo fixture standing in for the enterprise's real IdP** — the same category
of thing as the persona switcher. A forker deletes this directory and points Arcade at
their Okta. Nothing else in the template depends on it, and it depends on nothing else in
the template: it is not a workspace member, and it knows people, not loans and not policy.

Bun on Render, [Better Auth](https://www.better-auth.com) with the
[`@better-auth/oauth-provider`](https://www.better-auth.com/docs/plugins/oauth-provider)
plugin as an OAuth 2.1 authorization server, owning `idp.db` on its own disk.

> `@better-auth/oauth-provider` (the `oauthProvider()` plugin) supersedes the older
> `oidc-provider` plugin, which still appears in the docs tree and in search results.
> Do not switch to it.

## What it serves

| Path | What |
|---|---|
| `GET /oauth2/authorize` | Authorization endpoint. Sends the browser to `/login`, then `/consent`, then back to the client with a code. |
| `POST /oauth2/token` | Token endpoint. `client_secret_post`, PKCE `S256` required. Access tokens are opaque. |
| `GET /oauth2/userinfo` | The persona's identity. `email` is the claim Arcade extracts. |
| `POST /oauth2/introspect`, `POST /oauth2/revoke` | For a resource server that needs to validate or revoke an opaque token. |
| `GET /.well-known/openid-configuration` | Discovery. Arcade does not read it; it is there for anything that does. |
| `GET /login`, `GET /consent` | The two pages a persona sees. Server-rendered HTML, legible on a projector. |
| `GET /health` | Render's health check. Reports the client id and the endpoint URLs. |

Every Better Auth route hangs off the site root, so the URLs a human types into the
Arcade dashboard have no `/api/auth` prefix to forget.

## The people

Four personas, seeded from [`src/fixtures/people.json`](./src/fixtures/people.json) the
first time `idp.db` is opened, in one transaction, following the loan book's pattern
(#29): a seed that fails leaves no schema, so the next boot retries instead of coming up
green and empty. Passwords are in the fixture. This is a demo IdP and pretending otherwise
helps nobody.

The emails are the join key for the whole system — Arcade `user_id`, OAuth subject, loan
book actor. The fixture ships placeholder addresses; set `PERSONA_DANA_EMAIL` and the
other three (the same variables the persona switcher uses) **before the first boot** to
seed the addresses the Arcade accounts were created under (#13). A seed is not re-read;
change them afterwards and you need a reset.

## The OAuth client

Exactly one, named `Arcade`, created on first boot if absent: confidential,
`token_endpoint_auth_method: client_secret_post`, PKCE required, redirect URIs from
`IDP_OAUTH_REDIRECT_URIS`. Better Auth generates the `client_id` and `client_secret`; they
cannot be pinned from env. Read them out with:

```sh
bun run --cwd apps/idp oauth-client          # human-readable
bun run --cwd apps/idp oauth-client --json   # for scripts
```

On Render: open a shell on the `cg-idp` service and run `bun run oauth-client`. The
secret is stored encrypted (not hashed) so this works on any later day, and it is the
**only** place the secret is ever printed — the boot log carries the id, never the secret.

Changing `IDP_OAUTH_REDIRECT_URIS` updates the client in place. The credentials do not change.

### Registering it in Arcade (#13)

Custom OAuth 2.0 provider, from the output of the script above:

| Arcade field | Value |
|---|---|
| Client ID / Client secret | as printed |
| Authorize URL | `https://<idp-host>/oauth2/authorize` |
| Token URL | `https://<idp-host>/oauth2/token` |
| Client authentication | credentials in the token request body (`client_secret_post`) |
| **PKCE** | **enable it**, `S256`. Arcade defaults PKCE off; this client requires it. A mismatch fails at the authorize step, where no hook fires and nothing on the panel says why. |
| Scopes | `openid profile email offline_access` |
| User info endpoint | `https://<idp-host>/oauth2/userinfo`, bearer token |
| Identity JSONPath | `$.email` |
| Redirect URL | the one Arcade shows you — put it in `IDP_OAUTH_REDIRECT_URIS` if it is not `https://cloud.arcade.dev/api/v1/oauth/callback` |

The userinfo payload, for reference:

```json
{ "sub": "<user id>", "email": "dana.okafor@bank.example", "email_verified": true,
  "name": "Dana Okafor", "given_name": "Dana", "family_name": "Okafor" }
```

## ⚠️ Reset does not rotate the client

`scripts/reset` (#23) exists so the demo can be rehearsed from clean. If resetting
`idp.db` regenerated the client, the registration in the Arcade dashboard would go stale
and OAuth would break at the next authorize — minutes before presenting, with no hook
fired and the panel dark.

So the reset for this database is its own script, and it clears **people and their
state** — users, credentials, sessions, tokens, consents — while leaving the `oauthClient`
row alone:

```sh
bun run --cwd apps/idp reset
```

It prints the client id before and after and exits non-zero if they differ. The client
row is written unowned (no `userId`), so deleting every user cannot cascade into it either;
Better Auth's own create-client endpoints would have made a signed-in user the owner.
`test/flow.test.ts` runs the reset against the live service and completes a full flow
afterwards with the pre-reset credentials; `test/db.test.ts` holds the cascade line.

Deleting the disk (or the whole database) *is* a rotation. Do that only when you intend to
re-register in Arcade.

## Running it

```sh
bun install --cwd apps/idp     # own lockfile — see below
bun run dev:idp                # :8083
curl localhost:8083/health
```

Tests boot the service exactly as Render does (`bun src/index.ts`, env only) and drive the
authorization-code flow over HTTP — authorize, login, consent, code, token, userinfo:

```sh
bun test apps/idp
```

`src/schema.sql` is generated from the installed Better Auth (`bun run --cwd apps/idp
generate:schema`); `test/schema.test.ts` fails when it is stale.

### Why it is not a workspace member

Two reasons, both in `package.json`. It stands in for a system outside the template, so a
forker deletes it without touching anything else. And Better Auth 1.7 requires zod 4,
while the root manifest pins every workspace's zod to 3.x for the Arcade/Mastra path — Bun
applies that override to the whole workspace and ignores nested ones, so inside the
workspace Better Auth cannot boot. The root `workspaces` list excludes `apps/idp` and this
directory carries its own `bun.lock`.

## Environment

| Variable | Purpose |
|---|---|
| `PORT` | Render injects it. Locally `8083`. |
| `IDP_DB_PATH` | `/data/idp.db` on Render, `./idp.db` locally. Parent directory is created. |
| `BETTER_AUTH_SECRET` | Signs sessions and encrypts the stored client secret. Generated by Render. Required in production; a fixed dev value otherwise. |
| `IDP_PUBLIC_URL` | Public origin and OAuth issuer. Falls back to Render's `RENDER_EXTERNAL_URL`, then `http://localhost:PORT`. |
| `IDP_OAUTH_REDIRECT_URIS` | Comma-separated. Defaults to Arcade Cloud's callback. |
| `PERSONA_*_EMAIL` | The four persona addresses, read at first seed. |
