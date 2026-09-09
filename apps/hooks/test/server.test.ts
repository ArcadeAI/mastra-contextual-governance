/**
 * The HTTP layer, booted on a random port against an in-memory database:
 * auth, the fail-closed net, live policy edits reaching the cache, latency.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { AccessHookResult, PreHookResult } from "@cg/policy-schema";

import { count as auditCount, recent } from "../src/audit-log.ts";
import type { HooksConfig } from "../src/config.ts";
import { CORRELATION_TOKEN } from "../src/correlation.ts";
import { createPolicyCache } from "../src/policy-cache.ts";
import { openGovernance } from "../src/policy-store.ts";
import { createServer } from "../src/server.ts";

const DANA = "dana.okafor@bank.example";
const SAM = "sam.reyes@bank.example";
const SECRET = "test-secret";

const config: HooksConfig = {
  port: 0,
  dbPath: ":memory:",
  signingSecret: SECRET,
  loanToolkit: "Loan",
  approvalsToolkit: "Approvals",
  personaEmails: {},
  deadlineMs: 2500,
};

let db: Database;
let server: ReturnType<typeof createServer>;
let base: string;
const logs: string[] = [];

beforeAll(() => {
  db = openGovernance(":memory:", config);
  const cache = createPolicyCache(db, (line) => logs.push(line));
  cache.reload();
  server = createServer({ config, db, cache, log: (line) => logs.push(line) });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  db.close();
});

const post = (path: string, body: unknown, token: string | null = SECRET) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token !== null && { authorization: `Bearer ${token}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const V = [{ version: "1.0.0" }];
const LOAN_TOOLS = { SearchLoans: V, GetLoan: V, ApproveLoan: V, DenyLoan: V };

const preBody = (user_id: string, name: string, inputs: Record<string, unknown>, execution_id = "tc_1") => ({
  execution_id,
  tool: { name, toolkit: "Loan", version: "1.0.0" },
  inputs,
  context: { authorization: [{}], user_id },
});

describe("bearer auth", () => {
  test.each(["/access", "/pre", "/post"])("%s refuses a missing token", async (path) => {
    const res = await post(path, {}, null);
    expect(res.status).toBe(401);
  });

  test.each(["/access", "/pre", "/post"])("%s refuses a wrong token", async (path) => {
    const res = await post(path, {}, "wrong");
    expect(res.status).toBe(401);
  });

  test("an unauthenticated request is not audited — it never reached a decision", async () => {
    const before = auditCount(db);
    await post("/pre", preBody(DANA, "GetLoan", { loan_id: "LN-2291" }), "wrong");
    expect(auditCount(db)).toBe(before);
  });

  test("/health needs no token: Render and Arcade both probe it bare", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; policy: { status: string; revision: number } };
    expect(body.status).toBe("healthy");
    expect(body.policy.status).toBe("ready");
  });
});

describe("routing", () => {
  test("404 elsewhere, 405 on the wrong verb", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/pre`)).status).toBe(405);
    expect((await fetch(`${base}/health`, { method: "POST" })).status).toBe(405);
  });
});

describe("the hooks over HTTP", () => {
  test("/access hides ApproveLoan from Sam and audits every governed decision", async () => {
    const before = auditCount(db);
    const res = await post("/access", { user_id: SAM, toolkits: { Loan: { tools: LOAN_TOOLS } } });
    expect(res.status).toBe(200);
    const body = AccessHookResult.parse(await res.json());
    expect(body).toEqual({ deny: { Loan: { tools: { ApproveLoan: V } } } });
    expect(auditCount(db) - before).toBe(4);
  });

  test("/pre denies Dana's $95K with CHECK_FAILED and the remediation message", async () => {
    const res = await post("/pre", preBody(DANA, "ApproveLoan", { loan_id: "LN-2291", amount: 95_000 }, "tc_act2"));
    expect(res.status).toBe(200);
    const body = PreHookResult.parse(await res.json());
    expect(body.code).toBe("CHECK_FAILED");
    expect(body.error_message).toContain("Approvals.RequestApproval");
    expect(body.error_message).toMatch(CORRELATION_TOKEN);

    const [row] = recent(db, 1);
    expect(row).toMatchObject({ hook: "pre", execution_id: "tc_act2", decision: "deny", rule_id: "pre.approve-within-clearance" });
    expect(body.error_message).toContain(row!.id);
  });

  test("/post returns OK and records a pass-through", async () => {
    const res = await post("/post", {
      execution_id: "tc_post",
      tool: { name: "GetLoan", toolkit: "Loan", version: "1.0.0" },
      success: true,
      output: { x: 1 },
      context: { user_id: DANA },
    });
    expect(await res.json()).toEqual({ code: "OK" });
    expect(recent(db, 1)[0]).toMatchObject({ hook: "post", execution_id: "tc_post", decision: "allow" });
  });
});

describe("fails closed, and the failure is audited", () => {
  test("/pre with an unparseable body → CHECK_FAILED with a token, and a deny row", async () => {
    const before = auditCount(db);
    const res = await post("/pre", "not json");
    expect(res.status).toBe(200);
    const body = PreHookResult.parse(await res.json());
    expect(body.code).toBe("CHECK_FAILED");
    expect(body.error_message).toContain("FAIL-CLOSED");
    expect(body.error_message).toMatch(CORRELATION_TOKEN);
    expect(auditCount(db) - before).toBe(1);
    expect(recent(db, 1)[0]).toMatchObject({ hook: "pre", decision: "deny", rule_id: null });
  });

  test("/pre with a body that parses as JSON but not as a hook payload → denied, audited with what was readable", async () => {
    const res = await post("/pre", { execution_id: "tc_bad", tool: { name: "GetLoan" }, context: { user_id: DANA } });
    const body = PreHookResult.parse(await res.json());
    expect(body.code).toBe("CHECK_FAILED");
    expect(recent(db, 1)[0]).toMatchObject({ hook: "pre", execution_id: "tc_bad", user_id: DANA, tool: "?.GetLoan", decision: "deny" });
  });

  test("/access with a body that parses but is not a hook payload → 5xx, so Arcade's fail_closed denies", async () => {
    const res = await post("/access", { nonsense: true });
    expect(res.status).toBe(500);
    expect(recent(db, 1)[0]).toMatchObject({ hook: "access", decision: "deny", tool: "*" });
  });

  test("a policy edit that no longer compiles fails every hook closed until fixed, and /health says so", async () => {
    db.run("UPDATE policy_rules SET tool = 'approve_loan' WHERE id = 'pre.approve-within-clearance'");

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(503);
    const healthBody = (await health.json()) as { status: string; policy: { status: string; error: string } };
    expect(healthBody.status).toBe("unhealthy");
    expect(healthBody.policy.error).toMatch(/approve_loan/);

    const read = await post("/pre", preBody(DANA, "GetLoan", { loan_id: "LN-2291" }));
    expect(PreHookResult.parse(await read.json()).code).toBe("CHECK_FAILED");

    const access = await post("/access", { user_id: DANA, toolkits: { Loan: { tools: LOAN_TOOLS } } });
    expect(AccessHookResult.parse(await access.json())).toEqual({ deny: { Loan: { tools: LOAN_TOOLS } } });

    db.run("UPDATE policy_rules SET tool = 'ApproveLoan' WHERE id = 'pre.approve-within-clearance'");
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const again = await post("/pre", preBody(DANA, "GetLoan", { loan_id: "LN-2291" }));
    expect(await again.json()).toEqual({ code: "OK" });
  });
});

describe("live policy edits", () => {
  test("a clearance raised in the database is honoured on the very next call, and the reload is observable", async () => {
    const denied = await post("/pre", preBody(DANA, "ApproveLoan", { loan_id: "LN-2291", amount: 95_000 }));
    expect(PreHookResult.parse(await denied.json()).code).toBe("CHECK_FAILED");

    const before = ((await (await fetch(`${base}/health`)).json()) as { policy: { revision: number } }).policy.revision;
    const reloads = logs.filter((l) => l.startsWith("policy loaded")).length;

    db.run(`UPDATE subjects SET clearance = 100000 WHERE user_id = '${DANA}'`);

    const allowed = await post("/pre", preBody(DANA, "ApproveLoan", { loan_id: "LN-2291", amount: 95_000 }));
    expect(await allowed.json()).toEqual({ code: "OK" });

    const after = ((await (await fetch(`${base}/health`)).json()) as { policy: { revision: number } }).policy.revision;
    expect(after).toBeGreaterThan(before);
    expect(logs.filter((l) => l.startsWith("policy loaded")).length).toBe(reloads + 1);

    db.run(`UPDATE subjects SET clearance = 50000 WHERE user_id = '${DANA}'`);
  });

  test("disabling a rule takes effect immediately", async () => {
    db.run("UPDATE policy_rules SET enabled = 0 WHERE id = 'access.analysts-cannot-see-approve'");
    const res = await post("/access", { user_id: SAM, toolkits: { Loan: { tools: LOAN_TOOLS } } });
    expect(await res.json()).toEqual({ deny: {} });
    db.run("UPDATE policy_rules SET enabled = 1 WHERE id = 'access.analysts-cannot-see-approve'");
  });
});

describe("latency", () => {
  /** A catalogue the size spike #2 measured: ~1.6 MB of toolkits, Loan among them. */
  function bigCatalogue(): { bytes: number; toolkits: Record<string, { tools: Record<string, { version: string }[]> }> } {
    const toolkits: Record<string, { tools: Record<string, { version: string }[]> }> = { Loan: { tools: LOAN_TOOLS } };
    let bytes = 0;
    for (let t = 0; bytes < 1_600_000; t++) {
      const tools: Record<string, { version: string }[]> = {};
      for (let i = 0; i < 40; i++) {
        tools[`Tool${i}WithALongerNameLikeArcadeUses`] = [
          { version: "1.0.0", requirements: { authorization: [{ provider_id: "prov", oauth2: { scopes: ["a", "b"] } }] } } as never,
        ];
      }
      toolkits[`Toolkit${t}`] = { tools };
      bytes = JSON.stringify(toolkits).length;
    }
    return { bytes, toolkits };
  }

  test("/access with the whole project catalogue answers well inside Arcade's 5s", async () => {
    const { bytes, toolkits } = bigCatalogue();
    expect(bytes).toBeGreaterThan(1_500_000);

    const started = performance.now();
    const res = await post("/access", { user_id: SAM, toolkits });
    const ms = performance.now() - started;

    expect(res.status).toBe(200);
    const body = AccessHookResult.parse(await res.json());
    expect(body.deny?.Loan?.tools).toEqual({ ApproveLoan: V });
    expect(Object.keys(body.deny ?? {}).length).toBe(Object.keys(toolkits).length);
    // Generous: CI machines are slow. Locally this is tens of milliseconds.
    expect(ms).toBeLessThan(1000);
  });
});
