/**
 * The per-browser session: who is signed in, and the gateway token held on
 * their behalf.
 *
 * `DESIGN.md` → **Gateway token storage**. One sealed, HTTP-only cookie,
 * chunked when it exceeds what a browser will hold, and **one persona per
 * browser**. On stage each persona runs in its own Chrome profile, which is
 * what makes one-per-browser a design rather than a limitation — and spike #75
 * named the trap it avoids: a verifier that reads a session keyed per *browser*
 * while four personas share one collapses every tool call onto whoever signed
 * in last. Four profiles, four sessions, no shared store, no fourth database.
 *
 * The short-lived legs — an in-flight sign-in, an in-flight gateway
 * authorization, a parked Arcade flow — are sealed with the same key and
 * carried the same way. They are separate cookies rather than fields on the
 * session because two of them exist *before* there is a session at all, and
 * because each has its own lifetime measured in minutes.
 */
import { cookiesAreSecure, readIdentitySurface, type IdentitySurface } from "../config.ts";
import { appendCookie, expireCookie, readCookies } from "./cookies.ts";
import { chunk, chunkName, clearedChunks, joinChunks, openSealed, seal } from "./seal.ts";

/** The gateway access token this browser's persona holds for `cg-demo-us`. */
export interface GatewayToken {
  access_token: string;
  refresh_token?: string;
  /** Epoch milliseconds. Absolute rather than `expires_in`, which is only meaningful at issue. */
  expires_at: number;
  /**
   * The MCP client id the token was issued to.
   *
   * Stored because Arcade renders its gateway consent screen once per persona
   * *per MCP client id*, so a token and the registration it came from have to
   * travel together — a refresh against a different client id is a refusal, not
   * a new token.
   */
  client_id: string;
}

export interface Session {
  /** The persona's email, lowercase. The join key: Arcade `user_id`, OAuth subject, loan-book actor. */
  email: string;
  /** Absent between sign-in and hop 1 completing. */
  gateway?: GatewayToken;
  /** When this session was established, epoch ms. Informational; the cookie's own Max-Age expires it. */
  signed_in_at: number;
}

export const SESSION_COOKIE = "cg_session";
/** One in-flight sign-in: PKCE verifier, CSRF state, and where to go afterwards. */
export const SIGNIN_COOKIE = "cg_signin";
/** One in-flight gateway authorization: PKCE verifier, state, and the client id it registered. */
export const GATEWAY_COOKIE = "cg_gateway";
/** An Arcade verification flow parked while the browser goes and signs in. */
export const PENDING_FLOW_COOKIE = "cg_arcade_flow";

/** A week. Long enough for a rehearsal and a demo day; short enough that a stale laptop forgets. */
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

/**
 * Ten minutes, for every leg cookie.
 *
 * The issue fixes the parked-flow ceiling at ten minutes and the other two legs
 * take the same number: an authorization that has been in flight longer than
 * that is a browser somebody left open, and resuming it would complete a
 * sign-in whose beginning nobody remembers.
 */
export const LEG_MAX_AGE = 10 * 60;

export interface SigninLeg {
  state: string;
  verifier: string;
  /** Where to send the browser once the session exists. Same-origin path only — see `handlers.ts`. */
  next: string;
  /** Which persona button was pressed. A label for the page, never an identity. */
  persona?: string;
}

export interface GatewayLeg {
  state: string;
  verifier: string;
  client_id: string;
  next: string;
}

export interface PendingFlow {
  flow_id: string;
  /** Epoch ms. The cookie expires on its own; this is what the "expired" page reports. */
  parked_at: number;
}

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

/**
 * This browser's session, or `null`.
 *
 * `null` covers every failure: no cookie, a missing chunk, a value sealed under
 * a different `SESSION_SECRET`, a tampered byte. All of them mean the same
 * thing to every caller — nobody is signed in — and that state is always safe.
 */
export async function readSession(request: Request, config: IdentitySurface = readIdentitySurface()): Promise<Session | null> {
  return readSessionFromCookies(readCookies(request), config);
}

/**
 * The same read, from a jar rather than a `Request`.
 *
 * Server components get their cookies from `next/headers`, not from a `Request`
 * they can see. This is the seam that lets the page and the route handlers
 * share one implementation instead of the page growing a second, subtly
 * different unsealer.
 */
export async function readSessionFromCookies(
  cookies: ReadonlyMap<string, string>,
  config: IdentitySurface = readIdentitySurface(),
): Promise<Session | null> {
  const joined = joinChunks(SESSION_COOKIE, cookies);
  const session = await openSealed<Session>(joined, config.identity.sessionSecret);
  return session?.email ? session : null;
}

/**
 * Seal the session across as many cookies as it takes, and expire the chunks a
 * shorter value leaves behind.
 *
 * The stale-chunk sweep is the part that is easy to omit and expensive to
 * debug: a session that shrinks from three chunks to two leaves `.2` holding a
 * fragment of the previous one, the next read joins new to stale, and the seal
 * refuses it — on every request from then on, which reads as "signing in does
 * not work" rather than as a bug with a cause.
 */
export async function writeSession(
  headers: Headers,
  request: Request,
  session: Session,
  config: IdentitySurface = readIdentitySurface(),
) {
  const sealed = await seal(session, config.identity.sessionSecret);
  const pieces = chunk(sealed);
  const secure = cookiesAreSecure(config);
  pieces.forEach((piece, index) => {
    appendCookie(headers, chunkName(SESSION_COOKIE, index), piece, { maxAge: SESSION_MAX_AGE, secure });
  });
  for (const stale of clearedChunks(SESSION_COOKIE, readCookies(request), pieces.length)) {
    expireCookie(headers, stale, secure);
  }
}

/** Expire every chunk this browser is carrying. Signing out, and switching persona. */
export function clearSession(headers: Headers, request: Request, config: IdentitySurface = readIdentitySurface()) {
  const secure = cookiesAreSecure(config);
  const cookies = readCookies(request);
  for (const stale of clearedChunks(SESSION_COOKIE, cookies, 0)) expireCookie(headers, stale, secure);
  // A browser that somehow holds the unsuffixed name — nothing here writes one,
  // but a previous format or a hand-set cookie might — loses it too.
  if (cookies.has(SESSION_COOKIE)) expireCookie(headers, SESSION_COOKIE, secure);
}

/** One sealed leg cookie. Small by construction, so never chunked. */
export async function readLeg<T>(
  request: Request,
  name: string,
  config: IdentitySurface = readIdentitySurface(),
): Promise<T | null> {
  return openSealed<T>(readCookies(request).get(name), config.identity.sessionSecret);
}

export async function writeLeg(headers: Headers, name: string, value: unknown, config: IdentitySurface = readIdentitySurface()) {
  appendCookie(headers, name, await seal(value, config.identity.sessionSecret), {
    maxAge: LEG_MAX_AGE,
    secure: cookiesAreSecure(config),
  });
}

export function clearLeg(headers: Headers, name: string, config: IdentitySurface = readIdentitySurface()) {
  expireCookie(headers, name, cookiesAreSecure(config));
}
