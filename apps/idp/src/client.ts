/**
 * The one OAuth client: Arcade.
 *
 * Better Auth generates `client_id` and `client_secret`; they cannot be pinned
 * from env. So they are born on first bootstrap, live in `idp.db`, and
 * `scripts/oauth-client.ts` prints them for whoever fills in the Arcade
 * dashboard (#13). Everything here is idempotent: a second call finds the
 * existing client and returns the same credentials.
 */
import { generateRandomString } from "better-auth/crypto";

import type { Auth } from "./auth.ts";
import { clientSecretStorage, SCOPES } from "./auth.ts";

/** How the client is found again. The name is the identity; the id is generated. */
export const OAUTH_CLIENT_NAME = "Arcade";

/**
 * PKCE is **on**. OAuth 2.1 requires it, Better Auth defaults to it, and
 * Arcade supports it (`pkce.enabled: true`, S256) but ships with it off — #13
 * must turn it on when registering the provider, or the authorize step fails
 * with no hook fired and nothing on the panel. Stated here so the two sides
 * can be checked against one line.
 */
export const REQUIRE_PKCE = true;

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  /** True when this call created the client; false when it already existed. */
  created: boolean;
}

interface StoredClient {
  id: string;
  clientId: string;
  clientSecret: string | null;
  redirectUris: string | string[];
}

/**
 * Finds the Arcade client or creates it. On the existing client, brings the
 * redirect URIs in line with `redirectUris` without touching the credentials —
 * Arcade's generated redirect URL is read off its dashboard, so it may only be
 * known after the first deploy, and correcting it must not rotate anything.
 */
export async function ensureOAuthClient(
  auth: Auth,
  { redirectUris, secret }: { redirectUris: string[]; secret: string },
): Promise<OAuthClientCredentials> {
  const ctx = await auth.$context;
  const existing = await ctx.adapter.findOne<StoredClient>({
    model: "oauthClient",
    where: [{ field: "name", value: OAUTH_CLIENT_NAME }],
  });

  if (existing) {
    if (!existing.clientSecret) {
      throw new Error(`OAuth client "${OAUTH_CLIENT_NAME}" has no stored secret`);
    }

    const stored = parseUris(existing.redirectUris);
    if (!sameSet(stored, redirectUris)) {
      await ctx.adapter.update({
        model: "oauthClient",
        where: [{ field: "id", value: existing.id }],
        update: { redirectUris, updatedAt: new Date() },
      });
    }

    return {
      clientId: existing.clientId,
      clientSecret: await clientSecretStorage(secret).decrypt(existing.clientSecret),
      redirectUris,
      created: false,
    };
  }

  // Written through Better Auth's adapter rather than its create-client
  // endpoints: every one of those, the admin one included, demands a signed-in
  // user and records that user as the client's owner — and `oauthClient.userId`
  // cascades on delete, so a reset that removes the people would remove the
  // client with them. That is the exact failure this service must not have.
  // Written this way the client belongs to nobody and outlives every reset.
  const clientId = generateRandomString(32, "a-z", "A-Z", "0-9");
  const clientSecret = generateRandomString(48, "a-z", "A-Z", "0-9");
  const now = new Date();

  await ctx.adapter.create({
    model: "oauthClient",
    data: {
      clientId,
      clientSecret: await clientSecretStorage(secret).encrypt(clientSecret),
      name: OAUTH_CLIENT_NAME,
      redirectUris,
      scopes: [...SCOPES],
      tokenEndpointAuthMethod: "client_secret_post",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      applicationType: "web",
      requirePKCE: REQUIRE_PKCE,
      skipConsent: false,
      disabled: false,
      createdAt: now,
      updatedAt: now,
    },
  });

  return { clientId, clientSecret, redirectUris, created: true };
}

/** Looks the client up by `client_id`, for the consent page's "X wants access" line. */
export async function findClientName(auth: Auth, clientId: string): Promise<string | null> {
  const ctx = await auth.$context;
  const client = await ctx.adapter.findOne<{ name: string | null }>({
    model: "oauthClient",
    where: [{ field: "clientId", value: clientId }],
  });
  return client?.name ?? null;
}

function parseUris(value: string | string[]): string[] {
  return Array.isArray(value) ? value : (JSON.parse(value) as string[]);
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().every((uri, i) => uri === [...b].sort()[i]);
}
