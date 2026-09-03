/**
 * The authorization-code flow Arcade will drive, exercised over real HTTP
 * against the service booted the way Render boots it: `bun src/index.ts`, env
 * only. Authorize → login page → consent page → code → token → userinfo. No
 * handler is called in-process; the thing that has to work is the wire.
 *
 * Also the two operational scripts, run as subprocesses against the same
 * database: `oauth-client` must be idempotent, and `reset` must leave the
 * credentials Arcade holds working.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadPeople } from "../src/db.ts";

const ROOT = join(import.meta.dir, "..");
const dbPath = join(tmpdir(), `cg-idp-${crypto.randomUUID()}`, "idp.db");
const REDIRECT_URI = "http://127.0.0.1:9/callback";
const SECRET = "test-secret-".padEnd(48, "x");

// The fixture's own addresses: any PERSONA_*_EMAIL in the developer's shell is
// deliberately not passed to the child, so the test is about the fixture.
const people = loadPeople({});
const dana = people.find((p) => p.persona === "dana")!;
const riley = people.find((p) => p.persona === "riley")!;

let child: Subprocess;
let baseUrl: string;
let env: Record<string, string>;

interface Credentials {
  client_id: string;
  client_secret: string;
  created: boolean;
  pkce: string;
  userinfo_email_jsonpath: string;
}

async function runScript(name: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", join(ROOT, "scripts", name), ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

async function credentials(): Promise<Credentials> {
  const { code, out, err } = await runScript("oauth-client.ts", "--json");
  expect(err).toBe("");
  expect(code).toBe(0);
  return JSON.parse(out) as Credentials;
}

beforeAll(async () => {
  const port = 8000 + Math.floor(Math.random() * 1000);
  baseUrl = `http://127.0.0.1:${port}`;

  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && !key.startsWith("PERSONA_") && !key.startsWith("IDP_"),
    ),
  ) as Record<string, string>;

  env = {
    ...inherited,
    PORT: String(port),
    IDP_DB_PATH: dbPath,
    IDP_PUBLIC_URL: baseUrl,
    IDP_OAUTH_REDIRECT_URIS: REDIRECT_URI,
    BETTER_AUTH_SECRET: SECRET,
  };

  child = Bun.spawn(["bun", join(ROOT, "src", "index.ts")], { env, stdout: "pipe", stderr: "pipe" });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`idp did not come up:\n${await new Response(child.stderr as ReadableStream).text()}`);
    }
    await Bun.sleep(50);
  }
});

afterAll(() => {
  child?.kill();
  rmSync(dirname(dbPath), { recursive: true, force: true });
});

/** A browser, minus the browser: a cookie jar and manual redirects. */
class Browser {
  private cookies = new Map<string, string>();

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set(
        "cookie",
        [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      if (value === "" || /max-age=0/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  async submit(url: string, fields: Record<string, string>): Promise<Response> {
    return this.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams(fields).toString(),
    });
  }
}

function pkce() {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const hash = new Bun.CryptoHasher("sha256").update(verifier).digest();
  const challenge = Buffer.from(hash).toString("base64url");
  return { verifier, challenge };
}

function authorizeUrl(clientId: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access",
    state: "state-" + crypto.randomUUID(),
    ...extra,
  });
  return `${baseUrl}/oauth2/authorize?${params}`;
}

/** Extracts the raw query string of the page the plugin redirected to. */
function queryOf(location: string): string {
  return new URL(location, baseUrl).search.slice(1);
}

/**
 * Walks one persona through the entire flow and returns the access token,
 * asserting every hop on the way. Used by several tests, so the assertions
 * that make it up are here rather than duplicated.
 */
async function authorizeAs(
  browser: Browser,
  creds: Credentials,
  persona: { email: string; password: string; name: string },
  { expectConsent }: { expectConsent: boolean },
): Promise<{ accessToken: string; refreshToken: string | undefined }> {
  const { verifier, challenge } = pkce();
  const state = "state-" + crypto.randomUUID();

  // 1. Authorize. No session: the plugin sends the browser to the login page
  //    with the whole request signed into the query.
  const authorize = await browser.fetch(
    authorizeUrl(creds.client_id, { code_challenge: challenge, code_challenge_method: "S256", state }),
  );
  let location = authorize.headers.get("location") ?? "";

  if (location.startsWith("/login") || location.startsWith(`${baseUrl}/login`)) {
    // 2. The login page renders and names the client.
    const loginPage = await browser.fetch(new URL(location, baseUrl).toString());
    expect(loginPage.status).toBe(200);
    const loginHtml = await loginPage.text();
    expect(loginHtml).toContain("Sign in");
    expect(loginHtml).toContain("Arcade");
    expect(loginHtml).toContain('name="oauth_query"');

    // 3. Submit the form. The session cookie is set and the plugin resumes
    //    the authorize flow — on to consent, or back to the client.
    const login = await browser.submit(`${baseUrl}/login`, {
      email: persona.email,
      password: persona.password,
      oauth_query: queryOf(location),
    });
    expect(login.status).toBe(303);
    location = login.headers.get("location") ?? "";
  }

  if (expectConsent) {
    expect(location).toMatch(/^(\S*\/)?consent\?/);

    // 4. The consent page shows who is signing in and what is asked for.
    const consentPage = await browser.fetch(new URL(location, baseUrl).toString());
    expect(consentPage.status).toBe(200);
    const consentHtml = await consentPage.text();
    expect(consentHtml).toContain(persona.name);
    expect(consentHtml).toContain(persona.email);
    expect(consentHtml).toContain("Arcade");
    for (const scope of ["openid", "profile", "email", "offline_access"]) {
      expect(consentHtml).toContain(`<code>${scope}</code>`);
    }

    // 5. Allow.
    const consent = await browser.submit(`${baseUrl}/consent`, {
      decision: "allow",
      oauth_query: queryOf(location),
    });
    expect(consent.status).toBe(303);
    location = consent.headers.get("location") ?? "";
  }

  // 6. Back at the client with a code.
  const callback = new URL(location);
  expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
  expect(callback.searchParams.get("state")).toBe(state);
  expect(callback.searchParams.get("iss")).toBe(baseUrl);
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();

  // 7. Exchange it, the way Arcade does: client_secret_post, form-encoded.
  const token = await fetch(`${baseUrl}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: REDIRECT_URI,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      code_verifier: verifier,
    }),
  });
  expect(token.status).toBe(200);
  const tokens = (await token.json()) as {
    access_token: string;
    token_type: string;
    refresh_token?: string;
    scope?: string;
  };
  expect(tokens.token_type.toLowerCase()).toBe("bearer");
  expect(tokens.access_token).toBeTruthy();

  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
}

async function userinfo(accessToken: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/oauth2/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe("health", () => {
  test("answers for Render's health check and names the endpoints", async () => {
    const body = (await (await fetch(`${baseUrl}/health`)).json()) as Record<string, any>;

    expect(body).toMatchObject({ status: "ok", service: "idp", people: 4, issuer: baseUrl });
    expect(body.oauth.authorize).toBe(`${baseUrl}/oauth2/authorize`);
    expect(body.oauth.token).toBe(`${baseUrl}/oauth2/token`);
    expect(body.oauth.userinfo).toBe(`${baseUrl}/oauth2/userinfo`);
  });

  test("serves discovery at the root, even though Arcade will not read it", async () => {
    const body = (await (await fetch(`${baseUrl}/.well-known/openid-configuration`)).json()) as Record<string, any>;

    expect(body).toMatchObject({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth2/authorize`,
      token_endpoint: `${baseUrl}/oauth2/token`,
      userinfo_endpoint: `${baseUrl}/oauth2/userinfo`,
    });
    expect(body.code_challenge_methods_supported).toContain("S256");
    expect(body.token_endpoint_auth_methods_supported).toContain("client_secret_post");
  });
});

describe("the OAuth client", () => {
  test("the script prints the same credentials every time", async () => {
    const first = await credentials();
    const second = await credentials();

    expect(first.client_id).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(first.client_secret).toMatch(/^[A-Za-z0-9]{48}$/);
    expect(second).toEqual({ ...first, created: false });
  });

  test("states the posture #13 has to match", async () => {
    const creds = await credentials();

    expect(creds.pkce).toBe("S256");
    expect(creds.userinfo_email_jsonpath).toBe("$.email");
  });

  test("the service never logs the secret", async () => {
    // The child's stdout is piped; nothing has read it, so it holds every line
    // logged since boot. A boot that printed the secret would be one `render
    // logs` away from anyone with dashboard access.
    const creds = await credentials();
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    const logged = new TextDecoder().decode(value);

    expect(logged).toContain(creds.client_id);
    expect(logged).not.toContain(creds.client_secret);
  });
});

describe("authorization-code flow", () => {
  test("authorize → login → consent → code → token → userinfo, as Dana", async () => {
    const creds = await credentials();
    const browser = new Browser();

    const { accessToken, refreshToken } = await authorizeAs(browser, creds, dana, { expectConsent: true });
    expect(refreshToken).toBeTruthy();

    // The claim Arcade is configured to extract with `$.email`.
    const claims = await userinfo(accessToken);
    expect(claims.email).toBe(dana.email);
    expect(claims.email_verified).toBe(true);
    expect(claims.name).toBe(dana.name);
    expect(typeof claims.sub).toBe("string");
  });

  test("a second authorize in the same session skips login and consent", async () => {
    const creds = await credentials();
    const browser = new Browser();

    await authorizeAs(browser, creds, riley, { expectConsent: true });
    const { accessToken } = await authorizeAs(browser, creds, riley, { expectConsent: false });

    expect((await userinfo(accessToken)).email).toBe(riley.email);
  });

  test("each persona is their own subject", async () => {
    const creds = await credentials();

    const danaToken = await authorizeAs(new Browser(), creds, dana, { expectConsent: false });
    const rileyToken = await authorizeAs(new Browser(), creds, riley, { expectConsent: false });

    const [a, b] = await Promise.all([userinfo(danaToken.accessToken), userinfo(rileyToken.accessToken)]);
    expect(a.email).toBe(dana.email);
    expect(b.email).toBe(riley.email);
    expect(a.sub).not.toBe(b.sub);
  });

  test("a wrong password stays on the login page with an error", async () => {
    const creds = await credentials();
    const browser = new Browser();
    const { challenge } = pkce();

    const authorize = await browser.fetch(
      authorizeUrl(creds.client_id, { code_challenge: challenge, code_challenge_method: "S256" }),
    );
    const login = await browser.submit(`${baseUrl}/login`, {
      email: dana.email,
      password: "not-it",
      oauth_query: queryOf(authorize.headers.get("location")!),
    });

    expect(login.status).toBe(401);
    const html = await login.text();
    expect(html).toContain("did not match");
    expect(html).toContain(dana.email);
  });

  test("denying consent sends the client an access_denied error, not a code", async () => {
    const creds = await credentials();
    const browser = new Browser();
    const { challenge } = pkce();

    const authorize = await browser.fetch(
      authorizeUrl(creds.client_id, {
        code_challenge: challenge,
        code_challenge_method: "S256",
        // Force the consent screen even though the session may have consented.
        prompt: "consent",
      }),
    );
    let location = authorize.headers.get("location")!;
    const login = await browser.submit(`${baseUrl}/login`, {
      email: dana.email,
      password: dana.password,
      oauth_query: queryOf(location),
    });
    location = login.headers.get("location")!;
    expect(location).toMatch(/consent\?/);

    const consent = await browser.submit(`${baseUrl}/consent`, {
      decision: "deny",
      oauth_query: queryOf(location),
    });
    const callback = new URL(consent.headers.get("location")!);

    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("code")).toBeNull();
  });

  test("the consent page without a session goes to login", async () => {
    const response = await new Browser().fetch(`${baseUrl}/consent?client_id=x&scope=openid`);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/login?client_id=x");
  });
});

describe("PKCE is required", () => {
  test("authorize without a code_challenge does not issue a code", async () => {
    const creds = await credentials();
    const response = await new Browser().fetch(authorizeUrl(creds.client_id));

    // Either an error redirect back to the client or a 4xx; never a login page
    // that would end in a code.
    const location = response.headers.get("location") ?? "";
    expect(location).not.toMatch(/\/login/);
    if (location) {
      const url = new URL(location, baseUrl);
      expect(url.searchParams.get("code")).toBeNull();
      expect(url.searchParams.get("error")).toBeTruthy();
    } else {
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
  });

  test("the token endpoint refuses a code without its verifier", async () => {
    const creds = await credentials();
    const browser = new Browser();
    const { challenge } = pkce();

    const authorize = await browser.fetch(
      authorizeUrl(creds.client_id, { code_challenge: challenge, code_challenge_method: "S256" }),
    );
    let location = authorize.headers.get("location")!;
    const login = await browser.submit(`${baseUrl}/login`, {
      email: dana.email,
      password: dana.password,
      oauth_query: queryOf(location),
    });
    location = login.headers.get("location")!;
    if (/consent\?/.test(location)) {
      location = (
        await browser.submit(`${baseUrl}/consent`, { decision: "allow", oauth_query: queryOf(location) })
      ).headers.get("location")!;
    }
    const code = new URL(location).searchParams.get("code")!;

    const token = await fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: creds.client_id,
        client_secret: creds.client_secret,
      }),
    });

    expect(token.status).toBe(400);
  });

  test("a wrong client secret is refused", async () => {
    const creds = await credentials();
    const token = await fetch(`${baseUrl}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "whatever",
        redirect_uri: REDIRECT_URI,
        client_id: creds.client_id,
        client_secret: "wrong",
        code_verifier: "x".repeat(43),
      }),
    });

    expect(token.status).toBeGreaterThanOrEqual(400);
    const body = (await token.json()) as { error: string; access_token?: string };
    expect(["invalid_client", "invalid_grant"]).toContain(body.error);
    expect(body.access_token).toBeUndefined();
  });
});

describe("reset does not rotate the OAuth client", () => {
  test("the credentials Arcade holds still complete a flow after scripts/reset", async () => {
    const before = await credentials();

    // A session and a consent exist from the tests above. Reset wipes them.
    const reset = await runScript("reset.ts");
    expect(reset.err).toBe("");
    expect(reset.code).toBe(0);
    expect(reset.out).toContain(`OAuth client ${before.client_id} unchanged`);

    const after = await credentials();
    expect(after.client_id).toBe(before.client_id);
    expect(after.client_secret).toBe(before.client_secret);
    expect(after.created).toBe(false);

    // The people are back to the fixture, and every earlier session is gone:
    // Dana has to log in and consent again, with the very same client.
    const health = (await (await fetch(`${baseUrl}/health`)).json()) as { people: number };
    expect(health.people).toBe(4);

    const { accessToken } = await authorizeAs(new Browser(), before, dana, { expectConsent: true });
    expect((await userinfo(accessToken)).email).toBe(dana.email);
  });
});
