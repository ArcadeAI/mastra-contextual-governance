/**
 * Which stream the panel watches, and how its address is worked out.
 *
 * Read in a **server component**, never in the browser. `.env.example` says why
 * at length: `next build` inlines `NEXT_PUBLIC_*` into the client bundle, while
 * Render supplies service environment variables at runtime, so a
 * `NEXT_PUBLIC_HOOKS_HOST` would be `undefined` in the deployed browser and
 * perfectly fine under `next dev` — a difference that shows up first on stage.
 * The panel takes its stream address as a prop instead.
 */

/** The no-backend stream, served by this app from #5's fixture sequence. */
export const FIXTURE_STREAM_PATH = "/api/governance/fixture-stream";

/** The hook server's stream. Owned by #20; see `subscribe.ts` for the frames. */
export const HOOKS_STREAM_PATH = "/events";

export type StreamMode = "fixture" | "hooks";

export interface StreamSource {
  readonly url: string;
  readonly mode: StreamMode;
}

/** Hosts are HOST-form (see `.env.example`); the consumer adds the scheme. */
function baseUrl(host: string): string {
  const local = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  return `${local ? "http" : "https"}://${host}`;
}

/**
 * Where to point the panel, given the process environment.
 *
 * **Fixture is the default, deliberately.** `apps/hooks` does not serve
 * `/events` yet — that is #20, still open — so defaulting to the hook server
 * would make a fresh clone open on a panel retrying a connection that cannot
 * succeed, which reads as a broken app rather than an unfinished one. Set
 * `GOVERNANCE_STREAM=hooks` to watch the real thing; when #20 lands, that
 * becomes the default and this comment goes with it.
 */
export function governanceStreamSource(
  env: Readonly<Record<string, string | undefined>>,
): StreamSource {
  const host = env["HOOKS_PUBLIC_HOST"]?.trim();

  if (env["GOVERNANCE_STREAM"]?.trim() === "hooks" && host !== undefined && host !== "") {
    return { url: `${baseUrl(host)}${HOOKS_STREAM_PATH}`, mode: "hooks" };
  }

  return { url: FIXTURE_STREAM_PATH, mode: "fixture" };
}
