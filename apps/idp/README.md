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
| `POST /oauth2/token` | Token endpoint. `client_secret_post`, PKCE `S256` required. Access tokens are opaque; the ID token is an RS256 JWT. |
| `GET /oauth2/userinfo` | The persona's identity. `email` is the claim Arcade extracts. |
| `GET /jwks` | The key set the ID token is verified against. One RSA key, `alg: RS256`. |
| `POST /oauth2/introspect`, `POST /oauth2/revoke` | For a resource server that needs to validate or revoke an opaque token. |
| `GET /.well-known/openid-configuration` | Discovery. A custom OAuth provider does not read it; an Arcade **User Source** does, and refuses an issuer without a `jwks_uri`. |
| `GET /login`, `GET /consent` | The two pages a persona sees. Server-rendered HTML, legible on a projector. |
| `GET /health` | Render's health check. Reports the client id, the endpoint URLs, the JWKS URL and what happened to the client secret at boot. |

Every Better Auth route hangs off the site root, so the URLs a human types into the
Arcade dashboard have no `/api/auth` prefix to forget.

## ID tokens, the key set, and the User Source

`/.well-known/openid-configuration` carries a `jwks_uri`, ID tokens are signed
**RS256**, and `GET /jwks` publishes the public half of one RSA key.

This is not decoration. Arcade's **User Source** mode redirects the persona to this
IdP and identifies them from a claim on the ID token, which it verifies against the key
set it fetches from `jwks_uri`. Until #70 this service ran Better Auth's OAuth provider
with `disableJwtPlugin: true`, so it signed ID tokens HS256, published no keys, and the
Arcade form refused the issuer outright:

> OIDC discovery document does not include a `jwks_uri`.

RS256 rather than Better Auth's default EdDSA, deliberately: Ed25519 JWS support is uneven
across verifiers, and an IdP whose only key a relying party cannot verify passes the
discovery check and fails at the token.

**The subject claim is `email`.** Better Auth blanks every standard profile claim in the
ID token by default and points relying parties at `/oauth2/userinfo`, which would leave
`sub` — an opaque uuid — as the only identity on the token. DESIGN.md's third identity
rule is that the Arcade `user_id`, the OAuth subject and the loan book's actor are the
same string, joined on email, so `customIdTokenClaims` puts `email` and `email_verified`
on the ID token, lowercased. `test/flow.test.ts` asserts the claim is byte-equal to what
`/oauth2/userinfo` returns for the same session.

The signing key lives in the `jwks` table in `idp.db`, private half encrypted under
`BETTER_AUTH_SECRET`. `bun run reset` leaves it alone, for the same reason it leaves the
OAuth client alone: minting a new key pair would start failing ID-token verification for
anything holding the old key set.

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

**Every address is lowercased on the way in, and `user.email` is `collate nocase`.** Type
the variables in whatever case the Arcade invites used. Before #58 a persona configured
as `Dana.Okafor@…` could not log in at all: Better Auth lowercases the address before it
looks the row up, SQLite compares text case-sensitively, and the login page reports the
unreachable row as "That email and password did not match" — the same sentence it gives a
wrong password.

## The OAuth client

Exactly one, named `Arcade`, created on first boot if absent: confidential,
`token_endpoint_auth_method: client_secret_post`, PKCE required, redirect URIs from
`IDP_OAUTH_REDIRECT_URIS`. Better Auth generates the `client_id` and `client_secret`; they
cannot be pinned from env.

```sh
bun run --cwd apps/idp oauth-client           # client id and endpoints
bun run --cwd apps/idp oauth-client --json    # the same, machine-readable
bun run --cwd apps/idp oauth-client --rotate  # mint a new secret, same client id
```

### ⚠️ The secret is printed exactly once

The secret is stored **hashed**, so it can be read only by whichever run produced it —
creation or `--rotate`. Every later run prints the id and the endpoints and says plainly
that the secret cannot be shown again. Write it down when it appears.

This is the price of the key set. Before #70 the secret was stored encrypted and could be
re-printed on any later day, which Better Auth permits only with the JWT plugin off — and
with it off there is no `jwks_uri`, and no Arcade User Source (#65).

If the secret is lost, `--rotate` mints a new one under the **same client id**. Only the
secret field in the Arcade dashboard changes; the registration itself survives. Rotating
leaves the redirect URIs, the consents and the signing keys alone.

Note that the service itself creates the client when it boots on an empty disk, and
nothing prints that secret. `/health` says so — `client_secret_state: "created"` — and the
way to get a usable one is `--rotate`.

On Render: open a shell on the `cg-idp` service and run `bun run oauth-client`. The boot
log carries the id, never the secret. If the shell does not carry `RENDER_EXTERNAL_URL`,
the script warns on stderr that the URLs it prints point at localhost; the credentials are
still right, and `/health` on the running service has the real URLs. Setting
`IDP_PUBLIC_URL` on the service removes the question.

Changing `IDP_OAUTH_REDIRECT_URIS` updates the client in place. The credentials do not change.

### What `/health` says about the secret

`oauth.client_secret_state` is one of four values, and the boot log says the same thing in
a sentence. Only one of them costs a human anything:

| State | Meaning |
|---|---|
| `unchanged` | Stored hashed already. Nothing happened. |
| `created` | This boot created the client. The secret has never been disclosed; `--rotate` to get one. |
| `migrated` | A secret stored by the pre-#70 build was re-hashed in place. **Client id and secret unchanged — the Arcade registration is still valid.** |
| `rotated` | The pre-#70 secret could not be decrypted with this `BETTER_AUTH_SECRET`, so it was unrecoverable and a new one was minted. **The Arcade `cg-idp` provider must be re-registered.** Logged on stderr. |

One line tells you which the live service took:

```sh
curl -s https://<idp-host>/health | jq -r '.oauth.client_secret_state'
```

### Registering it in Arcade (#13)

Custom OAuth 2.0 provider, from the output of the script above:

| Arcade field | Value |
|---|---|
| Client ID | as printed by `oauth-client` |
| Client secret | as printed **at creation or by `--rotate`**; it is not retrievable afterwards |
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

### Registering it as an Arcade User Source (#65)

A different Arcade object from the provider above, and the reason #70 exists. It reads
OIDC discovery, so it needs far fewer fields — and it is the one that refused this issuer
before the key set existed.

| Arcade field | Value |
|---|---|
| Issuer | `https://<idp-host>` — must match `iss` on the ID token exactly, no trailing slash |
| Client ID / Client secret | the same client as above |
| **Subject claim** | **`email`** — on the ID token, put there by `customIdTokenClaims`. Not `sub`, which is an opaque uuid and would break the join key. |
| Redirect URI to allowlist | `https://cloud.arcade.dev/oauth2/intermediate_callback`, added to `IDP_OAUTH_REDIRECT_URIS` |

Arcade discovers `jwks_uri` itself. Confirm it is there before filling the form in:

```sh
curl -s https://<idp-host>/.well-known/openid-configuration \
  | jq '{jwks_uri, id_token_signing_alg_values_supported}'
# { "jwks_uri": "https://<idp-host>/jwks", "id_token_signing_alg_values_supported": ["RS256"] }
```

## ⚠️ Reset does not rotate the client

`scripts/reset` (#23) exists so the demo can be rehearsed from clean. If resetting
`idp.db` regenerated the client, the registration in the Arcade dashboard would go stale
and OAuth would break at the next authorize — minutes before presenting, with no hook
fired and the panel dark.

So the reset for this database is its own script, and it clears **people and their
state** — users, credentials, sessions, tokens, consents — while leaving the `oauthClient`
row and the `jwks` signing keys alone:

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

## The schema on a disk that already exists

`idp.db` sits on a Render disk, so every schema change after the first meets a database
that predates it. The revision lives in `PRAGMA user_version`, the same shape #60 put into
`apps/hooks` and `apps/loan-app`, and there are three paths:

- **Fresh database** — `seed()`, unchanged: the DDL, the fixture rows *and* the version
  stamp in one transaction, so a half-failed seed leaves no tables at all rather than a
  schema with no people.
- **Existing database** — idempotent DDL only, no inserts. `src/schema.sql` stays
  byte-identical to what Better Auth compiles (so `generate:check` compares like with
  like) and `idempotentSchema` derives the `CREATE ... IF NOT EXISTS` form at runtime. It
  **throws** on a statement it cannot rewrite rather than skipping it, because a statement
  that silently does not run looks exactly like a schema that is already current.
- **A database this build cannot read** — `user_version` greater than `SCHEMA_VERSION`
  throws `SchemaTooNewError` from `openPeople`, before the port opens, naming the file.

**The limit:** this buys new tables and new indexes. An added column needs a guarded
`ALTER TABLE ... ADD COLUMN` here, the way `apps/loan-app` does it, or a reset.

Before #70 there was no upgrade path at all — `seed()` was the only thing that ran the
DDL, and it ran only when the `user` table was missing (#69). The JWT plugin adds the
`jwks` table, so on the live disk the service would have come up green and failed on the
first ID token. `test/schema-upgrade.test.ts` boots a pre-#70 database, with its encrypted
client row, and holds both halves.

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
| `BETTER_AUTH_SECRET` | Signs sessions and the OAuth query, and encrypts the ID-token signing key at rest. Generated by Render. Required in production; a fixed dev value otherwise. Changing it on a pre-#70 disk is what turns the client-secret migration into a rotation. |
| `IDP_PUBLIC_URL` | Public origin and OAuth issuer. Falls back to Render's `RENDER_EXTERNAL_URL`, then `http://localhost:PORT`. |
| `IDP_OAUTH_REDIRECT_URIS` | Comma-separated. Defaults to Arcade Cloud's callback. |
| `PERSONA_*_EMAIL` | The four persona addresses, read at first seed. Lowercased before they are stored; case does not have to match Arcade. |
