#!/usr/bin/env bun
/**
 * Spike 05 — what `apps/idp` says at the token endpoint, per way of authenticating
 * the client, so a one-line failure in a Render log maps to a cause.
 *
 * Arcade's User Source exchanges the authorization code at our token endpoint and
 * reports only *"Token exchange with identity provider failed"* to the browser.
 * Two very different causes produce that: a **wrong client secret**, and a client
 * sending **`client_secret_basic`** to a client registered `client_secret_post`.
 * The first is fixed by re-entering a secret; the second is fixed by changing how
 * the client is registered (#61) and re-entering the secret will not help at all.
 *
 * This prints the exact message for each case. Run it against a **local** IdP:
 * it needs a client secret, and the live one is stored hashed (#70). The live IdP
 * cannot answer this question at all, because it checks the code before the
 * client — measured: a junk code returns `invalid_grant / invalid code` whether
 * the request carries no secret, a wrong secret or Basic auth.
 *
 *   IDP_ISSUER=http://localhost:4423 \
 *   IDP_CLIENT_ID=… IDP_CLIENT_SECRET=… \
 *   PERSONA_EMAIL=… PERSONA_PASSWORD=… \
 *   bun docs/spikes/evidence/05-token-auth-methods.ts
 *
 * The redirect URI it uses is a loopback port it binds itself (port 0, read back),
 * so that URI has to be on the client's allowlist — which for a local IdP means
 * passing `IDP_OAUTH_REDIRECT_URIS` when you start it. It prints the URI it wants
 * and stops if the IdP refuses it, rather than reporting a configuration problem
 * as a finding.
 */
import { Jar, Transcript, driveAuthorize, b64url, pkce, required } from "./05-drive.ts";

const ISSUER = (process.env.IDP_ISSUER ?? "http://localhost:4423").replace(/\/+$/, "");
const CLIENT_ID = required("IDP_CLIENT_ID");
const CLIENT_SECRET = required("IDP_CLIENT_SECRET");
const REDIRECT_URI = required("IDP_REDIRECT_URI");
const persona = { email: required("PERSONA_EMAIL"), password: required("PERSONA_PASSWORD") };

const t = new Transcript();

/** One complete login, for one single-use authorization code. */
async function freshCode(): Promise<{ code: string; verifier: string }> {
  const { verifier, challenge } = await pkce();
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const authorizeUrl = `${ISSUER}/oauth2/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid email",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })}`;
  const jar = new Jar();
  const result = await driveAuthorize(authorizeUrl, REDIRECT_URI, persona, t, {
    trustedPageHosts: [new URL(ISSUER).host],
    jar,
  });
  if (!result.landedOn) throw new Error(`the login did not reach ${REDIRECT_URI}: ${result.stoppedBecause}`);
  const code = new URL(result.landedOn).searchParams.get("code");
  if (!code) throw new Error(`no code on ${result.landedOn}`);
  return { code, verifier };
}

async function attempt(label: string, build: (code: string, verifier: string) => RequestInit) {
  const { code, verifier } = await freshCode();
  const res = await fetch(`${ISSUER}/oauth2/token`, build(code, verifier));
  const text = await res.text();
  console.log(`\n${label}\n  -> HTTP ${res.status} ${res.ok ? "(a token was issued)" : text}`);
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

await attempt("client_secret_post, correct secret — the configuration we have", (code, verifier) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: form({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code_verifier: verifier,
  }),
}));

await attempt("client_secret_post, WRONG secret — a stale secret in the dashboard", (code, verifier) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: form({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    client_secret: "not-the-secret-this-client-has",
    code_verifier: verifier,
  }),
}));

await attempt("client_secret_basic, correct secret — a relying party that prefers the header", (code, verifier) => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
  },
  body: form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
}));

await attempt("no client authentication at all — PKCE only, as a public client would", (code, verifier) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: form({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  }),
}));
