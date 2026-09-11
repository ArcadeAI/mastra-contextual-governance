/**
 * Better Auth, configured as an OAuth 2.1 authorization server.
 *
 * `@better-auth/oauth-provider` is the current plugin. It supersedes the
 * older `oidc-provider` plugin, which still shows up in the docs tree and in
 * search results — do not switch to it.
 */
import { oauthProvider } from "@better-auth/oauth-provider";
import type { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { symmetricDecrypt } from "better-auth/crypto";
import { jwt } from "better-auth/plugins/jwt";

/** Where the login and consent pages live. `index.ts` serves them; the plugin redirects to them. */
export const LOGIN_PAGE = "/login";
export const CONSENT_PAGE = "/consent";

/**
 * Every Better Auth route hangs off the site root — `/oauth2/authorize`,
 * `/oauth2/token`, `/oauth2/userinfo`, `/.well-known/openid-configuration`.
 * These are the URLs a human types into the Arcade dashboard, and a `/api/auth`
 * prefix on an identity provider's public endpoints would be one more thing to
 * get wrong.
 */
export const BASE_PATH = "/";

export const SCOPES = ["openid", "profile", "email", "offline_access"] as const;

/**
 * The signing algorithm for ID tokens, and therefore the one key type in the
 * published JWKS.
 *
 * Better Auth's JWT plugin defaults to **EdDSA** (Ed25519). This is pinned to
 * **RS256** instead, deliberately: Arcade validates our ID token against the
 * key set it fetches from `jwks_uri` (#65), Ed25519 JWS support is uneven
 * across verifiers, and RS256 is the algorithm every OIDC relying party
 * implements. An IdP whose only key an Arcade User Source cannot verify
 * publishes a JWKS that satisfies the discovery check and fails at the token
 * — the same shape of silent nothing this project keeps out of its controls.
 */
export const ID_TOKEN_ALG = "RS256" as const;

/** RSA key size. 2048 is the OIDC floor and what every relying party accepts. */
export const ID_TOKEN_MODULUS_LENGTH = 2048;

/**
 * Where the key set is served, relative to the issuer. The JWT plugin's
 * default, restated here because `jwks_uri` in the discovery document and
 * `/health` both have to name the same path.
 */
export const JWKS_PATH = "/jwks";

export interface AuthConfig {
  db: Database;
  /** Public origin, e.g. `https://cg-idp.onrender.com`. Also the OAuth issuer. */
  baseURL: string;
  /** Signs sessions, signs the OAuth query, and encrypts the stored JWKS private key. */
  secret: string;
}

/**
 * Hashes a client secret for storage: SHA-256, base64url, unpadded.
 *
 * Byte-for-byte what `@better-auth/oauth-provider`'s own `defaultHasher` does,
 * but ours rather than the library's, and passed in as `storeClientSecret`.
 * The migration in `client.ts` has to write a hash the plugin will later
 * accept, so exactly one function in this service may decide what a stored
 * secret looks like. Reaching into the library's internal for it would let the
 * two drift on an upgrade, and the failure mode is a client that cannot
 * authenticate at the token endpoint — a step that fires no hook.
 */
export async function hashClientSecret(clientSecret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientSecret));
  return Buffer.from(digest).toString("base64url");
}

/**
 * The client secret is stored **hashed**, so it can be read exactly once: at
 * creation, by whoever created it. `scripts/oauth-client.ts` prints it then
 * and says plainly on every later run that it cannot be shown again;
 * `--rotate` mints a new one under the same client id.
 *
 * Before #70 it was stored encrypted so the script could re-print it on any
 * later day. That is only permitted with `disableJwtPlugin: true`, which is
 * what left this IdP with HS256 ID tokens and no `jwks_uri` — and an IdP with
 * no published keys cannot back an Arcade User Source (#65, measured). The
 * plugin refuses the combination outright: `encryption method not recommended`
 * with the JWT plugin on, `unable to store hashed secrets` with it off. So the
 * print-once secret is the price of the key set, not a preference.
 */
export function clientSecretStorage() {
  return { hash: hashClientSecret };
}

/**
 * Reads a client secret written by the **pre-#70** build, which stored it
 * encrypted under `BETTER_AUTH_SECRET`.
 *
 * Used once, at boot, to carry the live `cg-idp` client across the change
 * without rotating it — see `migrateStoredClientSecret`. Throws on anything
 * that is not ciphertext this key opens; the cipher is authenticated, so that
 * is a real check and not a guess at the format.
 */
export function decryptLegacyClientSecret(secret: string, stored: string): Promise<string> {
  return symmetricDecrypt({ key: secret, data: stored });
}

/**
 * Puts the person's email into the ID token.
 *
 * Better Auth blanks every standard profile claim in the ID token on purpose
 * (`ID_TOKEN_SCOPE_CLAIM_GUARDS`) and points relying parties at
 * `/oauth2/userinfo` instead, so out of the box the only identity an ID token
 * carries is `sub` — an opaque uuid. Arcade's User Source identifies the
 * person from a configured subject claim **on the ID token** (#65), and
 * DESIGN.md's third identity rule is that the Arcade `user_id`, the OAuth
 * subject and the loan book's actor column are the same string, joined on
 * email. A User Source keyed on `sub` would make the Arcade user a uuid while
 * `governance.db` and `loans.db` hold addresses — open risk 4, which is the
 * one that leaves every test passing while the audit trail describes two
 * different people.
 *
 * Lowercased here as well as at the seed (#58), because this is the value
 * Arcade ends up holding and it must be byte-equal to what `/oauth2/userinfo`
 * returns and to what the loan book records.
 *
 * Only when the `email` scope was actually granted: a claim that appears
 * regardless of scope is a claim the consent screen did not describe.
 */
function idTokenIdentityClaims({
  user,
  scopes,
}: {
  user: { email: string; emailVerified: boolean } & Record<string, unknown>;
  scopes: readonly string[];
}): Record<string, unknown> {
  if (!scopes.includes("email")) return {};
  return { email: user.email.toLowerCase(), email_verified: user.emailVerified };
}

/**
 * The options, separately from the instance, because `scripts/generate-schema.ts`
 * derives `src/schema.sql` from exactly these — the table set depends on the
 * plugin list, and a schema generated from a different configuration is how
 * the seed and the library end up disagreeing about a column.
 */
export function authOptions({ db, baseURL, secret }: AuthConfig) {
  return {
    database: db,
    baseURL,
    basePath: BASE_PATH,
    secret,
    appName: "Enterprise Identity",
    emailAndPassword: { enabled: true },
    // No self-service signup: the people are seeded. A stranger who finds the
    // login page gets a login page, not an account.
    user: { changeEmail: { enabled: false } },
    plugins: [
      // Signing keys, and `GET /jwks`. Adds one table, `jwks`, which is the
      // whole reason `openPeople` needed an upgrade path before this could
      // deploy onto the live disk (#69, #70).
      //
      // The private key is encrypted at rest under `BETTER_AUTH_SECRET`
      // (the plugin's default). Changing that secret does not rotate the key
      // pair, it makes the stored one unreadable — same blast radius the
      // secret already had for the OAuth client row.
      jwt({
        jwks: { keyPairConfig: { alg: ID_TOKEN_ALG, modulusLength: ID_TOKEN_MODULUS_LENGTH } },
      }),
      oauthProvider({
        loginPage: LOGIN_PAGE,
        consentPage: CONSENT_PAGE,
        scopes: [...SCOPES],
        // Exactly one client, created by `ensureOAuthClient` at bootstrap.
        // Arcade is registered by hand, so nothing needs `/oauth2/register`.
        allowDynamicClientRegistration: false,
        // JWT plugin on (the default): ID tokens are signed with the RS256 key
        // above and `/.well-known/openid-configuration` carries a `jwks_uri`.
        // Access tokens stay opaque — they become JWTs only for a registered
        // `oauthResource`, and this service registers none — so
        // `apps/loan-app` keeps validating them at `/oauth2/userinfo`.
        storeClientSecret: clientSecretStorage(),
        customIdTokenClaims: idTokenIdentityClaims,
      }),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(config: AuthConfig) {
  return betterAuth(authOptions(config));
}

export type Auth = ReturnType<typeof createAuth>;
