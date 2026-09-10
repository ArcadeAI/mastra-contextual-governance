/**
 * The three hooks against the seeded cast: the four acts as Arcade would see
 * them, plus the fail-closed paths and the response shape spike #2 measured.
 */
import { describe, expect, test } from "bun:test";

import { AccessHookResult, type GovernanceEvent, PostHookResult, PreHookResult } from "@cg/policy-schema";

import { CORRELATION_TOKEN, correlationId } from "../src/correlation.ts";
import { handleAccess, handlePost, handlePre, type HandlerContext } from "../src/handlers.ts";
import { createPolicyCache, type CacheState } from "../src/policy-cache.ts";
import { openGovernance } from "../src/policy-store.ts";

const DANA = "dana.okafor@bank.example";
const SAM = "sam.reyes@bank.example";
const RILEY = "riley.chen@bank.example";
const MORGAN = "morgan.ellis@bank.example";

const ready = (): CacheState =>
  createPolicyCache(
    openGovernance(":memory:", { loanToolkit: "Loan", approvalsToolkit: "Approvals", personaEmails: {} }),
  ).reload();

const cold: CacheState = { status: "cold" };

const failed: CacheState = {
  status: "failed",
  revision: 7,
  failed_at: "2026-01-01T00:00:00.000Z",
  error: "Policy failed to compile: rule x",
};

let n = 0;
const ctx: HandlerContext = {
  now: () => "2026-01-01T00:00:00.000Z",
  newId: () => `evt_${String(++n).padStart(10, "0")}`,
};

/**
 * The single audit row a handler wrote.
 *
 * `events[0]` is `GovernanceEvent | undefined` under `noUncheckedIndexedAccess`,
 * and the two callers below feed its `id` to `toBe`. `events[0]!.id` would
 * typecheck and turn "the handler recorded nothing" — the failure these tests
 * exist to catch — into a `toBe(undefined)` that reads as a mismatched
 * correlation token. Fail here instead, naming what actually went wrong.
 */
function onlyEvent(events: readonly GovernanceEvent[]): GovernanceEvent {
  const [event, ...rest] = events;
  if (event === undefined || rest.length > 0) {
    throw new Error(`expected exactly one audit row, got ${events.length}`);
  }
  return event;
}

const V = [{ version: "1.0.0" }];
const LOAN_TOOLS = { SearchLoans: V, GetLoan: V, ApproveLoan: V, DenyLoan: V };

const pre = (user_id: string, name: string, inputs: Record<string, unknown>) => ({
  execution_id: "tc_1",
  tool: { name, toolkit: "Loan", version: "1.0.0" },
  inputs,
  context: { authorization: [{}], user_id },
});

describe("/access — act 1", () => {
  test("hides ApproveLoan from Sam, in the request's own shape down to the version array", () => {
    const { response, events } = handleAccess(
      { user_id: SAM, toolkits: { Loan: { tools: LOAN_TOOLS } } },
      ready(),
      ctx,
    );
    expect(response).toEqual({ deny: { Loan: { tools: { ApproveLoan: V } } } });
    expect(AccessHookResult.parse(response)).toEqual(response);

    const hidden = events.filter((e) => e.decision === "deny");
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toMatchObject({
      hook: "access",
      user_id: SAM,
      tool: "Loan.ApproveLoan",
      rule_id: "access.analysts-cannot-see-approve",
      execution_id: "",
    });
    // One row per governed tool, allowed or not.
    expect(events.map((e) => e.tool).sort()).toEqual(
      ["Loan.ApproveLoan", "Loan.DenyLoan", "Loan.GetLoan", "Loan.SearchLoans"],
    );
  });

  test.each([DANA, RILEY, MORGAN])("shows everything to %s", (user) => {
    const { response } = handleAccess({ user_id: user, toolkits: { Loan: { tools: LOAN_TOOLS } } }, ready(), ctx);
    expect(response).toEqual({ deny: {} });
  });

  test("never returns a bare {} — an empty deny map is still a map", () => {
    const { response } = handleAccess({ user_id: DANA, toolkits: { Loan: { tools: LOAN_TOOLS } } }, ready(), ctx);
    expect(response).toHaveProperty("deny");
  });

  test("matches the user id case-insensitively — the join key is an email", () => {
    const { response } = handleAccess(
      { user_id: SAM.toUpperCase(), toolkits: { Loan: { tools: LOAN_TOOLS } } },
      ready(),
      ctx,
    );
    expect(response.deny?.Loan?.tools).toHaveProperty("ApproveLoan");
  });

  test("hides every tool from a user the roster does not know", () => {
    const { response, events } = handleAccess(
      { user_id: "stranger@bank.example", toolkits: { Loan: { tools: LOAN_TOOLS } } },
      ready(),
      ctx,
    );
    expect(Object.keys(response.deny?.Loan?.tools ?? {}).sort()).toEqual(Object.keys(LOAN_TOOLS).sort());
    expect(events.every((e) => e.decision === "deny" && e.rule_id === null)).toBe(true);
    expect(events[0]?.reason).toMatch(/no registered subject/);
  });

  test("hides an ungoverned toolkit and audits every one of its tools, so each decision is reconstructible", () => {
    const { response, events } = handleAccess(
      {
        user_id: DANA,
        toolkits: {
          Loan: { tools: LOAN_TOOLS },
          Github: { tools: { CreateIssue: [{ version: "2.0.0" }], ListRepos: [{ version: "2.0.0" }] } },
        },
      },
      ready(),
      ctx,
    );
    expect(response.deny).toEqual({
      Github: { tools: { CreateIssue: [{ version: "2.0.0" }], ListRepos: [{ version: "2.0.0" }] } },
    });
    const github = events.filter((e) => e.tool.startsWith("Github."));
    expect(github.map((e) => e.tool).sort()).toEqual(["Github.CreateIssue", "Github.ListRepos"]);
    for (const e of github) {
      expect(e).toMatchObject({ decision: "deny", rule_id: null, user_id: DANA });
      expect(e.reason).toMatch(/not governed/);
    }
    // And one row for every Loan tool too: six decisions, six rows.
    expect(events).toHaveLength(6);
  });

  test("fails closed when the policy is unavailable: denies everything named, one row per tool, says why", () => {
    const { response, events } = handleAccess(
      { user_id: DANA, toolkits: { Loan: { tools: LOAN_TOOLS } } },
      failed,
      ctx,
    );
    expect(response).toEqual({ deny: { Loan: { tools: LOAN_TOOLS } } });
    expect(events.map((e) => e.tool).sort()).toEqual(
      ["Loan.ApproveLoan", "Loan.DenyLoan", "Loan.GetLoan", "Loan.SearchLoans"],
    );
    for (const e of events) {
      expect(e).toMatchObject({ decision: "deny", rule_id: null });
      expect(e.reason).toContain("FAIL-CLOSED");
      expect(e.reason).toContain("Policy failed to compile");
    }
  });

  test("a cold cache denies everything — it never loads policy on a hook call", () => {
    const { response, events } = handleAccess(
      { user_id: DANA, toolkits: { Loan: { tools: LOAN_TOOLS } } },
      cold,
      ctx,
    );
    expect(response).toEqual({ deny: { Loan: { tools: LOAN_TOOLS } } });
    expect(events).toHaveLength(4);
    expect(events[0]?.reason).toMatch(/has not loaded its policy yet/);
  });

  test("copes with a toolkit that lists no tools", () => {
    const { response, events } = handleAccess({ user_id: DANA, toolkits: { Empty: {} } }, ready(), ctx);
    expect(response).toEqual({ deny: {} });
    expect(events).toEqual([]);
  });
});

describe("/pre — act 2", () => {
  test("blocks Dana's $95K with the remediation instruction and a correlation token", () => {
    const { response, events } = handlePre(pre(DANA, "ApproveLoan", { loan_id: "LN-2291", amount: 95_000 }), ready(), ctx);

    expect(response.code).toBe("CHECK_FAILED");
    expect(PreHookResult.parse(response)).toEqual(response);
    const message = response.error_message ?? "";
    expect(message).toContain("95000 exceeds your approval authority of 50000");
    expect(message).toContain("Approvals.RequestApproval");
    expect(message).toContain("resource_id=LN-2291");
    expect(message).toContain("Loan.ApproveLoan");
    expect(message).toMatch(CORRELATION_TOKEN);

    // The token is the audit row's id, so the panel can join exactly.
    expect(events).toHaveLength(1);
    expect(correlationId(message)).toBe(onlyEvent(events).id);
    expect(events[0]).toMatchObject({
      hook: "pre",
      execution_id: "tc_1",
      user_id: DANA,
      tool: "Loan.ApproveLoan",
      decision: "deny",
      rule_id: "pre.approve-within-clearance",
    });
    // The audit row carries the reason without the token — the token is the row.
    expect(events[0]?.reason).not.toMatch(CORRELATION_TOKEN);
  });

  test("the token reads as a reference, not an instruction", () => {
    const { response } = handlePre(pre(DANA, "ApproveLoan", { loan_id: "LN-2291", amount: 95_000 }), ready(), ctx);
    expect(response.error_message).toMatch(/ \[ref evt_[0-9a-z]{10}\]$/);
  });

  test.each([
    ["Dana at her limit", DANA, 50_000],
    ["Dana under her limit", DANA, 40_000],
    ["Riley, the minimum-sufficient approver", RILEY, 95_000],
    ["Morgan", MORGAN, 4_000_000],
  ])("allows %s", (_label, user, amount) => {
    const { response, events } = handlePre(pre(user, "ApproveLoan", { loan_id: "LN-2291", amount }), ready(), ctx);
    expect(response).toEqual({ code: "OK" });
    expect(events[0]).toMatchObject({ decision: "allow", rule_id: null, user_id: user });
  });

  test("Sam's $0 clearance denies any positive approval even if the tool were reached", () => {
    const { response } = handlePre(pre(SAM, "ApproveLoan", { loan_id: "LN-2291", amount: 1 }), ready(), ctx);
    expect(response.code).toBe("CHECK_FAILED");
  });

  test("allows reads for everyone in the cast", () => {
    for (const user of [DANA, SAM, RILEY, MORGAN]) {
      const { response } = handlePre(pre(user, "GetLoan", { loan_id: "LN-2291" }), ready(), ctx);
      expect(response).toEqual({ code: "OK" });
    }
  });

  test("denies an unknown user with a message that says no retry helps", () => {
    const { response, events } = handlePre(pre("stranger@bank.example", "GetLoan", { loan_id: "LN-2291" }), ready(), ctx);
    expect(response.code).toBe("CHECK_FAILED");
    expect(response.error_message).toMatch(/no registered subject/);
    expect(events[0]).toMatchObject({ decision: "deny", rule_id: null, user_id: "stranger@bank.example" });
  });

  test("denies a payload with no user id at all", () => {
    const request = pre(DANA, "GetLoan", { loan_id: "LN-2291" });
    const { response, events } = handlePre({ ...request, context: { authorization: [{}] } }, ready(), ctx);
    expect(response.code).toBe("CHECK_FAILED");
    expect(events[0]?.user_id).toBe("");
  });

  test("denies a call missing a catalogued argument, and says which", () => {
    const { response } = handlePre(pre(DANA, "ApproveLoan", { loan_id: "LN-2291" }), ready(), ctx);
    expect(response.code).toBe("CHECK_FAILED");
    expect(response.error_message).toContain('"amount"');
  });

  test("denies a tool name in the wrong case — the silent-permit trap, closed", () => {
    const { response } = handlePre(pre(DANA, "approve_loan", { loan_id: "LN-2291", amount: 1 }), ready(), ctx);
    expect(response.code).toBe("CHECK_FAILED");
    expect(response.error_message).toContain('"approve_loan"');
  });

  test("fails closed when the policy is unavailable: full error in the audit row, one sentence to the model", () => {
    const { response, events } = handlePre(pre(DANA, "GetLoan", { loan_id: "LN-2291" }), failed, ctx);
    expect(response.code).toBe("CHECK_FAILED");
    expect(response.error_message).toMatch(/policy is unavailable/);
    expect(response.error_message).not.toContain("Policy failed to compile");
    expect(response.error_message).toMatch(CORRELATION_TOKEN);
    expect(events[0]?.reason).toContain("FAIL-CLOSED");
    expect(events[0]?.reason).toContain("Policy failed to compile");
    expect(events[0]).toMatchObject({ decision: "deny", rule_id: null, tool: "Loan.GetLoan" });
  });
});

describe("/pre — cold cache", () => {
  test("denies with a short message and audits the reason", () => {
    const { response, events } = handlePre(pre(DANA, "GetLoan", { loan_id: "LN-2291" }), cold, ctx);
    expect(response.code).toBe("CHECK_FAILED");
    expect(response.error_message).toMatch(/policy is unavailable/);
    expect(events[0]?.reason).toMatch(/has not loaded its policy yet/);
  });
});

describe("/post", () => {
  const postBody = {
    execution_id: "tc_9",
    tool: { name: "GetLoan", toolkit: "Loan", version: "1.0.0" },
    inputs: { loan_id: "LN-2291" },
    success: true,
    output: { bank_account_number: "1234" },
    context: { user_id: DANA },
  };

  test.each([
    ["cold", cold],
    ["failed", failed],
  ])("fails closed when the cache is %s: CHECK_FAILED, output withheld, deny row", (_label, state) => {
    const { response, events } = handlePost(postBody, state, ctx);
    expect(response.code).toBe("CHECK_FAILED");
    expect(response.error_message).toMatch(/cannot release the output of Loan\.GetLoan/);
    expect(response.error_message).toMatch(CORRELATION_TOKEN);
    expect(response).not.toHaveProperty("override");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ hook: "post", execution_id: "tc_9", tool: "Loan.GetLoan", decision: "deny", rule_id: null });
    expect(events[0]?.reason).toContain("FAIL-CLOSED");
    expect(correlationId(response.error_message ?? "")).toBe(onlyEvent(events).id);
  });

  test("passes the output through unchanged and records that it did", () => {
    const { response, events } = handlePost(postBody, ready(), ctx);
    expect(response).toEqual({ code: "OK" });
    expect(PostHookResult.parse(response)).toEqual(response);
    expect(events[0]).toMatchObject({
      hook: "post",
      execution_id: "tc_9",
      user_id: DANA,
      tool: "Loan.GetLoan",
      decision: "allow",
      rule_id: null,
    });
    expect(events[0]?.before).toBeUndefined();
  });
});

describe("the correlation token", () => {
  test("round-trips and fails soft on a message without one", () => {
    expect(correlationId("DENIED: x. [ref evt_0123456789]")).toBe("evt_0123456789");
    expect(correlationId("Tool execution was denied by an extension policy: DENIED: x. [ref evt_0123456789]")).toBe(
      "evt_0123456789",
    );
    expect(correlationId("DENIED: x.")).toBeNull();
    expect(correlationId("[ref evt_0123456789] then more text")).toBeNull();
  });
});
