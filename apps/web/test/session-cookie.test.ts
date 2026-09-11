/**
 * The sealed session cookie: what it protects, and what happens when it grows
 * past what a browser will hold.
 *
 * Two properties the demo rests on. The cookie holds a gateway bearer token, so
 * **it must be unreadable without `SESSION_SECRET`** — not merely signed, not
 * merely opaque-looking. And two JWTs plus an email exceed the 4KB a browser
 * gives one cookie, so **chunking is the normal case, not an edge**; a browser
 * that is handed an oversized `Set-Cookie` drops it silently, and the symptom
 * is a sign-in that appears to work and then forgets.
 */
import { describe, expect, test } from "bun:test";

import { readWebConfig } from "../lib/config.ts";
import { readCookies } from "../lib/identity/cookies.ts";
import { CHUNK_LIMIT, chunk, chunkName, clearedChunks, joinChunks, openSealed, seal } from "../lib/identity/seal.ts";
import { SESSION_COOKIE, clearSession, readSession, writeSession, type Session } from "../lib/identity/session.ts";

const SECRET = "a-session-secret-for-the-suite-0123456789";

const config = (overrides: Record<string, string> = {}) =>
  readWebConfig({ SESSION_SECRET: SECRET, PUBLIC_URL: "https://cg-web-sa31.onrender.com", ...overrides });

/** A request carrying whatever `Set-Cookie` headers a previous response wrote. */
function requestCarrying(headers: Headers, url = "https://cg-web-sa31.onrender.com/"): Request {
  const jar = new Map<string, string>();
  for (const raw of headers.getSetCookie()) {
    const pair = raw.split(";")[0]!;
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (value === "" || /max-age=0/i.test(raw)) jar.delete(name);
    else jar.set(name, value);
  }
  return new Request(url, {
    headers: { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") },
  });
}

describe("the seal", () => {
  test("a sealed value opens back to what went in", async () => {
    const sealed = await seal({ email: "dana.okafor@bank.example", n: 1 }, SECRET);
    expect(await openSealed<{ email: string; n: number }>(sealed, SECRET)).toEqual({
      email: "dana.okafor@bank.example",
      n: 1,
    });
  });

  test("the contents are not readable without the key", async () => {
    const sealed = await seal({ email: "dana.okafor@bank.example" }, SECRET);
    // Not "hard to read" — absent. The address does not appear in the cookie in
    // any encoding a `grep` or a `base64 -d` would find.
    expect(sealed).not.toContain("dana");
    expect(Buffer.from(sealed.split(".")[2]!, "base64url").toString("utf8")).not.toContain("dana");
    expect(await openSealed(sealed, "a-different-secret-entirely-9876543210")).toBeNull();
  });

  test("a tampered byte does not open", async () => {
    const sealed = await seal({ email: "dana.okafor@bank.example" }, SECRET);
    const body = sealed.split(".")[2]!;
    const flipped = `${sealed.split(".").slice(0, 2).join(".")}.${body.slice(0, -2)}${body.at(-1)}${body.at(-2)}`;
    expect(await openSealed(flipped, SECRET)).toBeNull();
  });

  test("a value from another format version does not open", async () => {
    const sealed = await seal({ email: "dana.okafor@bank.example" }, SECRET);
    expect(await openSealed(sealed.replace(/^v1\./, "v2."), SECRET)).toBeNull();
  });

  test("junk, empty and truncated values are all just nothing", async () => {
    for (const value of ["", "not-a-cookie", "v1.short", "v1..", (await seal({}, SECRET)).slice(0, 20)]) {
      expect(await openSealed(value, SECRET)).toBeNull();
    }
  });

  test("sealing without a secret is refused rather than done weakly", async () => {
    expect(seal({ email: "dana" }, "")).rejects.toThrow(/SESSION_SECRET/);
  });
});

describe("chunking past 4KB", () => {
  test("a value longer than the limit becomes several cookies and joins back", async () => {
    // Two JWT-shaped tokens: what a real gateway response puts in this cookie.
    const session: Session = {
      email: "dana.okafor@bank.example",
      signed_in_at: 1_760_000_000_000,
      gateway: {
        access_token: `header.${"a".repeat(2600)}.signature`,
        refresh_token: `header.${"r".repeat(2600)}.signature`,
        expires_at: 1_760_000_600_000,
        client_id: "mcp-client-1",
      },
    };

    const headers = new Headers();
    const request = new Request("https://cg-web-sa31.onrender.com/");
    await writeSession(headers, request, session, config());

    const written = headers.getSetCookie();
    // The point of the test: this did not fit in one.
    expect(written.length).toBeGreaterThan(1);
    for (const raw of written) {
      // RFC 6265's floor, which Chrome and Firefox both enforce over the whole
      // `name=value; attrs` string. A cookie over it is dropped in silence.
      expect(raw.length).toBeLessThanOrEqual(4096);
    }

    const back = await readSession(requestCarrying(headers), config());
    expect(back).toEqual(session);
  });

  test("the chunks are named in order from zero and read back in that order", () => {
    const sealed = "x".repeat(CHUNK_LIMIT * 2 + 7);
    const pieces = chunk(sealed);
    expect(pieces).toHaveLength(3);
    const jar = new Map(pieces.map((piece, index) => [chunkName(SESSION_COOKIE, index), piece]));
    expect(joinChunks(SESSION_COOKIE, jar)).toBe(sealed);
  });

  test("a missing middle chunk reads as a prefix, and a prefix does not open", async () => {
    const headers = new Headers();
    await writeSession(
      headers,
      new Request("https://cg-web-sa31.onrender.com/"),
      {
        email: "dana.okafor@bank.example",
        signed_in_at: 1,
        gateway: {
          access_token: "t".repeat(4000),
          expires_at: 2,
          client_id: "mcp-client-1",
        },
      },
      config(),
    );
    const request = requestCarrying(headers);
    const jar = readCookies(request);
    expect(jar.size).toBeGreaterThan(1);
    jar.delete(chunkName(SESSION_COOKIE, 1));
    // Stops at the gap rather than joining across it, so what comes back is a
    // prefix — and a prefix fails the cipher's own authentication.
    expect(await openSealed(joinChunks(SESSION_COOKIE, jar), SECRET)).toBeNull();
  });

  test("a session that shrinks expires the chunks it no longer uses", async () => {
    const long = new Headers();
    await writeSession(
      long,
      new Request("https://cg-web-sa31.onrender.com/"),
      {
        email: "dana.okafor@bank.example",
        signed_in_at: 1,
        gateway: { access_token: "t".repeat(7000), expires_at: 2, client_id: "mcp-client-1" },
      },
      config(),
    );
    const wide = requestCarrying(long);
    expect(readCookies(wide).size).toBe(3);

    const short = new Headers();
    await writeSession(short, wide, { email: "sam.reyes@bank.example", signed_in_at: 3 }, config());

    // Every chunk beyond the one now needed is expired in the same response —
    // a leftover holding a fragment of the previous session would make every
    // later read fail, on every request, with no cause on screen.
    expect(short.getSetCookie().filter((raw) => /max-age=0/i.test(raw)).length).toBe(2);
    expect(await readSession(requestCarrying(short), config())).toEqual({
      email: "sam.reyes@bank.example",
      signed_in_at: 3,
    });
  });

  test("an orphan chunk at a discontinuous index is swept too", () => {
    const jar = new Map([
      [chunkName(SESSION_COOKIE, 0), "a"],
      [chunkName(SESSION_COOKIE, 5), "stale"],
      ["unrelated", "x"],
    ]);
    expect(clearedChunks(SESSION_COOKIE, jar, 1)).toEqual([chunkName(SESSION_COOKIE, 5)]);
  });

  test("signing out expires every chunk this browser holds", async () => {
    const headers = new Headers();
    await writeSession(
      headers,
      new Request("https://cg-web-sa31.onrender.com/"),
      {
        email: "dana.okafor@bank.example",
        signed_in_at: 1,
        gateway: { access_token: "t".repeat(7000), expires_at: 2, client_id: "mcp-client-1" },
      },
      config(),
    );
    const signedIn = requestCarrying(headers);

    const cleared = new Headers();
    clearSession(cleared, signedIn, config());
    expect(cleared.getSetCookie()).toHaveLength(3);
    expect(await readSession(requestCarrying(cleared), config())).toBeNull();
  });
});

describe("the attributes a browser is given", () => {
  test("HttpOnly and Secure at an https origin", async () => {
    const headers = new Headers();
    await writeSession(
      headers,
      new Request("https://cg-web-sa31.onrender.com/"),
      { email: "dana.okafor@bank.example", signed_in_at: 1 },
      config(),
    );
    for (const raw of headers.getSetCookie()) {
      expect(raw).toContain("HttpOnly");
      expect(raw).toContain("Secure");
      // Lax, not Strict: every one of these cookies has to survive a
      // cross-site navigation back from the IdP and from Arcade.
      expect(raw).toContain("SameSite=Lax");
      expect(raw).toContain("Path=/");
    }
  });

  test("Secure is dropped for a loopback PUBLIC_URL, because a browser would drop the cookie", async () => {
    const headers = new Headers();
    await writeSession(
      headers,
      new Request("http://localhost:4400/"),
      { email: "dana.okafor@bank.example", signed_in_at: 1 },
      config({ PUBLIC_URL: "http://localhost:4400" }),
    );
    for (const raw of headers.getSetCookie()) {
      expect(raw).toContain("HttpOnly");
      expect(raw).not.toContain("Secure");
    }
  });
});
