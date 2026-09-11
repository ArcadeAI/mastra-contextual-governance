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
    arcadeApiUrl: (env.ARCADE_API_URL?.trim() || "https://api.arcade.dev").replace(/\/+$/, ""),
    arcadeApiKey: env.ARCADE_API_KEY?.trim() ?? "",
    approvalsToolkit: env.ARCADE_APPROVALS_TOOLKIT?.trim() || "Approvals",
  };
}

/** HOST-form to URL: http for a local address, https everywhere else. */
export function baseUrl(host: string): string {
  const local = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  return `${local ? "http" : "https"}://${host}`;
}
