/**
 * What the web service reads from its environment, in one place.
 *
 * Every address here is HOST-form (`host` or `host:port`), never a URL: the
 * consumer adds the scheme, and `baseUrl` is the one place that decides which.
 * The cross-service keys are `sync: false` in `render.yaml` and set by hand from
 * the value on each Render service page — `fromService` emitted the bare service
 * name rather than the hostname, which #59 has the measurement for.
 * `public-host.ts` refuses a value that still looks like one.
 *
 * Nothing here is `NEXT_PUBLIC_`, deliberately. `next build` inlines those into
 * the client bundle while Render supplies service env vars at runtime, so a
 * `NEXT_PUBLIC_` twin would be empty in production and fine under `next dev` —
 * the worst possible failure mode. Server components read this and pass what
 * the browser needs down as props.
 */
import { publicHost } from "./public-host.ts";

/**
 * Who the browser is signed in as, and the two OAuth hops that follow from it.
 *
 * `DESIGN.md` → **Identity** and **Two hops, two mechanisms**. Everything here
 * is read from the environment and none of it has a development fallback: an
 * identity provider you can reach without configuring one is a fixture that
 * would eventually be mistaken for a login. `/health` reports which of the
 * three capabilities the environment actually configured, so an unset variable
 * is visible before somebody discovers it mid-rehearsal.
 *
 * `idpIssuer` and `publicUrl` are **URLs**, not the HOST-form the cross-service
 * keys above use. They are origins a browser is redirected to and an OAuth
 * `redirect_uri` that has to match an allowlist byte for byte, so the scheme is
 * part of the value rather than something a consumer adds.
 */
export interface IdentityConfig {
  /** `IDP_ISSUER` — `apps/idp`'s public origin, no trailing slash. */
  idpIssuer: string;
  /** Client C: this service's own registration at the IdP, separate from the two Arcade holds. */
  idpClientId: string;
  idpClientSecret: string;
  /** What sign-in asks for. `email` is the join key, so it is not optional. */
  idpScopes: string;
  /** Seals the session cookie. No fallback — see `lib/identity/seal.ts`. */
  sessionSecret: string;
  /** This service's own public origin, no trailing slash. Every redirect_uri is built from it. */
  publicUrl: string;
  /** `ARCADE_GATEWAY_ID` — `cg-demo-us`, the User Source gateway hop 1 authorizes against. */
  gatewayId: string;
  /**
   * Arcade Cloud, which is a different host from `arcadeApiUrl`.
   *
   * `confirm_user` is `https://cloud.arcade.dev/api/v1/oauth/confirm_user`
   * (measured, spike #75) while tools execute against `api.arcade.dev`. One
   * variable for each, because pointing a test at a stand-in has to move the
   * verifier's calls without moving the gateway's.
   */
  cloudUrl: string;
}

export interface WebConfig {
  /** `apps/hooks`, which owns `governance.db` and the approvals store. */
  hooksHost: string;
  /** The shared bearer the `/approvals` endpoints require. */
  approvalsStoreToken: string;
  /** Arcade's API root. Overridden in tests by a stand-in. */
  arcadeApiUrl: string;
  arcadeApiKey: string;
  /** `tool.toolkit` as Arcade files the deployed approvals toolkit. */
  approvalsToolkit: string;
  /** Sign-in, the gateway hop, and the custom verifier route. */
  identity: IdentityConfig;
}

/**
 * The value `apps/hooks` falls back to when `APPROVALS_STORE_TOKEN` is unset
 * and it is not running in production — see `DEV_STORE_TOKEN` in
 * `apps/hooks/src/config.ts`.
 *
 * Duplicated rather than imported because `apps/web` does not depend on
 * `apps/hooks` in the package graph and should not start to. The cost of a
 * duplicated literal is drift, so `test/config.test.ts` reads the other file
 * and fails if the two ever disagree — which is a cheaper guarantee than a
 * dependency edge between the governed UI and the control plane.
 *
 * Without this fallback a clean checkout renders the approval page as "nothing
 * to decide": the store answers `401`, the page has no request to show, and
 * nothing on screen says the cause is an unset variable. That is the whole of
 * what it buys, and it must buy nothing in production — see the guard below.
 */
const DEV_STORE_TOKEN = "cg-approvals-store-dev-token-not-for-production";

/**
 * The identity-shaped part of the environment, read **without** the
 * `APPROVALS_STORE_TOKEN` guard.
 *
 * Its own function for one reason. `/health` and the home page both need to
 * report whether identity is configured, and neither has anything to do with
 * the approvals store — so going through `readWebConfig` would make a missing
 * approvals token take down the landing page and the health endpoint of a
 * production deployment, for a credential neither of them uses. `/health` in
 * particular must answer `200` whatever else is wrong; a health check that
 * fails on a misconfiguration removes the service instead of reporting it.
 *
 * Still one place reading the environment — this file — and `readWebConfig`
 * builds on it rather than repeating it.
 */
export type IdentitySurface = Pick<WebConfig, "identity" | "arcadeApiUrl" | "arcadeApiKey">;

export function readIdentitySurface(
  env: Record<string, string | undefined> = process.env,
): IdentitySurface {
  return {
    arcadeApiUrl: trimUrl(env.ARCADE_API_URL) || "https://api.arcade.dev",
    arcadeApiKey: env.ARCADE_API_KEY?.trim() ?? "",
    identity: {
      idpIssuer: trimUrl(env.IDP_ISSUER),
      idpClientId: env.IDP_CLIENT_ID?.trim() ?? "",
      idpClientSecret: env.IDP_CLIENT_SECRET?.trim() ?? "",
      // `openid` for an ID token, `email` because the address is the join key
      // across Arcade, the OAuth subject and the loan book (DESIGN.md rule 3).
      idpScopes: env.IDP_SCOPES?.trim() || "openid email",
      sessionSecret: env.SESSION_SECRET?.trim() ?? "",
      publicUrl: trimUrl(env.PUBLIC_URL),
      gatewayId: env.ARCADE_GATEWAY_ID?.trim() ?? "",
      cloudUrl: trimUrl(env.ARCADE_CLOUD_URL) || "https://cloud.arcade.dev",
    },
  };
}

export function readWebConfig(env: Record<string, string | undefined> = process.env): WebConfig {
  const storeToken = env.APPROVALS_STORE_TOKEN?.trim();
  // Same guard, same wording, as `apps/hooks/src/config.ts`. Round 3 of #52's
  // review caught it missing here: the control plane refused to boot without a
  // real token while the service that *presents* it fell back to a value
  // published in this file, so a production `apps/web` would have gone on
  // authenticating to the approvals store with a token anyone can read — and
  // gone on doing it quietly, because the fallback works locally.
  //
  // A convenience that only applies outside production is a convenience. One
  // that survives into production is a credential.
  if (!storeToken && env.NODE_ENV === "production") {
    throw new Error("APPROVALS_STORE_TOKEN is required in production");
  }

  return {
    // Refuses a bare service name outright — `public-host.ts` has the measured
    // story. The panel reads this in a server component and hands it to the
    // browser, so a host nothing can resolve fails in a visitor's DevTools.
    hooksHost: publicHost("HOOKS_PUBLIC_HOST", env.HOOKS_PUBLIC_HOST, "localhost:8081"),
    approvalsStoreToken: storeToken || DEV_STORE_TOKEN,
    approvalsToolkit: env.ARCADE_APPROVALS_TOOLKIT?.trim() || "Approvals",
    ...readIdentitySurface(env),
  };
}

/** A configured origin with any trailing slashes removed, so concatenation is safe. */
function trimUrl(value: string | undefined): string {
  return (value?.trim() ?? "").replace(/\/+$/, "");
}

/**
 * What `/health` reports, and what each route refuses to run without.
 *
 * Three capabilities rather than one flag, because they fail independently and
 * the person reading `/health` is trying to find out which human step is
 * outstanding. Sign-in needs client C; the gateway hop needs a gateway id on
 * top of a signed-in person; the verifier needs the Arcade project API key,
 * which nothing else here uses.
 *
 * A control that silently does nothing is worse than no control, and a
 * half-configured identity is exactly that: the browser gets a persona label
 * and every tool call is made as somebody else. So each of these is checked at
 * the edge of the route that needs it and reported as `missing` here.
 */
export interface IdentityReadiness {
  signin: "configured" | "missing";
  gateway: "configured" | "missing";
  verifier: "configured" | "missing";
}

export function identityReadiness(config: IdentitySurface): IdentityReadiness {
  const { identity } = config;
  const signin = Boolean(
    identity.idpIssuer && identity.idpClientId && identity.idpClientSecret &&
      identity.sessionSecret && identity.publicUrl,
  );
  return {
    signin: signin ? "configured" : "missing",
    // The gateway hop is driven by this service after sign-in, so it needs
    // everything sign-in needs plus the gateway to authorize against.
    gateway: signin && identity.gatewayId && config.arcadeApiUrl ? "configured" : "missing",
    // The verifier reads the session and calls `confirm_user` with the project
    // API key. It does not need client C — a browser that already has a session
    // never reaches the IdP — but with no session it starts a sign-in, so in
    // practice both matter and `/health` reports them separately.
    verifier: identity.sessionSecret && identity.publicUrl && config.arcadeApiKey && identity.cloudUrl
      ? "configured"
      : "missing",
  };
}

/**
 * Whether cookies this service writes carry `Secure`.
 *
 * Derived from `PUBLIC_URL` rather than configured: a browser silently drops a
 * `Secure` cookie that arrives over plain http, so a local run on
 * `http://localhost:4400` with `Secure` set looks like a sign-in that succeeds
 * and then forgets. Unset `PUBLIC_URL` means an unconfigured service, which
 * cannot sign anyone in anyway — treat it as the deployed case.
 */
export function cookiesAreSecure(config: IdentitySurface): boolean {
  return !config.identity.publicUrl.startsWith("http://");
}

/** HOST-form to URL: http for a local address, https everywhere else. */
export function baseUrl(host: string): string {
  const local = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  return `${local ? "http" : "https"}://${host}`;
}
