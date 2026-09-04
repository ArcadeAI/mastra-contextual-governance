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
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";

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

export interface AuthConfig {
  db: Database;
  /** Public origin, e.g. `https://cg-idp.onrender.com`. Also the OAuth issuer. */
  baseURL: string;
  /** Signs sessions and the OAuth query, and encrypts the stored client secret. */
  secret: string;
}

/**
 * The client secret is stored **encrypted, not hashed**, so `scripts/
 * oauth-client.ts` can print it again. Better Auth generates the secret and a
 * human has to read it out into the Arcade dashboard; with the default hashed
 * storage there is exactly one chance to see it, at creation, and a lost
 * terminal means a rotated client and a stale Arcade registration. The key is
 * the same secret Better Auth signs sessions with.
 *
 * Better Auth only permits encrypted storage with `disableJwtPlugin: true`,
 * which is why access tokens here are opaque rather than JWTs (see
 * `createAuth`).
 */
export function clientSecretStorage(secret: string) {
  return {
    encrypt: (clientSecret: string) => symmetricEncrypt({ key: secret, data: clientSecret }),
    decrypt: (stored: string) => symmetricDecrypt({ key: secret, data: stored }),
  };
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
      oauthProvider({
        loginPage: LOGIN_PAGE,
        consentPage: CONSENT_PAGE,
        scopes: [...SCOPES],
        // Exactly one client, created by `ensureOAuthClient` at bootstrap.
        // Arcade is registered by hand, so nothing needs `/oauth2/register`.
        allowDynamicClientRegistration: false,
        // Opaque access tokens, no JWT plugin, no signing keys to manage. Arcade
        // never inspects the token — it presents it to `/oauth2/userinfo` and
        // reads the email — and a resource server that needs to validate one
        // calls `/oauth2/introspect`. Also what makes encrypted client-secret
        // storage permissible, see `clientSecretStorage`.
        disableJwtPlugin: true,
        storeClientSecret: clientSecretStorage(secret),
      }),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(config: AuthConfig) {
  return betterAuth(authOptions(config));
}

export type Auth = ReturnType<typeof createAuth>;
