/**
 * The enterprise's identity provider — a demo fixture standing in for the real
 * one, the same category of thing as the persona switcher. A forker deletes
 * this service and points Arcade at their Okta.
 *
 * Better Auth serves the OAuth 2.1 endpoints; this file serves the two pages
 * the plugin redirects to (login and consent), turns their HTML form posts into
 * the JSON calls Better Auth expects, and answers `/health`. Nothing here knows
 * what a loan is or who is allowed to do what.
 */
import { createAuth, CONSENT_PAGE, ID_TOKEN_ALG, JWKS_PATH, LOGIN_PAGE } from "./auth.ts";
import { CLIENT_SECRET_STATE_MESSAGE, ensureOAuthClient, findClientName } from "./client.ts";
import { readConfig, usingDevSecret } from "./config.ts";
import { countPeople, openPeople } from "./db.ts";
import { renderConsentPage, renderLoginPage, renderMessagePage } from "./pages.ts";

const SERVICE = "idp";
const config = readConfig();

const db = await openPeople(config.dbPath);
const auth = createAuth({ db, baseURL: config.baseURL, secret: config.secret });

// Create-if-absent. Credentials are deliberately not logged: read them with
// `bun run oauth-client`. Only the fact and the id, which is public anyway.
const client = await ensureOAuthClient(auth, {
  redirectUris: config.redirectUris,
  secret: config.secret,
});

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/**
 * Calls a Better Auth endpoint the way its own client would — JSON body,
 * the browser's cookies, and an `Origin` that passes the CSRF check — and
 * returns the raw response so `Set-Cookie` and redirects can be passed on.
 */
async function callAuth(
  path: string,
  body: Record<string, unknown>,
  incoming: Request,
): Promise<Response> {
  const headers = new Headers({
    "Content-Type": "application/json",
    Origin: config.baseURL,
    // A page navigation, so the plugin answers the continued authorize flow
    // with a redirect rather than a JSON `{ redirect, url }` body.
    Accept: "text/html",
    "Sec-Fetch-Mode": "navigate",
  });
  for (const name of ["cookie", "user-agent", "x-forwarded-for"]) {
    const value = incoming.headers.get(name);
    if (value) headers.set(name, value);
  }

  return auth.handler(
    new Request(`${config.baseURL}${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
  );
}

/**
 * The plugin's continued-authorize step ends in a redirect. Depending on how
 * it classified the request that arrives as either a 3xx or a JSON body with
 * the URL in it; either way the browser gets a 303 carrying every cookie the
 * auth call set.
 */
async function redirectFrom(response: Response): Promise<Response | null> {
  let location = response.headers.get("location");

  if (!location && response.ok) {
    const body = (await response.clone().json().catch(() => null)) as
      | { url?: string; redirect_uri?: string; redirect?: boolean }
      | null;
    location = body?.url ?? body?.redirect_uri ?? null;
  }
  if (!location) return null;

  const headers = new Headers({ Location: location });
  for (const cookie of response.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

async function loginPage(url: URL, extra: { error?: string; email?: string } = {}): Promise<Response> {
  const clientId = url.searchParams.get("client_id");
  return html(
    renderLoginPage({
      oauthQuery: url.search.slice(1),
      clientName: clientId ? await findClientName(auth, clientId) : null,
      error: extra.error,
      email: extra.email,
    }),
    extra.error ? 401 : 200,
  );
}

async function handleLogin(request: Request): Promise<Response> {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const oauthQuery = String(form.get("oauth_query") ?? "");
  const pageUrl = new URL(`${LOGIN_PAGE}?${oauthQuery}`, config.baseURL);

  // `oauth_query` rides along in the sign-in body: the plugin verifies its
  // signature, and once the session cookie is set it resumes the authorize
  // flow itself — on to consent, or straight back to Arcade with a code.
  const body: Record<string, unknown> = { email, password };
  if (oauthQuery) body.oauth_query = oauthQuery;

  const response = await callAuth("/sign-in/email", body, request);

  if (response.status === 401 || response.status === 403 || response.status === 400) {
    // The plugin checks the signed query *before* the password, in a
    // before-hook, and a query that is tampered with or older than ten minutes
    // fails there as `invalid_signature`. Telling that persona their password
    // was wrong would send them retyping it forever — the stale query is in
    // the hidden field. Tell them the truth and where to restart.
    const failure = (await response.clone().json().catch(() => null)) as
      | { error?: string; code?: string }
      | null;
    const expired = failure?.error === "invalid_signature" || failure?.code === "INVALID_SIGNATURE";

    return loginPage(pageUrl, {
      error: expired
        ? "This sign-in request has expired. Go back to the application and start again."
        : "That email and password did not match.",
      email,
    });
  }
  if (!response.ok && response.status < 300) {
    return html(renderMessagePage("Sign-in failed", `The identity provider answered ${response.status}.`), 502);
  }

  const redirect = await redirectFrom(response);
  if (redirect) return redirect;

  // Signed in with no OAuth flow to continue: nothing to hand back to.
  const headers = new Headers({ Location: "/" });
  for (const cookie of response.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

async function consentPage(request: Request, url: URL): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    // No session — the plugin would have sent them to login first, so this is
    // a stale tab or a hand-typed URL. Same query, login page.
    return Response.redirect(new URL(`${LOGIN_PAGE}${url.search}`, config.baseURL).toString(), 303);
  }

  const clientId = url.searchParams.get("client_id") ?? "";
  const clientName = (await findClientName(auth, clientId)) ?? "An application";
  const scopes = (url.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean);

  return html(
    renderConsentPage({
      oauthQuery: url.search.slice(1),
      clientName,
      scopes,
      user: { name: session.user.name, email: session.user.email },
    }),
  );
}

async function handleConsent(request: Request): Promise<Response> {
  const form = await request.formData();
  const accept = form.get("decision") === "allow";
  const oauthQuery = String(form.get("oauth_query") ?? "");

  const response = await callAuth("/oauth2/consent", { accept, oauth_query: oauthQuery }, request);
  const redirect = await redirectFrom(response);
  if (redirect) return redirect;

  if (response.status === 401) {
    return Response.redirect(new URL(`${LOGIN_PAGE}?${oauthQuery}`, config.baseURL).toString(), 303);
  }
  return html(
    renderMessagePage("Consent failed", `The identity provider answered ${response.status}.`),
    502,
  );
}

/**
 * The token endpoint, named once. Everything else Better Auth serves goes
 * through the catch-all below; this one path is wrapped so a rejection leaves
 * a line behind.
 */
const TOKEN_PATH = "/oauth2/token";

/** RFC 7235 scheme token, so a garbage `Authorization` header is reported as garbage. */
const AUTH_SCHEME = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]{1,32})(?=\s|$)/;

/** The `Authorization` header and the form body of one token request, read once. */
interface TokenRequest {
  authorization: string | null;
  form: URLSearchParams;
}

/**
 * Which client authentication method the request actually used, classified the
 * same way `@better-auth/oauth-provider` classifies it
 * (`extractClientCredentials`): assertion first, then the `Authorization`
 * header, then credentials in the form body, then a bare `client_id`.
 *
 * This is the field spike #75 went looking for and could not find. A client
 * registered for one method and sending the other is refused with
 * `invalid_client` **before the secret is checked**, so from the outside it is
 * indistinguishable from a wrong secret — and the caller is Arcade, server to
 * server, with nothing user-visible to report it.
 */
function observedClientAuth({ authorization, form }: TokenRequest): string {
  if (form.get("client_assertion") || form.get("client_assertion_type")) return "private_key_jwt";
  if (authorization) {
    const scheme = AUTH_SCHEME.exec(authorization)?.[1];
    if (!scheme) return "authorization header: malformed";
    return /^basic$/i.test(scheme) ? "client_secret_basic" : `authorization scheme: ${scheme}`;
  }
  if (form.get("client_id") && form.get("client_secret")) return "client_secret_post";
  if (form.get("client_id")) return "none";
  return "absent";
}

/**
 * The `client_id` the request claims, from wherever it put it. Used only to
 * compare against the registered one — see `logTokenFailure` for why the value
 * itself never reaches the log.
 */
function requestClientId({ authorization, form }: TokenRequest): string | null {
  if (authorization && /^Basic +/i.test(authorization)) {
    try {
      const decoded = Buffer.from(authorization.replace(/^Basic +/i, ""), "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon === -1) return null;
      // Form-url-decoded, per RFC 6749 §2.3.1 — `+` is a space, not a plus.
      // `decodeBasicCredentials` in @better-auth/core does the same, and this
      // has to classify the id the same way the plugin resolves it.
      return new URLSearchParams(`v=${decoded.slice(0, colon)}`).get("v");
    } catch {
      return null;
    }
  }
  return form.get("client_id");
}

/**
 * One line per `/oauth2/token` rejection: the status, the OAuth error, its
 * description, and the client authentication method the caller used.
 *
 * That last field is the whole point. Before it, a refusal here was a two-way
 * question nobody could answer from outside — a wrong secret and a client
 * registered for the other auth method produce the same `invalid_client`, and
 * this service logged only its boot lines (#75).
 *
 * **No secret is ever on this line, structurally.** The client id is not echoed
 * from the request either: under Basic it lives in the same base64 blob as the
 * secret, and a caller that swapped the two fields would have us print one. So
 * the request's id is compared against the registered one and the line says
 * which of the two it was — enough to tell "Arcade is pointed at a different
 * client" from "Arcade has the wrong secret", which is the question anyone
 * reading this line is asking.
 */
async function logTokenFailure(token: TokenRequest, response: Response, registeredClientId: string) {
  const body = (await response.clone().json().catch(() => null)) as
    | { error?: string; error_description?: string }
    | null;
  const claimed = requestClientId(token);

  console.log(
    `[${SERVICE}] POST ${TOKEN_PATH} rejected: status=${response.status} ` +
      `error=${body?.error ?? "(none)"} ` +
      `error_description=${JSON.stringify(body?.error_description ?? "(none)")} ` +
      `client_auth=${JSON.stringify(observedClientAuth(token))} ` +
      `client_id=${claimed === registeredClientId ? registeredClientId : "(not the registered client)"}`,
  );
}

const server = Bun.serve({
  port: config.port,
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "GET" && pathname === "/health") {
      return Response.json({
        status: "ok",
        service: SERVICE,
        issuer: config.baseURL,
        people: countPeople(db),
        oauth: {
          client_id: client.clientId,
          authorize: `${config.baseURL}/oauth2/authorize`,
          token: `${config.baseURL}/oauth2/token`,
          userinfo: `${config.baseURL}/oauth2/userinfo`,
          jwks: `${config.baseURL}${JWKS_PATH}`,
          id_token_signing_alg: ID_TOKEN_ALG,
          // What the client row registers for at the token endpoint, and
          // therefore the one value the Arcade dashboard's "client
          // authentication" field may hold. Reported because the reconcile in
          // `ensureOAuthClient` is otherwise invisible: a row still on
          // `client_secret_post` fails server-to-server, fires no hook, and
          // leaves the panel dark (#61).
          token_endpoint_auth_method: client.tokenEndpointAuthMethod,
          // What happened to the stored client secret when this process
          // booted. `rotated` is the one that costs a human a re-registration
          // in the Arcade dashboard, and #70 exists because that is otherwise
          // indistinguishable from a service that came up fine (the failure
          // lands at the authorize step, where no hook fires).
          client_secret_state: client.secretState,
          client_secret_note: CLIENT_SECRET_STATE_MESSAGE[client.secretState],
        },
      });
    }

    if (pathname === LOGIN_PAGE) {
      if (request.method === "GET") return loginPage(url);
      if (request.method === "POST") return handleLogin(request);
    }
    if (pathname === CONSENT_PAGE) {
      if (request.method === "GET") return consentPage(request, url);
      if (request.method === "POST") return handleConsent(request);
    }

    if (request.method === "GET" && pathname === "/") {
      return html(
        renderMessagePage(
          "Enterprise Identity",
          "This is the demo's identity provider. Sign-in happens when an application sends you here.",
        ),
      );
    }

    // The token endpoint, wrapped only to leave a line behind when it says no.
    // The response itself is whatever Better Auth returned, byte for byte.
    if (request.method === "POST" && pathname === TOKEN_PATH) {
      // Read once and re-issued rather than cloned: a token request is one
      // small form post per authorization, and the handler needs an
      // undisturbed body whether or not anything ends up being logged.
      const body = await request.text();
      const response = await auth.handler(
        new Request(request.url, { method: "POST", headers: request.headers, body }),
      );
      if (response.status >= 400) {
        await logTokenFailure(
          { authorization: request.headers.get("authorization"), form: new URLSearchParams(body) },
          response,
          client.clientId,
        );
      }
      return response;
    }

    // Everything else is Better Auth: /oauth2/*, /.well-known/*, /sign-in/*, ...
    return auth.handler(request);
  },
});

console.log(
  `[${SERVICE}] listening on :${server.port} — issuer ${config.baseURL}, ` +
    `${countPeople(db)} people in ${config.dbPath}, ` +
    `OAuth client ${client.clientId} (${client.created ? "created" : "existing"}), ` +
    `JWKS ${config.baseURL}${JWKS_PATH} (${ID_TOKEN_ALG})` +
    (usingDevSecret(config) ? " — using the development secret" : ""),
);

// Its own line, and on stderr when it is the one that costs a human something,
// so `render logs` shows it without anyone having to know to look. The secret
// itself is never printed here, whatever happened to it — `bun run
// oauth-client --rotate` is the only thing that prints one.
const secretLine = `[${SERVICE}] OAuth client secret: ${CLIENT_SECRET_STATE_MESSAGE[client.secretState]}`;
if (client.secretState === "rotated") console.error(secretLine);
else console.log(secretLine);

// The other thing that can cost a human a field in the Arcade dashboard, and
// the one this boot may just have changed underneath them. On stderr for the
// same reason the rotation line is: `render logs` shows it without anyone
// having to know to look.
if (client.authMethodReconciled) {
  console.error(
    `[${SERVICE}] OAuth client token auth method reconciled to ` +
      `${client.tokenEndpointAuthMethod} (#61). The Arcade cg-idp provider's ` +
      `"client authentication" must now be ${client.tokenEndpointAuthMethod} — ` +
      `the credentials are unchanged, and the other form is refused with invalid_client.`,
  );
}
