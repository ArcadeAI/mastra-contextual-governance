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
import { createAuth, CONSENT_PAGE, LOGIN_PAGE } from "./auth.ts";
import { ensureOAuthClient, findClientName } from "./client.ts";
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

    // Everything else is Better Auth: /oauth2/*, /.well-known/*, /sign-in/*, ...
    return auth.handler(request);
  },
});

console.log(
  `[${SERVICE}] listening on :${server.port} — issuer ${config.baseURL}, ` +
    `${countPeople(db)} people in ${config.dbPath}, ` +
    `OAuth client ${client.clientId} (${client.created ? "created" : "existing"})` +
    (usingDevSecret(config) ? " — using the development secret" : ""),
);
