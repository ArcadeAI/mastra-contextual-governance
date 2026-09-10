/**
 * What the web service reads from its environment, in one place.
 *
 * Every address here is HOST-form (`host` or `host:port`), never a URL: Render
 * derives cross-service addresses with `fromService`, which can only emit a
 * bare host, and blueprints have no string interpolation to prepend a scheme.
 * The consumer adds it, and `baseUrl` is the one place that decides which.
 *
 * Nothing here is `NEXT_PUBLIC_`, deliberately. `next build` inlines those into
 * the client bundle while Render supplies service env vars at runtime, so a
 * `NEXT_PUBLIC_` twin would be empty in production and fine under `next dev` —
 * the worst possible failure mode. Server components read this and pass what
 * the browser needs down as props.
 */
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

export function readWebConfig(env: Record<string, string | undefined> = process.env): WebConfig {
  return {
    hooksHost: env.HOOKS_PUBLIC_HOST?.trim() || "localhost:8081",
    approvalsStoreToken: env.APPROVALS_STORE_TOKEN?.trim() ?? "",
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
