/**
 * Prints what the Arcade dashboard needs (#13): the client credentials and the
 * endpoints. Creates the client if `idp.db` has none; otherwise prints the one
 * that exists. Idempotent — run it as often as you like, the id never changes.
 *
 *   bun run --cwd apps/idp oauth-client
 *
 * On Render: open a shell on the cg-idp service and run the same command.
 * This is the only place the client secret is ever printed.
 */
import { createAuth } from "../src/auth.ts";
import { ensureOAuthClient, REQUIRE_PKCE } from "../src/client.ts";
import { readConfig } from "../src/config.ts";
import { openPeople } from "../src/db.ts";

const config = readConfig();
const db = await openPeople(config.dbPath);
const auth = createAuth({ db, baseURL: config.baseURL, secret: config.secret });

const client = await ensureOAuthClient(auth, {
  redirectUris: config.redirectUris,
  secret: config.secret,
});

const json = process.argv.includes("--json");

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

if (json) {
  console.log(
    JSON.stringify(
      {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        created: client.created,
        issuer: config.baseURL,
        authorize_url: `${config.baseURL}/oauth2/authorize`,
        token_url: `${config.baseURL}/oauth2/token`,
        userinfo_url: `${config.baseURL}/oauth2/userinfo`,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: "client_secret_post",
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
  console.log(`  client_secret     ${client.clientSecret}`);
  console.log(`  authorize URL     ${config.baseURL}/oauth2/authorize`);
  console.log(`  token URL         ${config.baseURL}/oauth2/token`);
  console.log(`  userinfo URL      ${config.baseURL}/oauth2/userinfo`);
  console.log(`  redirect URIs     ${client.redirectUris.join(", ")}`);
  console.log(`  client auth       client_secret_post (credentials in the token request body)`);
  console.log(`  PKCE              ${REQUIRE_PKCE ? "required, S256 — enable it on the Arcade side" : "off"}`);
  console.log(`  scopes            openid profile email offline_access`);
  console.log(`  identity          userinfo JSONPath $.email`);
}

db.close();
