/**
 * The HTTP surface, exercised over the wire against the service booted the
 * way Render boots it — `bun src/index.ts`, env only — not by calling handlers
 * in-process.
 *
 * Tokens are validated against a stand-in identity provider that this file
 * runs itself: it serves `/oauth2/userinfo` and knows two tokens. The real one
 * is `apps/idp` (#36); the API only ever sees that endpoint, so a fake that
 * speaks it is a complete test double.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server, Subprocess } from "bun";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const dbPath = join(tmpdir(), `cg-loan-app-${crypto.randomUUID()}`, "loans.db");

const DANA = "dana@example.test";
const RILEY = "riley@example.test";
const TOKENS: Record<string, string> = { "tok-dana": DANA, "tok-riley": RILEY };

let idp: Server<unknown>;
let child: Subprocess;
let baseUrl: string;

beforeAll(async () => {
  idp = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      const email = token === undefined ? undefined : TOKENS[token];

      if (pathname !== "/oauth2/userinfo") return new Response("Not found", { status: 404 });
      if (email === undefined) return new Response("invalid_token", { status: 401 });

      return Response.json({ sub: email, email, email_verified: true });
    },
  });

  const port = 8000 + Math.floor(Math.random() * 1000);
  baseUrl = `http://127.0.0.1:${port}`;

  child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "index.ts")], {
    env: {
      ...process.env,
      PORT: String(port),
      LOANS_DB_PATH: dbPath,
      IDP_PUBLIC_HOST: `localhost:${idp.port}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error("loan-app did not come up");
    await Bun.sleep(50);
  }
});

afterAll(() => {
  child?.kill();
  idp?.stop(true);
  rmSync(dirname(dbPath), { recursive: true, force: true });
});

function as(token: string | null, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers };
}

function post(token: string, path: string, body: unknown): Promise<Response> {
  return fetch(
    `${baseUrl}${path}`,
    as(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("health", () => {
  test("answers for Render's health check, without a token", async () => {
    const body = await (await fetch(`${baseUrl}/health`)).json();

    expect(body).toMatchObject({ status: "ok", service: "loan-app" });
    expect(body.loans).toBeGreaterThan(1);
  });
});

describe("identity", () => {
  test("every loan route needs a bearer token", async () => {
    for (const path of ["/loans", "/loans/LN-2291"]) {
      expect((await fetch(`${baseUrl}${path}`)).status).toBe(401);
    }
    expect((await fetch(`${baseUrl}/loans/LN-2291/approve`, { method: "POST" })).status).toBe(401);
  });

  test("a wrong verb is a 405 before anyone asks for a token", async () => {
    expect((await fetch(`${baseUrl}/loans/LN-2291`, { method: "DELETE" })).status).toBe(405);
    expect((await fetch(`${baseUrl}/loans`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${baseUrl}/loans/LN-2291/approve`)).status).toBe(405);
  });

  test("a token the identity provider does not recognise is refused", async () => {
    const response = await fetch(`${baseUrl}/loans`, as("tok-forged"));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("rejected") });
  });

  test("the actor comes from the token — a body that names one is refused", async () => {
    const response = await post("tok-dana", "/loans/LN-2292/approve", {
      amount: 1_000,
      actor: RILEY,
    });

    expect(response.status).toBe(400);
    const loan = await (await fetch(`${baseUrl}/loans/LN-2292`, as("tok-dana"))).json();
    expect(loan.decisions).toHaveLength(0);
  });
});

describe("GET /loans", () => {
  test("returns plausible surrounding loans with no filter", async () => {
    const body = await (await fetch(`${baseUrl}/loans`, as("tok-dana"))).json();

    expect(body.count).toBeGreaterThan(4);
    expect(body.loans.map((loan: { loan_id: string }) => loan.loan_id)).toContain("LN-2291");
  });

  test("honours the filters", async () => {
    const body = await (
      await fetch(
        `${baseUrl}/loans?status=pending&min_amount=90000&max_amount=100000`,
        as("tok-dana"),
      )
    ).json();

    expect(body.loans).toHaveLength(1);
    expect(body.loans[0]).toMatchObject({ loan_id: "LN-2291", amount: 95_000 });
  });

  test("rejects a filter of the wrong type", async () => {
    const response = await fetch(`${baseUrl}/loans?status=in_review`, as("tok-dana"));

    expect(response.status).toBe(400);
    expect((await response.json()).issues).toBeArray();
  });
});

describe("GET /loans/:loan_id", () => {
  test("returns the full record, unredacted", async () => {
    const response = await fetch(`${baseUrl}/loans/LN-2291`, as("tok-dana"));
    const text = await response.text();
    const loan = JSON.parse(text);

    expect(loan).toMatchObject({
      loan_id: "LN-2291",
      borrower_name: "Northwind Bakery LLC",
      amount: 95_000,
    });

    // Acts 3 and 4 depend on all of this arriving intact. Whatever the post
    // hook does to it, it does downstream of here.
    expect(loan.bank_account_number).toMatch(/^\d{16}$/);
    expect(loan.tax_id).toMatch(/^\d{2}-\d{7}$/);
    expect(loan.underwriter_notes).toContain("approve_loan");
    expect(text).not.toContain("[REDACTED]");
  });

  test("404s on an unknown loan, naming it", async () => {
    const response = await fetch(`${baseUrl}/loans/LN-0000`, as("tok-dana"));

    expect(response.status).toBe(404);
    expect((await response.json()).error).toContain("LN-0000");
  });
});

describe("decisions", () => {
  test("approve records the approval under the token's owner, and a second one is visible", async () => {
    const first = await (await post("tok-dana", "/loans/LN-2292/approve", { amount: 15_500 })).json();
    expect(first.status).toBe("approved");
    expect(first.decisions).toHaveLength(1);
    expect(first.decisions[0]).toMatchObject({ amount: 15_500, decided_by: DANA });

    const second = await (await post("tok-riley", "/loans/LN-2292/approve", { amount: 9_000 })).json();
    expect(second.decisions).toHaveLength(2);
    expect(second.decisions.map((d: { amount: number }) => d.amount)).toEqual([15_500, 9_000]);
    expect(second.decisions.map((d: { decided_by: string }) => d.decided_by)).toEqual([DANA, RILEY]);
  });

  test("deny records the reason verbatim", async () => {
    const reason = "Collateral appraisal is more than twelve months old.";
    const loan = await (await post("tok-dana", "/loans/LN-2299/deny", { reason })).json();

    expect(loan.status).toBe("denied");
    expect(loan.decisions.at(-1)).toMatchObject({
      decision: "denied",
      reason,
      amount: null,
      decided_by: DANA,
    });
  });

  test("validates the body", async () => {
    expect((await post("tok-dana", "/loans/LN-2292/approve", { amount: -5 })).status).toBe(400);
    expect((await post("tok-dana", "/loans/LN-2292/approve", {})).status).toBe(400);
    expect((await post("tok-dana", "/loans/LN-2299/deny", { reason: "" })).status).toBe(400);
  });

  test("404s on an unknown loan and writes nothing", async () => {
    const response = await post("tok-dana", "/loans/LN-0000/approve", { amount: 1 });

    expect(response.status).toBe(404);
  });

  test("survives across requests — the loan book is the only state", async () => {
    const loan = await (await fetch(`${baseUrl}/loans/LN-2299`, as("tok-riley"))).json();

    expect(loan.status).toBe("denied");
  });
});

describe("surface", () => {
  test("there is no MCP endpoint here", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });

    expect(response.status).toBe(404);
  });

  test("an unknown path is a 404", async () => {
    expect((await fetch(`${baseUrl}/nothing`)).status).toBe(404);
  });
});
