/**
 * Prints what the Arcade dashboard needs (#13): the client id, the endpoints,
 * and — exactly once, at the moment it produces one — the client secret.
 *
 *   bun run --cwd apps/idp oauth-client            # id and endpoints
 *   bun run --cwd apps/idp oauth-client --json     # the same, machine-readable
 *   bun run --cwd apps/idp oauth-client --rotate   # mint a new secret, same client id
 *
 * **The secret is stored hashed and cannot be shown twice.** Before #70 it was
 * stored encrypted and this script could re-print it on any later day; that is
 * only permitted with the JWT plugin off, which is what left this IdP with no
 * `jwks_uri` and unable to back an Arcade User Source (#65). So: write it down
 * when it appears, and if it is lost, `--rotate` mints a new one under the
 * **same client id** — a lost secret costs one field in the Arcade dashboard,
 * not a re-registration.
 *
 * On Render: open a shell on the cg-idp service and run the same command.
 */
import { createAuth, JWKS_PATH } from "../src/auth.ts";
import {
  ensureOAuthClient,
  REQUIRE_PKCE,
  rotateOAuthClientSecret,
  TOKEN_ENDPOINT_AUTH_METHOD,
} from "../src/client.ts";
import { readConfig } from "../src/config.ts";
import { openPeople } from "../src/db.ts";

const config = readConfig();
const db = await openPeople(config.dbPath);
const auth = createAuth({ db, baseURL: config.baseURL, secret: config.secret });

const json = process.argv.includes("--json");
const rotate = process.argv.includes("--rotate");

// Always first, even when rotating: it is what creates the client on an empty
// database, and what carries a pre-#70 encrypted secret into hashed storage.
const ensured = await ensureOAuthClient(auth, {
  redirectUris: config.redirectUris,
  secret: config.secret,
});

// Rotating a client this call just created would throw away a secret nobody
// has seen and mint a second one for no reason.
const client = rotate && !ensured.created ? await rotateOAuthClientSecret(auth) : ensured;

if (config.baseURLIsFallback) {
  // The credentials are right regardless; the three URLs are not. On Render
  // this means the shell did not carry RENDER_EXTERNAL_URL — set IDP_PUBLIC_URL
  // on the service, or read the URLs off /health, which the running service
  // computes from its own environment.
  console.error(
    `[idp] warning: no IDP_PUBLIC_URL or RENDER_EXTERNAL_URL set — the URLs below point at ` +
      `${config.baseURL}, which is not the address Arcade should be given.`,
  );
}

/** Why the secret is or is not on screen. One sentence, no euphemism. */
const secretNote =
  client.clientSecret === null
    ? "not shown — the stored secret is hashed and cannot be printed again; run with --rotate to mint a new one under the same client id"
    : client.secretState === "rotated"
      ? "NEW — the previous secret no longer works. Update it in the Arcade dashboard; the client id is unchanged."
      : "shown once, now — it is stored hashed and cannot be printed again. Write it down.";

if (json) {
  console.log(
    JSON.stringify(
      {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        client_secret_state: client.secretState,
        client_secret_note: secretNote,
        created: client.created,
        rotated: client.secretState === "rotated",
        issuer: config.baseURL,
        authorize_url: `${config.baseURL}/oauth2/authorize`,
        token_url: `${config.baseURL}/oauth2/token`,
        userinfo_url: `${config.baseURL}/oauth2/userinfo`,
        jwks_url: `${config.baseURL}${JWKS_PATH}`,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: TOKEN_ENDPOINT_AUTH_METHOD,
        pkce: REQUIRE_PKCE ? "S256" : "off",
        scopes: "openid profile email offline_access",
        userinfo_email_jsonpath: "$.email",
      },
      null,
      2,
    ),
  );
} else {
  console.log(`OAuth client "${client.created ? "created" : "existing"}" in ${config.dbPath}\n`);
  console.log(`  client_id         ${client.clientId}`);
  console.log(`  client_secret     ${client.clientSecret ?? "(not shown)"}`);
  console.log(`                    ${secretNote}`);
  console.log(`  authorize URL     ${config.baseURL}/oauth2/authorize`);
  console.log(`  token URL         ${config.baseURL}/oauth2/token`);
  console.log(`  userinfo URL      ${config.baseURL}/oauth2/userinfo`);
  console.log(`  JWKS URL          ${config.baseURL}${JWKS_PATH}`);
  console.log(`  redirect URIs     ${client.redirectUris.join(", ")}`);
  console.log(
    `  client auth       ${TOKEN_ENDPOINT_AUTH_METHOD} (HTTP Basic — this is the Arcade dashboard default)`,
  );
  console.log(`  PKCE              ${REQUIRE_PKCE ? "required, S256 — enable it on the Arcade side" : "off"}`);
  console.log(`  scopes            openid profile email offline_access`);
  console.log(`  identity          userinfo JSONPath $.email`);
}

db.close();
