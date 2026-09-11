/**
 * The one OAuth client: Arcade.
 *
 * Better Auth generates `client_id` and `client_secret`; they cannot be pinned
 * from env. So they are born on first bootstrap, live in `idp.db`, and
 * `scripts/oauth-client.ts` prints them for whoever fills in the Arcade
 * dashboard (#13).
 *
 * Since #70 the secret is stored **hashed**, so it is readable exactly once —
 * by whoever created or rotated it. Everything here is still idempotent in the
 * sense that matters: a second call finds the existing client and returns the
 * same `client_id`, never a new one. It just cannot hand the secret back.
 */
import { generateRandomString } from "better-auth/crypto";

import type { Auth } from "./auth.ts";
import { decryptLegacyClientSecret, hashClientSecret, SCOPES } from "./auth.ts";

/** Shown on the login and consent pages: "Arcade is asking you to sign in." */
export const OAUTH_CLIENT_NAME = "Arcade";

/**
 * The row's primary key, fixed. The `client_id` is generated, and `name` has
 * no unique index, so the row is found — and, if two bootstraps interleave
 * (the service booting on a fresh disk while someone runs `oauth-client` in a
 * shell), the second insert is refused — on the one column SQLite will
 * enforce for us.
 */
export const OAUTH_CLIENT_ROW_ID = "arcade";

/**
 * PKCE is **on**. OAuth 2.1 requires it, Better Auth defaults to it, and
 * Arcade supports it (`pkce.enabled: true`, S256) but ships with it off — #13
 * must turn it on when registering the provider, or the authorize step fails
 * with no hook fired and nothing on the panel. Stated here so the two sides
 * can be checked against one line.
 */
export const REQUIRE_PKCE = true;

/**
 * What happened to the stored client secret on this call. Reported in the boot
 * log and at `/health`, because the two outcomes that are not `unchanged` have
 * opposite consequences for the Arcade registration and telling them apart
 * from the outside is otherwise impossible (#70).
 */
export type ClientSecretState =
  /** The client row already stored a hash. Nothing happened. */
  | "unchanged"
  /** This call created the client. The secret is in `clientSecret` and will never be readable again. */
  | "created"
  /**
   * The row held a secret encrypted by the pre-#70 build. It was decrypted and
   * re-hashed in place: **same client id, same secret, the Arcade registration
   * is still valid.**
   */
  | "migrated"
  /**
   * The row held a pre-#70 encrypted secret this `BETTER_AUTH_SECRET` cannot
   * decrypt, so the secret was unrecoverable and a new one was minted under
   * the same client id. **Arcade must be re-registered.**
   */
  | "rotated";

/** One line a human can act on, for the boot log and `/health`. */
export const CLIENT_SECRET_STATE_MESSAGE: Record<ClientSecretState, string> = {
  unchanged: "stored hashed; it cannot be printed again — `bun run oauth-client --rotate` mints a new one",
  created:
    "created on this boot and never disclosed — run `bun run oauth-client --rotate` to mint one you can read",
  migrated:
    "re-hashed in place from the pre-#70 encrypted form; client id and secret UNCHANGED, the Arcade registration is still valid",
  rotated:
    "ROTATED: the pre-#70 encrypted secret could not be decrypted with this BETTER_AUTH_SECRET. The Arcade cg-idp provider MUST be re-registered — run `bun run oauth-client --rotate` to print a readable secret",
};

export interface OAuthClientCredentials {
  clientId: string;
  /**
   * The secret in plaintext, and **only** when this call is the one that
   * produced it — creation or rotation. `null` on every later call: storage is
   * hashed, so there is nothing to read back. See `ClientSecretState`.
   */
  clientSecret: string | null;
  redirectUris: string[];
  /** True when this call created the client; false when it already existed. */
  created: boolean;
  secretState: ClientSecretState;
}

interface StoredClient {
  id: string;
  clientId: string;
  clientSecret: string | null;
  redirectUris: string | string[];
}

/** How long a secret Better Auth generates is, and what `--rotate` mints. */
const SECRET_LENGTH = 48;

/**
 * A secret written by the pre-#70 build: `symmetricEncrypt` with a string key
 * returns bare lowercase hex (xchacha20poly1305, 24-byte nonce + ciphertext +
 * 16-byte tag), so the shortest possible one is far longer than the 43
 * base64url characters a SHA-256 hash occupies. The shape is only a cheap
 * pre-filter — `decryptLegacyClientSecret` is the actual test, and the cipher
 * is authenticated, so it cannot mistake anything else for a legacy secret.
 */
function looksLikeLegacyCipherText(stored: string): boolean {
  return /^[0-9a-f]{64,}$/.test(stored) && stored.length % 2 === 0;
}

/**
 * Carries the live `cg-idp` client across #70's change of storage.
 *
 * Before #70 the secret was stored **encrypted** so `oauth-client` could
 * re-print it. Enabling the JWT plugin — which is what publishes the `jwks_uri`
 * an Arcade User Source requires (#65) — makes encrypted storage illegal; the
 * plugin throws `encryption method not recommended` at init. Storage becomes
 * hashed, and the secret already on the disk would never verify again.
 *
 * So the encrypted value is read one last time, with the same
 * `BETTER_AUTH_SECRET` that wrote it, and stored as the hash the plugin will
 * check from now on. **The client id and the secret both survive**, which is
 * the whole point: the credentials in the Arcade dashboard keep working and
 * nobody has to re-register anything.
 *
 * If it cannot be decrypted — a changed `BETTER_AUTH_SECRET`, a hand-edited
 * row — the secret is gone either way, since nothing can turn that value back
 * into something the token endpoint accepts. Leaving it would be a client that
 * silently fails to authenticate at the token endpoint, where no hook fires
 * and the panel stays dark (DESIGN.md, and the reason `bun run reset` exists
 * in the shape it does). So it is rotated instead, and said loudly, twice: in
 * the boot log and at `/health`.
 */
async function migrateStoredClientSecret(
  auth: Auth,
  existing: StoredClient,
  secret: string,
): Promise<{ state: ClientSecretState; clientSecret: string | null }> {
  if (!looksLikeLegacyCipherText(existing.clientSecret!)) {
    return { state: "unchanged", clientSecret: null };
  }

  const ctx = await auth.$context;

  let plaintext: string | null = null;
  try {
    plaintext = await decryptLegacyClientSecret(secret, existing.clientSecret!);
  } catch {
    plaintext = null;
  }

  const rotated = plaintext === null;
  const clientSecret = plaintext ?? generateRandomString(SECRET_LENGTH, "a-z", "A-Z", "0-9");

  await ctx.adapter.update({
    model: "oauthClient",
    where: [{ field: "id", value: existing.id }],
    update: { clientSecret: await hashClientSecret(clientSecret), updatedAt: new Date() },
  });

  return {
    state: rotated ? "rotated" : "migrated",
    // On a migration the caller already has whatever Arcade holds, and
    // printing it would put a still-valid secret into a boot log. Only the
    // rotation produces a secret nobody has yet.
    clientSecret: rotated ? clientSecret : null,
  };
}

/**
 * Mints a new secret for the existing client id, and returns it — the one
 * other moment a secret is readable.
 *
 * A lost secret must not cost a new client id: the id is half of what is
 * registered in Arcade, and changing it means editing more fields under more
 * pressure. Rotating leaves the id, the redirect URIs and every consent alone.
 * Exported for `scripts/oauth-client.ts --rotate`.
 */
export async function rotateOAuthClientSecret(auth: Auth): Promise<OAuthClientCredentials> {
  const ctx = await auth.$context;
  const existing = await findStoredClient(auth);
  if (!existing) throw new Error(`No OAuth client to rotate: idp.db holds no "${OAUTH_CLIENT_NAME}" row`);

  const clientSecret = generateRandomString(SECRET_LENGTH, "a-z", "A-Z", "0-9");
  await ctx.adapter.update({
    model: "oauthClient",
    where: [{ field: "id", value: existing.id }],
    update: { clientSecret: await hashClientSecret(clientSecret), updatedAt: new Date() },
  });

  return {
    clientId: existing.clientId,
    clientSecret,
    redirectUris: parseUris(existing.redirectUris),
    created: false,
    secretState: "rotated",
  };
}

/**
 * Finds the Arcade client or creates it. On the existing client, brings the
 * redirect URIs in line with `redirectUris` without touching the credentials —
 * Arcade's generated redirect URL is read off its dashboard, so it may only be
 * known after the first deploy, and correcting it must not rotate anything —
 * and carries a secret stored by the pre-#70 build into hashed storage, see
 * `migrateStoredClientSecret`.
 */
export async function ensureOAuthClient(
  auth: Auth,
  { redirectUris, secret }: { redirectUris: string[]; secret: string },
): Promise<OAuthClientCredentials> {
  const ctx = await auth.$context;
  const existing = await findStoredClient(auth);

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

    const migration = await migrateStoredClientSecret(auth, existing, secret);

    return {
      clientId: existing.clientId,
      clientSecret: migration.clientSecret,
      redirectUris,
      created: false,
      secretState: migration.state,
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

  try {
    await ctx.adapter.create({
      model: "oauthClient",
      forceAllowId: true,
      data: {
        id: OAUTH_CLIENT_ROW_ID,
        clientId,
        clientSecret: await hashClientSecret(clientSecret),
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
  } catch (error) {
    // Lost the race: another bootstrap inserted the row between our lookup
    // and our insert. Theirs is the client; ours never existed.
    if (!/UNIQUE|constraint/i.test(String(error))) throw error;
    return ensureOAuthClient(auth, { redirectUris, secret });
  }

  return { clientId, clientSecret, redirectUris, created: true, secretState: "created" };
}

/**
 * The one rule of this function: **never mint credentials while any client
 * row exists.** Arcade holds whatever was issued first; a second issuance is a
 * silent rotation, and it fails at the authorize step where no hook fires.
 *
 * So the lookup is by the fixed id first, then by name — a row written before
 * the id was fixed is adopted and re-keyed, not replaced — and if rows exist
 * that are neither, the boot fails loudly rather than serve credentials
 * Arcade does not have. A dead service is a thing a human can act on.
 */
async function findStoredClient(auth: Auth): Promise<StoredClient | null> {
  const ctx = await auth.$context;

  const byId = await ctx.adapter.findOne<StoredClient>({
    model: "oauthClient",
    where: [{ field: "id", value: OAUTH_CLIENT_ROW_ID }],
  });
  if (byId) return byId;

  const byName = await ctx.adapter.findMany<StoredClient>({
    model: "oauthClient",
    where: [{ field: "name", value: OAUTH_CLIENT_NAME }],
    limit: 2,
  });
  if (byName.length === 1) {
    const legacy = byName[0]!;
    await ctx.adapter.update({
      model: "oauthClient",
      where: [{ field: "id", value: legacy.id }],
      update: { id: OAUTH_CLIENT_ROW_ID },
    });
    return { ...legacy, id: OAUTH_CLIENT_ROW_ID };
  }

  const total = await ctx.adapter.count({ model: "oauthClient" });
  if (total > 0) {
    throw new Error(
      `idp.db holds ${total} OAuth client row(s) this service did not write ` +
        `(none with id "${OAUTH_CLIENT_ROW_ID}", ${byName.length} named "${OAUTH_CLIENT_NAME}"). ` +
        `Refusing to create another: the credentials registered in Arcade may be one of these. ` +
        `Inspect the oauthClient table and re-key the right row to id "${OAUTH_CLIENT_ROW_ID}".`,
    );
  }

  return null;
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
