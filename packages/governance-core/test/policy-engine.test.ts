/**
 * PolicyEngine, from the outside.
 *
 * Every assertion here is about a `Decision` — its `effect`, its `rule_id`,
 * and what its `reason` tells a model to do next — or about what
 * `compilePolicy` refuses. Nothing asserts evaluation order, helper names or
 * internal structure: renaming a private function must not break a test.
 *
 * Fixtures come from `@cg/policy-schema` and describe an invented `Widgets`
 * toolkit, so nothing here names the demo's business domain.
 */
import { describe, expect, it } from "bun:test";

import {
  aGrant,
  aPolicyRule,
  aSubject,
  PolicyRule as PolicyRuleSchema,
  SAMPLE_READ_TOOL,
  SAMPLE_SUBJECT_IDS,
  SAMPLE_TOOLKIT,
  SAMPLE_WRITE_TOOL,
  type PolicyRule,
  type PolicyRuleInput,
  type Subject,
} from "@cg/policy-schema";

import {
  compilePolicy,
  evaluatePermission,
  hiddenTools,
  PolicyCompileError,
  resolveVisibility,
  type Policy,
  type ToolRef,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// A small world
// ---------------------------------------------------------------------------

const READ: ToolRef = { toolkit: SAMPLE_TOOLKIT, name: SAMPLE_READ_TOOL };
const WRITE: ToolRef = { toolkit: SAMPLE_TOOLKIT, name: SAMPLE_WRITE_TOOL };
const ESCALATE: ToolRef = { toolkit: "Approvals", name: "request_approval" };
const TOOLKITS = [SAMPLE_TOOLKIT, "Approvals"];

const operator: Subject = aSubject({
  user_id: SAMPLE_SUBJECT_IDS.operator,
  display_name: "Operator",
  role: "operator",
  clearance: 0,
});
const supervisor: Subject = aSubject(); // role "supervisor", clearance 50
const director: Subject = aSubject({
  user_id: SAMPLE_SUBJECT_IDS.director,
  display_name: "Director",
  role: "director",
  clearance: 500,
});

const REMEDIATION =
  "DENIED: {{inputs.quantity}} exceeds your {{subject.clearance}} clearance for " +
  "{{tool.toolkit}}.{{tool.name}}. To proceed, call Approvals.request_approval with " +
  "resource_id={{inputs.widget_id}}, quantity={{inputs.quantity}} and a justification, " +
  "then retry this call unchanged once it is approved.";

/** The rule every act-2 test is about: deny when quantity exceeds clearance. */
const clearanceRule = aPolicyRule({ reason: REMEDIATION });

/** Act 1: operators do not see the write tool at all. */
const hideWriteFromOperators = aPolicyRule({
  id: "rule.hide-write",
  description: "Operators never see the write tool.",
  hook: "access",
  match: { toolkit: SAMPLE_TOOLKIT, tool: SAMPLE_WRITE_TOOL },
  subjects: { roles: ["operator"] },
  conditions: [],
  effect: "deny",
  reason: "Your role cannot use this tool.",
  priority: 10,
});

function policy(rules: PolicyRule[], overrides: Partial<Policy> = {}) {
  return compilePolicy({ toolkits: TOOLKITS, rules, ...overrides });
}

/** A rule written from scratch — no fixture defaults merged in. */
const rule = (input: PolicyRuleInput): PolicyRule => PolicyRuleSchema.parse(input);

// ---------------------------------------------------------------------------
// Visibility — the /access question
// ---------------------------------------------------------------------------

describe("resolveVisibility", () => {
  const compiled = policy([hideWriteFromOperators, clearanceRule]);
  const tools = [READ, WRITE];

  const cases: ReadonlyArray<
    readonly [label: string, subject: Subject, hidden: readonly ToolRef[]]
  > = [
    ["hides the write tool from an operator", operator, [WRITE]],
    ["shows everything to a supervisor", supervisor, []],
    ["shows everything to a director", director, []],
  ];

  for (const [label, subject, hidden] of cases) {
    it(label, () => {
      const result = hiddenTools(subject, tools, compiled).map(({ tool }) => tool);
      expect(result).toEqual([...hidden]);
    });
  }

  it("returns one decision per tool, in the order asked, each carrying its rule_id", () => {
    const result = resolveVisibility(operator, tools, compiled);
    expect(result.map(({ tool }) => tool)).toEqual(tools);
    expect(result.map(({ decision }) => decision)).toEqual([
      { effect: "allow", reason: "No rule matched.", rule_id: null },
      { effect: "deny", reason: "Your role cannot use this tool.", rule_id: "rule.hide-write" },
    ]);
  });

  it("does not let a pre rule hide a tool — that is a different question", () => {
    // clearanceRule is a pre rule on WRITE. Visibility must ignore it.
    const [write] = hiddenTools(supervisor, [WRITE], policy([clearanceRule]));
    expect(write).toBeUndefined();
  });

  it("hides every tool from an unknown user, and says no retry can fix it", () => {
    const result = resolveVisibility(null, tools, compiled);
    expect(result.every(({ decision }) => decision.effect === "deny")).toBe(true);
    expect(result.every(({ decision }) => decision.rule_id === null)).toBe(true);
    expect(result[0]?.decision.reason).toMatch(/no registered subject/i);
    expect(result[0]?.decision.reason).toMatch(/administrator/i);
  });

  it("hides a tool from a toolkit the configuration does not know", () => {
    const stranger: ToolRef = { toolkit: "Elsewhere", name: "do_thing" };
    const [decision] = resolveVisibility(director, [stranger], compiled).map((v) => v.decision);
    expect(decision?.effect).toBe("deny");
    expect(decision?.rule_id).toBeNull();
    expect(decision?.reason).toContain('"Elsewhere"');
    expect(decision?.reason).toMatch(/configuration/i);
  });

  it("lets a higher-priority allow rule carve an exception out of a blanket deny", () => {
    const compiledWithException = policy([
      rule({
        id: "rule.hide-all",
        description: "",
        hook: "access",
        match: { toolkit: "*", tool: "*" },
        effect: "deny",
        reason: "Hidden.",
        priority: 100,
      }),
      rule({
        id: "rule.show-read",
        description: "",
        hook: "access",
        match: { toolkit: SAMPLE_TOOLKIT, tool: SAMPLE_READ_TOOL },
        effect: "allow",
        reason: "Everyone may read.",
        priority: 1,
      }),
    ]);
    const decisions = resolveVisibility(operator, tools, compiledWithException).map(
      ({ decision }) => [decision.effect, decision.rule_id],
    );
    expect(decisions).toEqual([
      ["allow", "rule.show-read"],
      ["deny", "rule.hide-all"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Permission — the /pre question
// ---------------------------------------------------------------------------

describe("evaluatePermission: amounts against clearance", () => {
  const compiled = policy([clearanceRule]);
  const call = (subject: Subject, quantity: unknown) =>
    evaluatePermission({
      subject,
      tool: WRITE,
      inputs: { widget_id: "WID-1", quantity },
      policy: compiled,
    });

  const cases: ReadonlyArray<
    readonly [label: string, subject: Subject, quantity: number, effect: "allow" | "deny"]
  > = [
    ["under the limit is allowed", supervisor, 49, "allow"],
    ["exactly at the limit is allowed — the limit is inclusive", supervisor, 50, "allow"],
    ["one over the limit is denied", supervisor, 51, "deny"],
    ["far over the limit is denied", supervisor, 95, "deny"],
    ["zero clearance denies any positive quantity", operator, 1, "deny"],
    ["zero clearance still allows exactly zero", operator, 0, "allow"],
    ["a higher clearance allows what a lower one could not", director, 95, "allow"],
  ];

  for (const [label, subject, quantity, effect] of cases) {
    it(label, () => {
      expect(call(subject, quantity).effect).toBe(effect);
    });
  }

  it("an allowed call that no rule denied carries no rule_id", () => {
    expect(call(supervisor, 10)).toEqual({
      effect: "allow",
      reason: "No rule matched.",
      rule_id: null,
    });
  });

  it("a denial carries the rule that produced it", () => {
    expect(call(supervisor, 95).rule_id).toBe("rule.clearance");
  });

  it("a denial reason is the remediation instruction, with the call's values filled in", () => {
    const { reason } = call(supervisor, 95);
    expect(reason).toBe(
      "DENIED: 95 exceeds your 50 clearance for Widgets.update_widget. To proceed, call " +
        "Approvals.request_approval with resource_id=WID-1, quantity=95 and a justification, " +
        "then retry this call unchanged once it is approved.",
    );
  });
});

describe("evaluatePermission: missing and malformed parameters fail closed", () => {
  const compiled = policy([clearanceRule]);
  const call = (inputs: Record<string, unknown>) =>
    evaluatePermission({ subject: supervisor, tool: WRITE, inputs, policy: compiled });

  const cases: ReadonlyArray<readonly [label: string, inputs: Record<string, unknown>, tells: RegExp]> =
    [
      ["missing entirely", { widget_id: "WID-1" }, /"quantity".*not provided/],
      ["present but null", { widget_id: "WID-1", quantity: null }, /"quantity".*not provided/],
      ["a numeric string", { widget_id: "WID-1", quantity: "95" }, /must be a number.*string "95"/],
      ["a boolean", { widget_id: "WID-1", quantity: true }, /must be a number.*boolean true/],
      ["an object", { widget_id: "WID-1", quantity: { value: 95 } }, /must be a number.*an object/],
      ["an array", { widget_id: "WID-1", quantity: [95] }, /must be a number.*an array/],
      ["NaN", { widget_id: "WID-1", quantity: Number.NaN }, /must be a number/],
      ["Infinity", { widget_id: "WID-1", quantity: Number.POSITIVE_INFINITY }, /must be a number/],
    ];

  for (const [label, inputs, tells] of cases) {
    it(`denies when the governed input is ${label}`, () => {
      const decision = call(inputs);
      expect(decision.effect).toBe("deny");
      expect(decision.rule_id).toBe("rule.clearance");
      expect(decision.reason).toMatch(tells);
    });
  }

  it("names the tool to retry and the input to fix", () => {
    const { reason } = call({ widget_id: "WID-1" });
    expect(reason).toContain("Widgets.update_widget");
    expect(reason).toMatch(/retry/i);
    expect(reason).toContain('"quantity"');
  });

  it("does not care about inputs no rule mentions", () => {
    expect(call({ widget_id: "WID-1", quantity: 10, note: undefined, extra: [1, 2] }).effect).toBe(
      "allow",
    );
  });
});

describe("evaluatePermission: who is calling", () => {
  const compiled = policy([clearanceRule]);

  it("denies an unknown user with no rule_id and an instruction that a retry will not help", () => {
    const decision = evaluatePermission({
      subject: null,
      tool: WRITE,
      inputs: { widget_id: "WID-1", quantity: 1 },
      policy: compiled,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.rule_id).toBeNull();
    expect(decision.reason).toMatch(/no registered subject/i);
    expect(decision.reason).toMatch(/no tool call can fix this/i);
  });

  it("applies a rule scoped by role only to that role", () => {
    const compiledScoped = policy([
      aPolicyRule({ subjects: { roles: ["supervisor"] }, reason: "Supervisors need approval." }),
    ]);
    const call = (subject: Subject) =>
      evaluatePermission({
        subject,
        tool: WRITE,
        inputs: { widget_id: "WID-1", quantity: 1_000 },
        policy: compiledScoped,
      }).effect;
    expect(call(supervisor)).toBe("deny");
    expect(call(director)).toBe("allow");
  });

  it("applies a rule scoped by user_id only to that user", () => {
    const compiledScoped = policy([
      aPolicyRule({ subjects: { user_ids: [SAMPLE_SUBJECT_IDS.director] } }),
    ]);
    const call = (subject: Subject) =>
      evaluatePermission({
        subject,
        tool: WRITE,
        inputs: { widget_id: "WID-1", quantity: 1_000 },
        policy: compiledScoped,
      }).effect;
    expect(call(director)).toBe("deny");
    expect(call(supervisor)).toBe("allow");
  });

  it("applies a clearance band: at_least is inclusive, below is exclusive", () => {
    const compiledBand = policy([
      aPolicyRule({
        subjects: { clearance_at_least: 50, clearance_below: 500 },
        conditions: [],
        reason: "Mid-tier subjects are blocked.",
      }),
    ]);
    const call = (subject: Subject) =>
      evaluatePermission({ subject, tool: WRITE, inputs: {}, policy: compiledBand }).effect;
    expect(call(operator)).toBe("allow"); // 0 < 50
    expect(call(supervisor)).toBe("deny"); // 50 >= 50 and < 500
    expect(call(director)).toBe("allow"); // 500 is not below 500
  });
});

describe("evaluatePermission: which tool is being called", () => {
  const compiled = policy([clearanceRule]);

  it("allows a known tool that no rule speaks about, with no rule_id", () => {
    const decision = evaluatePermission({
      subject: operator,
      tool: READ,
      inputs: { widget_id: "WID-1" },
      policy: compiled,
    });
    expect(decision).toEqual({ effect: "allow", reason: "No rule matched.", rule_id: null });
  });

  it("denies a tool from a toolkit the configuration does not know, naming the toolkit", () => {
    const decision = evaluatePermission({
      subject: director,
      tool: { toolkit: "Elsewhere", name: SAMPLE_WRITE_TOOL },
      inputs: { quantity: 1 },
      policy: compiled,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.rule_id).toBeNull();
    expect(decision.reason).toContain('"Elsewhere"');
    expect(decision.reason).toContain(`"${SAMPLE_TOOLKIT}"`);
    expect(decision.reason).toMatch(/do not retry/i);
  });

  it("matches toolkit and tool names exactly, not by case or prefix", () => {
    const call = (tool: ToolRef) =>
      evaluatePermission({
        subject: supervisor,
        tool,
        inputs: { widget_id: "WID-1", quantity: 95 },
        policy: compiled,
      });
    expect(call({ toolkit: SAMPLE_TOOLKIT, name: SAMPLE_WRITE_TOOL }).effect).toBe("deny");
    expect(call({ toolkit: SAMPLE_TOOLKIT, name: SAMPLE_WRITE_TOOL.toUpperCase() }).effect).toBe(
      "allow",
    );
    expect(call({ toolkit: SAMPLE_TOOLKIT, name: `${SAMPLE_WRITE_TOOL}_v2` }).effect).toBe(
      "allow",
    );
  });

  it("honours a wildcard on either segment", () => {
    const compiledWild = policy([
      rule({
        id: "rule.freeze",
        description: "",
        hook: "pre",
        match: { toolkit: "*", tool: "*" },
        subjects: { roles: ["operator"] },
        effect: "deny",
        reason: "Operators may not call anything right now.",
        priority: 1,
      }),
    ]);
    for (const tool of [READ, WRITE, ESCALATE]) {
      expect(
        evaluatePermission({ subject: operator, tool, inputs: {}, policy: compiledWild }).effect,
      ).toBe("deny");
      expect(
        evaluatePermission({ subject: supervisor, tool, inputs: {}, policy: compiledWild })
          .effect,
      ).toBe("allow");
    }
  });
});

describe("evaluatePermission: grants", () => {
  const compiled = policy([clearanceRule]);
  const blocked = { subject: supervisor, tool: WRITE, inputs: { widget_id: "WID-1", quantity: 95 } };

  it("denies without a grant", () => {
    expect(evaluatePermission({ ...blocked, policy: compiled }).effect).toBe("deny");
    expect(evaluatePermission({ ...blocked, policy: compiled, grants: [] }).effect).toBe("deny");
  });

  it("allows with an applicable grant, keeping the rule the grant lifted", () => {
    const decision = evaluatePermission({ ...blocked, policy: compiled, grants: [aGrant()] });
    expect(decision.effect).toBe("allow");
    expect(decision.rule_id).toBe("rule.clearance");
    expect(decision.reason).toMatch(/grant/i);
    expect(decision.reason).toContain("grant_0001");
  });

  it("ignores a grant issued to somebody else", () => {
    const grant = aGrant({ subject_id: SAMPLE_SUBJECT_IDS.director });
    expect(evaluatePermission({ ...blocked, policy: compiled, grants: [grant] }).effect).toBe(
      "deny",
    );
  });

  it("ignores a grant for a different tool", () => {
    const grant = aGrant({ match: { toolkit: SAMPLE_TOOLKIT, tool: SAMPLE_READ_TOOL } });
    expect(evaluatePermission({ ...blocked, policy: compiled, grants: [grant] }).effect).toBe(
      "deny",
    );
  });

  it("a grant does not turn a missing parameter into an allowed call", () => {
    // A grant lifts a policy denial; it cannot make an unevaluable call evaluable.
    const decision = evaluatePermission({
      subject: supervisor,
      tool: WRITE,
      inputs: { widget_id: "WID-1" },
      policy: compiled,
      grants: [aGrant()],
    });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toMatch(/not provided/);
  });

  it("a grant is irrelevant to visibility", () => {
    // Grants are a /pre concept. An operator with a grant still cannot see the tool.
    const compiledAccess = policy([hideWriteFromOperators]);
    expect(hiddenTools(operator, [WRITE], compiledAccess)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Conditions beyond the clearance check
// ---------------------------------------------------------------------------

describe("evaluatePermission: condition operators", () => {
  const deny = (conditions: PolicyRuleInput["conditions"]) =>
    policy([
      rule({
        id: "rule.cond",
        description: "",
        hook: "pre",
        match: { toolkit: SAMPLE_TOOLKIT, tool: SAMPLE_WRITE_TOOL },
        conditions,
        effect: "deny",
        reason: "Blocked by condition.",
        priority: 1,
      }),
    ]);
  const call = (conditions: PolicyRuleInput["conditions"], inputs: Record<string, unknown>) =>
    evaluatePermission({ subject: director, tool: WRITE, inputs, policy: deny(conditions) });

  const cases: ReadonlyArray<
    readonly [
      label: string,
      conditions: PolicyRuleInput["conditions"],
      inputs: Record<string, unknown>,
      effect: "allow" | "deny",
    ]
  > = [
    ["eq fires on an equal string", [{ input: "status", operator: "eq", value: "closed" }], { status: "closed" }, "deny"],
    ["eq does not fire on a different string", [{ input: "status", operator: "eq", value: "closed" }], { status: "open" }, "allow"],
    ["eq compares structurally", [{ input: "target", operator: "eq", value: { id: 1 } }], { target: { id: 1 } }, "deny"],
    ["neq fires on a different value", [{ input: "status", operator: "neq", value: "open" }], { status: "closed" }, "deny"],
    ["neq does not fire on the same value", [{ input: "status", operator: "neq", value: "open" }], { status: "open" }, "allow"],
    ["gt is exclusive", [{ input: "quantity", operator: "gt", value: 10 }], { quantity: 10 }, "allow"],
    ["gt fires above", [{ input: "quantity", operator: "gt", value: 10 }], { quantity: 11 }, "deny"],
    ["gte is inclusive", [{ input: "quantity", operator: "gte", value: 10 }], { quantity: 10 }, "deny"],
    ["lt is exclusive", [{ input: "quantity", operator: "lt", value: 10 }], { quantity: 10 }, "allow"],
    ["lt fires below", [{ input: "quantity", operator: "lt", value: 10 }], { quantity: 9 }, "deny"],
    ["lte is inclusive", [{ input: "quantity", operator: "lte", value: 10 }], { quantity: 10 }, "deny"],
    ["in fires on membership", [{ input: "region", operator: "in", value: ["eu", "uk"] }], { region: "uk" }, "deny"],
    ["in does not fire outside the set", [{ input: "region", operator: "in", value: ["eu", "uk"] }], { region: "us" }, "allow"],
    ["nin fires outside the set", [{ input: "region", operator: "nin", value: ["eu", "uk"] }], { region: "us" }, "deny"],
    ["nin does not fire on membership", [{ input: "region", operator: "nin", value: ["eu", "uk"] }], { region: "eu" }, "allow"],
    ["matches fires on a regex hit", [{ input: "note", operator: "matches", value: "^urgent" }], { note: "urgent: now" }, "deny"],
    ["matches does not fire on a miss", [{ input: "note", operator: "matches", value: "^urgent" }], { note: "routine" }, "allow"],
    ["exists fires when present", [{ input: "override_code", operator: "exists" }], { override_code: "x" }, "deny"],
    ["exists does not fire when absent", [{ input: "override_code", operator: "exists" }], {}, "allow"],
    ["exists does not fire on null", [{ input: "override_code", operator: "exists" }], { override_code: null }, "allow"],
    ["exists=false fires when absent", [{ input: "justification", operator: "exists", value: false }], {}, "deny"],
    ["exists=false does not fire when present", [{ input: "justification", operator: "exists", value: false }], { justification: "because" }, "allow"],
    ["a dot path reaches a nested input", [{ input: "target.region", operator: "eq", value: "eu" }], { target: { region: "eu" } }, "deny"],
    ["all conditions must hold", [{ input: "region", operator: "eq", value: "eu" }, { input: "quantity", operator: "gt", value: 10 }], { region: "eu", quantity: 5 }, "allow"],
    ["all conditions holding fires", [{ input: "region", operator: "eq", value: "eu" }, { input: "quantity", operator: "gt", value: 10 }], { region: "eu", quantity: 50 }, "deny"],
  ];

  for (const [label, conditions, inputs, effect] of cases) {
    it(label, () => {
      expect(call(conditions, inputs).effect).toBe(effect);
    });
  }

  it("matches against a non-string fails closed as malformed", () => {
    const decision = call([{ input: "note", operator: "matches", value: "^urgent" }], { note: 7 });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toMatch(/must be a string/);
  });

  it("a missing input under eq fails closed rather than silently not matching", () => {
    const decision = call([{ input: "status", operator: "eq", value: "closed" }], {});
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toMatch(/"status".*not provided/);
  });

  it("a dot path through a missing parent is a missing input", () => {
    const decision = call([{ input: "target.region", operator: "eq", value: "eu" }], {});
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toMatch(/"target.region".*not provided/);
  });

  it("a regex is stateless across calls", () => {
    const conditions: PolicyRuleInput["conditions"] = [
      { input: "note", operator: "matches", value: "urgent" },
    ];
    const first = call(conditions, { note: "urgent" }).effect;
    const second = call(conditions, { note: "urgent" }).effect;
    expect([first, second]).toEqual(["deny", "deny"]);
  });
});

// ---------------------------------------------------------------------------
// Priority and enablement, observed from the outside
// ---------------------------------------------------------------------------

describe("evaluatePermission: several rules", () => {
  it("the lowest priority number wins, whatever order the rules arrive in", () => {
    const allowSmall = rule({
      id: "rule.allow-small",
      description: "",
      hook: "pre",
      match: { toolkit: SAMPLE_TOOLKIT, tool: SAMPLE_WRITE_TOOL },
      conditions: [{ input: "quantity", operator: "lte", value: 5 }],
      effect: "allow",
      reason: "Small quantities are always fine.",
      priority: 1,
    });
    const denyAll = rule({
      id: "rule.deny-all",
      description: "",
      hook: "pre",
      match: { toolkit: SAMPLE_TOOLKIT, tool: SAMPLE_WRITE_TOOL },
      effect: "deny",
      reason: "Writes are frozen.",
      priority: 50,
    });
    for (const rules of [
      [allowSmall, denyAll],
      [denyAll, allowSmall],
    ]) {
      const compiled = policy(rules);
      const call = (quantity: number) =>
        evaluatePermission({ subject: director, tool: WRITE, inputs: { quantity }, policy: compiled });
      expect(call(3)).toMatchObject({ effect: "allow", rule_id: "rule.allow-small" });
      expect(call(30)).toMatchObject({ effect: "deny", rule_id: "rule.deny-all" });
    }
  });

  it("equal priorities resolve the same way regardless of input order", () => {
    const a = aPolicyRule({ id: "rule.a", priority: 10, reason: "A" });
    const b = aPolicyRule({ id: "rule.b", priority: 10, reason: "B" });
    const inputs = { widget_id: "WID-1", quantity: 95 };
    const one = evaluatePermission({ subject: supervisor, tool: WRITE, inputs, policy: policy([a, b]) });
    const two = evaluatePermission({ subject: supervisor, tool: WRITE, inputs, policy: policy([b, a]) });
    expect(one).toEqual(two);
  });

  it("a disabled rule has no effect", () => {
    const compiled = policy([aPolicyRule({ enabled: false })]);
    const decision = evaluatePermission({
      subject: supervisor,
      tool: WRITE,
      inputs: { widget_id: "WID-1", quantity: 95 },
      policy: compiled,
    });
    expect(decision).toEqual({ effect: "allow", reason: "No rule matched.", rule_id: null });
  });

  it("does not mutate its inputs", () => {
    const compiled = policy([clearanceRule]);
    const inputs = { widget_id: "WID-1", nested: { quantity: 1 }, quantity: 95 };
    const snapshot = structuredClone(inputs);
    const subject = aSubject();
    const subjectSnapshot = structuredClone(subject);
    evaluatePermission({ subject, tool: WRITE, inputs, policy: compiled, grants: [aGrant()] });
    expect(inputs).toEqual(snapshot);
    expect(subject).toEqual(subjectSnapshot);
  });

  it("is deterministic: the same call gives the same decision every time", () => {
    const compiled = policy([clearanceRule, hideWriteFromOperators]);
    const input = {
      subject: supervisor,
      tool: WRITE,
      inputs: { widget_id: "WID-1", quantity: 95 },
      policy: compiled,
    };
    const decisions = new Set(
      Array.from({ length: 20 }, () => JSON.stringify(evaluatePermission(input))),
    );
    expect(decisions.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Compilation — a rule that would match nothing is refused up front
// ---------------------------------------------------------------------------

describe("compilePolicy refuses a policy that cannot mean what it says", () => {
  const base = (): PolicyRuleInput => ({
    id: "rule.x",
    description: "",
    hook: "pre",
    match: { toolkit: SAMPLE_TOOLKIT, tool: SAMPLE_WRITE_TOOL },
    effect: "deny",
    reason: "Denied.",
    priority: 1,
  });

  const cases: ReadonlyArray<readonly [label: string, policy: Policy, tells: RegExp]> = [
    [
      "a rule naming a toolkit that is not configured",
      { toolkits: TOOLKITS, rules: [rule({ ...base(), match: { toolkit: "Widgetz", tool: "*" } })] },
      /"Widgetz".*not configured.*"Widgets".*matching nothing/s,
    ],
    [
      "a rule naming a tool the catalogue says the toolkit does not serve",
      {
        toolkits: TOOLKITS,
        catalogue: { [SAMPLE_TOOLKIT]: [SAMPLE_READ_TOOL, SAMPLE_WRITE_TOOL] },
        rules: [rule({ ...base(), match: { toolkit: SAMPLE_TOOLKIT, tool: "approve_widget" } })],
      },
      /"approve_widget".*does not serve/,
    ],
    [
      "no governed toolkits at all",
      { toolkits: [], rules: [] },
      /toolkits is empty/,
    ],
    [
      "an access rule with conditions, which /access could never evaluate",
      {
        toolkits: TOOLKITS,
        rules: [rule({ ...base(), hook: "access", conditions: [{ input: "quantity", operator: "exists" }] })],
      },
      /access rule cannot have conditions/,
    ],
    [
      "a modify effect, which a PolicyRule has no override to carry",
      { toolkits: TOOLKITS, rules: [rule({ ...base(), effect: "modify" })] },
      /"modify"/,
    ],
    [
      "two rules with the same id",
      { toolkits: TOOLKITS, rules: [rule(base()), rule({ ...base(), priority: 2 })] },
      /duplicate id/,
    ],
    [
      "gt with a non-numeric value",
      { toolkits: TOOLKITS, rules: [rule({ ...base(), conditions: [{ input: "q", operator: "gt", value: "10" }] })] },
      /"gt" with a non-numeric value/,
    ],
    [
      "in with a value that is not an array",
      { toolkits: TOOLKITS, rules: [rule({ ...base(), conditions: [{ input: "q", operator: "in", value: "eu" }] })] },
      /"in" with a value that is not an array/,
    ],
    [
      "matches with an invalid regular expression",
      { toolkits: TOOLKITS, rules: [rule({ ...base(), conditions: [{ input: "q", operator: "matches", value: "(" }] })] },
      /invalid regular expression/,
    ],
    [
      "matches with a non-string value",
      { toolkits: TOOLKITS, rules: [rule({ ...base(), conditions: [{ input: "q", operator: "matches", value: 1 }] })] },
      /"matches" with a value that is not a string/,
    ],
    [
      "eq with nothing to compare against",
      { toolkits: TOOLKITS, rules: [rule({ ...base(), conditions: [{ input: "q", operator: "eq" }] })] },
      /"eq" with no value/,
    ],
    [
      "exceeds_clearance given a value it would ignore",
      { toolkits: TOOLKITS, rules: [rule({ ...base(), conditions: [{ input: "q", operator: "exceeds_clearance", value: 5 }] })] },
      /takes no value/,
    ],
    [
      "a reason placeholder rooted somewhere the engine cannot read",
      { toolkits: TOOLKITS, rules: [rule({ ...base(), reason: "Ask {{approver.name}}." })] },
      /placeholder "\{\{approver\.name\}\}"/,
    ],
  ];

  for (const [label, input, tells] of cases) {
    it(`refuses ${label}`, () => {
      expect(() => compilePolicy(input)).toThrow(PolicyCompileError);
      expect(() => compilePolicy(input)).toThrow(tells);
    });
  }

  it("reports every problem at once, naming the rule each belongs to", () => {
    let caught: unknown;
    try {
      compilePolicy({
        toolkits: TOOLKITS,
        rules: [
          rule({ ...base(), id: "rule.one", match: { toolkit: "Nope", tool: "*" } }),
          rule({ ...base(), id: "rule.two", effect: "modify" }),
        ],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PolicyCompileError);
    const { problems } = caught as PolicyCompileError;
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('rule "rule.one"');
    expect(problems[1]).toContain('rule "rule.two"');
  });

  it("accepts a wildcard toolkit without a catalogue entry for it", () => {
    expect(() =>
      compilePolicy({
        toolkits: TOOLKITS,
        catalogue: { [SAMPLE_TOOLKIT]: [SAMPLE_WRITE_TOOL] },
        rules: [rule({ ...base(), match: { toolkit: "*", tool: "*" } })],
      }),
    ).not.toThrow();
  });

  it("accepts the sample policy", () => {
    expect(() => policy([clearanceRule, hideWriteFromOperators])).not.toThrow();
  });
});
