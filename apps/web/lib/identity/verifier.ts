/**
 * Hop 2: the two server-side calls that bind a tool authorization to the
 * persona this browser is signed in as.
 *
 * `DESIGN.md` → **Two hops, two mechanisms**, and open risk 4. Arcade's default
 * verifier demands an Arcade account that is a project member; our personas are
 * deliberately not members, and with the default route a browser signed into
 * `account.arcade.dev` as somebody else binds the grant to *that* person and
 * the tool re-challenges forever (observed 2026-09-11 15:40Z). A custom
 * verifier replaces that: Arcade sends the browser to a route we own, we decide
 * who the person is from our own session, and we post that identity back
 * server-side.
 *
 * Two measured facts shape everything here (spike #75):
 *
 * 1. **`confirm_user` must be called with the project API key, in-flow.** Run
 *    by hand it is unreliable — Arcade accepts it only while the flow is still
 *    awaiting verification, and that window is shorter than a human's
 *    turnaround. Measured: the same call succeeded once at ~8 minutes and
 *    returned a bare `{"code":400,"msg":"Bad request"}` the next time, for a
 *    flow Arcade still recognised.
 * 2. **Arcade does not finalise the grant until something fetches `next_uri`.**
 *    A `confirm_user` that returned 200 with `{auth_id, next_uri}` left the tool
 *    unauthorized because the browser had given up and nothing landed there. So
 *    this module fetches it **server-side** and then sends the browser on; a
 *    verifier that returns the redirect and trusts the browser to follow it is
 *    correct for a browser and wrong for everything else.
 */

/** What `confirm_user` answers with on success. */
export interface ConfirmResponse {
  auth_id?: string;
  next_uri?: string;
  [key: string]: unknown;
}

export type ConfirmResult =
  | { ok: true; response: ConfirmResponse }
  | { ok: false; status: number; body: string };

/** `https://cloud.arcade.dev/api/v1/oauth/confirm_user`, measured on #75. */
export function confirmUserUrl(cloudUrl: string): string {
  return `${cloudUrl}/api/v1/oauth/confirm_user`;
}

/**
 * Tell Arcade who this flow belongs to.
 *
 * `user_id` is the session's email, lowercase, and it comes from the sealed
 * cookie — never from the request. Arcade sends a verifier **exactly one**
 * parameter, `flow_id` (measured: no user hint, no provider, no return URL), so
 * there is nothing on the query string that could be identity even if this
 * route were willing to read it.
 */
export async function confirmUser(options: {
  cloudUrl: string;
  apiKey: string;
  flowId: string;
  email: string;
}): Promise<ConfirmResult> {
  const response = await fetch(confirmUserUrl(options.cloudUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ flow_id: options.flowId, user_id: options.email.toLowerCase() }),
  });
  const body = await response.text();
  if (!response.ok) return { ok: false, status: response.status, body };

  let parsed: ConfirmResponse;
  try {
    parsed = JSON.parse(body) as ConfirmResponse;
  } catch {
    return { ok: false, status: response.status, body };
  }
  // A 200 carrying `user_mismatch` is a refusal wearing a success status: the
  // grant is bound to somebody else and every later call re-challenges. Treat
  // it as the failure it is, and show its own words.
  if (typeof parsed.user_mismatch === "boolean" ? parsed.user_mismatch : parsed.error === "user_mismatch") {
    return { ok: false, status: response.status, body };
  }
  return { ok: true, response: parsed };
}

/**
 * Fetch `next_uri` so Arcade finalises the grant, and report where it points
 * the browser next.
 *
 * `redirect: "manual"` because following it here would run the browser's half
 * of the flow on the server. The only thing this call has to accomplish is that
 * *something* landed on the URL; the browser is then sent to the same place.
 */
export async function followNextUri(nextUri: string): Promise<{ status: number; location: string | null }> {
  const response = await fetch(nextUri, { redirect: "manual" });
  // The body is drained rather than left dangling, so the connection is not
  // held open by a response nobody read.
  await response.arrayBuffer().catch(() => undefined);
  return { status: response.status, location: response.headers.get("location") };
}
