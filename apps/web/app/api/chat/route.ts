/**
 * One-line adapter onto `lib/agent/handlers.ts`, the way every `app/api/**`
 * route in this service is. The reasoning is in `lib/identity/cookies.ts`:
 * the handler is a plain function so the suite can mount it behind a real
 * server and drive it over real HTTP.
 */
import { chat } from "../../../lib/agent/handlers.ts";

/** Reads a session cookie and streams; there is nothing here to prerender. */
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return chat(request);
}
