/**
 * Environment, read in one place so the server and the scripts agree on it.
 * Every variable is documented in the repo's `.env.example`.
 */

/** Arcade Cloud's OAuth callback. Confirm against the "Redirect URL" the Arcade dashboard shows (#13). */
export const DEFAULT_ARCADE_REDIRECT_URI = "https://cloud.arcade.dev/api/v1/oauth/callback";

/**
 * A fixed secret for local runs only. Refused under NODE_ENV=production —
 * Render generates a real one (`generateValue: true` in render.yaml).
 */
const DEV_SECRET = "cg-idp-dev-secret-not-for-production-0000000000";

export interface IdpConfig {
  port: number;
  dbPath: string;
  /** Public origin and OAuth issuer. */
  baseURL: string;
  secret: string;
  redirectUris: string[];
}

export function readConfig(env: Record<string, string | undefined> = process.env): IdpConfig {
  const port = Number(env.PORT ?? 8083);

  const secret = env.BETTER_AUTH_SECRET?.trim();
  if (!secret && env.NODE_ENV === "production") {
    throw new Error("BETTER_AUTH_SECRET is required in production");
  }

  // Render injects RENDER_EXTERNAL_URL into every service, so on Render
  // nothing has to be configured; locally the fallback is the port.
  const baseURL = (env.IDP_PUBLIC_URL ?? env.RENDER_EXTERNAL_URL ?? `http://localhost:${port}`)
    .trim()
    .replace(/\/+$/, "");

  const redirectUris = (env.IDP_OAUTH_REDIRECT_URIS ?? DEFAULT_ARCADE_REDIRECT_URI)
    .split(",")
    .map((uri) => uri.trim())
    .filter(Boolean);

  return {
    port,
    dbPath: env.IDP_DB_PATH ?? "./idp.db",
    baseURL,
    secret: secret || DEV_SECRET,
    redirectUris,
  };
}

export function usingDevSecret(config: IdpConfig): boolean {
  return config.secret === DEV_SECRET;
}
