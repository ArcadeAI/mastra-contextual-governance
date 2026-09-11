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
import { assertPublicHost } from "../public-host.ts";


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
  // Checked whichever mode wins. A bare service name is wrong the moment it is
  // set, and this is the address the *browser* is handed — so the alternative
  // to refusing here is a failed EventSource in a visitor's console. See
  // `../public-host.ts`.
  assertPublicHost("HOOKS_PUBLIC_HOST", env["HOOKS_PUBLIC_HOST"]);

  const host = env["HOOKS_PUBLIC_HOST"]?.trim();

  if (env["GOVERNANCE_STREAM"]?.trim() === "hooks" && host !== undefined && host !== "") {
    return { url: `${baseUrl(host)}${HOOKS_STREAM_PATH}`, mode: "hooks" };
  }

  return { url: FIXTURE_STREAM_PATH, mode: "fixture" };
}

/** The knobs the fixture stream understands. See its route for what they do. */
const FIXTURE_PARAMS = ["delayMs", "repeat", "fanout"] as const;

/**
 * `source` with the fixture stream's own parameters carried over from the
 * page's query string, so `/panel?repeat=2000&delayMs=0` is a burst a
 * presenter can rehearse against and a reviewer can watch, and
 * `/panel?fanout=1` is the measured `/access` fan-out landing in one row.
 *
 * Only in fixture mode. The hook server's stream is not ours to add query
 * parameters to, and a stray `repeat` on it would be meaningless at best.
 */
export function withFixtureParams(
  source: StreamSource,
  params: Readonly<Record<string, string | string[] | undefined>>,
): StreamSource {
  if (source.mode !== "fixture") return source;

  const query = new URLSearchParams();
  for (const name of FIXTURE_PARAMS) {
    const value = params[name];
    const single = Array.isArray(value) ? value[0] : value;
    if (single !== undefined && single !== "") query.set(name, single);
  }

  const suffix = query.toString();
  return suffix === "" ? source : { ...source, url: `${source.url}?${suffix}` };
}
