/**
 * The governance vocabulary.
 *
 * These schemas are a contract between five slices that are being built in
 * parallel and cannot ask each other questions, so what is asserted here is
 * mostly the parts a consumer would otherwise have to guess: which fields
 * `parse()` fills in, which are nullable, and which are refused.
 */
import { describe, expect, it } from "bun:test";

import {
  ApprovalRequest,
  Condition,
  Decision,
  Effect,
  GovernanceEvent,
  Grant,
  HookPoint,
  OutputRule,
  PolicyRule,
  Subject,
} from "../src/domain.ts";

describe("enumerations", () => {
  it("names Arcade's three control points", () => {
    expect(HookPoint.options).toEqual(["access", "pre", "post"]);
  });

  it("names the three effects a decision can have", () => {
    expect(Effect.options).toEqual(["allow", "deny", "modify"]);
  });
});

describe("Subject", () => {
  it("defaults attributes to an empty map so rules can read it unconditionally", () => {
    const subject = Subject.parse({
      user_id: "a@example.com",
      display_name: "A",
      role: "operator",
      clearance: 0,
    });
    expect(subject.attributes).toEqual({});
  });

  it("allows a clearance of zero — no numeric authority at all", () => {
    expect(
      Subject.parse({
        user_id: "a@example.com",
        display_name: "A",
        role: "operator",
        clearance: 0,
      }).clearance,
    ).toBe(0);
  });

  it("rejects a negative clearance", () => {
    expect(() =>
      Subject.parse({
        user_id: "a@example.com",
        display_name: "A",
        role: "operator",
        clearance: -1,
      }),
    ).toThrow();
  });
});

describe("PolicyRule", () => {
  const minimal = {
    id: "rule.1",
    description: "",
    hook: "pre" as const,
    match: { toolkit: "Widgets", tool: "update_widget" },
    effect: "deny" as const,
    reason: "Denied.",
    priority: 10,
  };

  it("fills in the fields seed data should not have to spell out", () => {
    const rule = PolicyRule.parse(minimal);
    expect(rule.enabled).toBe(true);
    expect(rule.conditions).toEqual([]);
    expect(rule.subjects).toBeNull();
  });

  it("applies only at /access or /pre — /post is OutputRule's job", () => {
    expect(() => PolicyRule.parse({ ...minimal, hook: "post" })).toThrow();
  });

  it("defaults a condition's value to null, for operators that take none", () => {
    const condition = Condition.parse({
      input: "quantity",
      operator: "exceeds_clearance",
    });
    expect(condition.value).toBeNull();
  });

  it("rejects an empty tool matcher segment, which would match nothing", () => {
    // A rule that matches nothing is indistinguishable from a rule that
    // permits — the exact silent fail-open this demo exists to disprove.
    expect(() =>
      PolicyRule.parse({ ...minimal, match: { toolkit: "", tool: "update_widget" } }),
    ).toThrow();
  });
});

describe("OutputRule", () => {
  const minimal = {
    id: "rule.redact",
    description: "",
    match: { toolkit: "Widgets", tool: "get_widget" },
    reason: "Redacted.",
    priority: 10,
  };

  it("allows either mechanism alone, or both together", () => {
    expect(OutputRule.parse(minimal).fields).toEqual([]);
    expect(OutputRule.parse(minimal).patterns).toEqual([]);

    const both = OutputRule.parse({
      ...minimal,
      fields: [{ path: "identifier", strategy: "mask" }],
      patterns: [{ id: "p", regex: "secret", strategy: "remove" }],
    });
    expect(both.fields).toHaveLength(1);
    expect(both.patterns).toHaveLength(1);
  });

  it("supplies a redaction placeholder rather than leaving one undefined", () => {
    const rule = OutputRule.parse({
      ...minimal,
      fields: [{ path: "identifier", strategy: "mask" }],
    });
    expect(rule.fields[0]?.replacement).toBe("[REDACTED]");
  });

  it("defaults pattern matching to case-insensitive", () => {
    const rule = OutputRule.parse({
      ...minimal,
      patterns: [{ id: "p", regex: "ignore previous instructions", strategy: "remove" }],
    });
    expect(rule.patterns[0]?.flags).toBe("i");
  });
});

describe("Decision", () => {
  it("is the shape #1 and DESIGN.md specify", () => {
    const decision = Decision.parse({
      effect: "deny",
      reason: "Denied.",
      rule_id: "rule.1",
    });
    expect(decision).toEqual({ effect: "deny", reason: "Denied.", rule_id: "rule.1" });
  });

  it("allows a null rule_id, for a default rather than a matched rule", () => {
    expect(
      Decision.parse({ effect: "allow", reason: "No rule matched.", rule_id: null })
        .rule_id,
    ).toBeNull();
  });

  it("carries an override of any shape, for a modify", () => {
    const decision = Decision.parse({
      effect: "modify",
      reason: "Redacted.",
      rule_id: "rule.redact",
      override: { output: { identifier: "[REDACTED]" } },
    });
    expect(decision.override).toEqual({ output: { identifier: "[REDACTED]" } });
  });
});

describe("Grant", () => {
  const minimal = {
    id: "grant_1",
    subject_id: "a@example.com",
    granted_by: "b@example.com",
    request_id: "req_1",
    match: { toolkit: "Widgets", tool: "update_widget" },
    resource_id: null,
    inputs: {},
    issued_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2026-01-01T00:15:00.000Z",
  };

  it("defaults to a single use, so a grant is not a standing permission", () => {
    expect(Grant.parse(minimal).uses_remaining).toBe(1);
  });

  it("allows unlimited uses within the expiry window, spelled null", () => {
    expect(Grant.parse({ ...minimal, uses_remaining: null }).uses_remaining).toBeNull();
  });

  it("requires both parties, so #10 has something to compare for separation of duties", () => {
    expect(() => Grant.parse({ ...minimal, granted_by: "" })).toThrow();
  });

  it("insists timestamps are ISO 8601 instants", () => {
    expect(() => Grant.parse({ ...minimal, expires_at: "tomorrow" })).toThrow();
  });
});

describe("ApprovalRequest", () => {
  const minimal = {
    id: "req_1",
    requester_id: "a@example.com",
    approver_id: null,
    match: { toolkit: "Widgets", tool: "update_widget" },
    resource_id: null,
    inputs: {},
    justification: "",
    required_clearance: null,
    status: "pending" as const,
    created_at: "2026-01-01T00:00:00.000Z",
  };

  it("starts undecided, with the routing fields empty rather than absent", () => {
    const request = ApprovalRequest.parse(minimal);
    expect(request.approver_id).toBeNull();
    expect(request.candidate_approver_ids).toEqual([]);
    expect(request.decided_at).toBeNull();
    expect(request.note).toBeNull();
  });

  it("records who was eligible, not just who was asked", () => {
    // The panel shows the approver who was *not* bothered — that is the point
    // minimum-sufficient-clearance routing is making.
    const request = ApprovalRequest.parse({
      ...minimal,
      candidate_approver_ids: ["b@example.com", "c@example.com"],
      approver_id: "b@example.com",
    });
    expect(request.candidate_approver_ids).toEqual(["b@example.com", "c@example.com"]);
  });
});

describe("GovernanceEvent", () => {
  const minimal = {
    id: "evt_1",
    ts: "2026-01-01T00:00:00.000Z",
    execution_id: "tc_1",
    hook: "pre" as const,
    user_id: "a@example.com",
    tool: "Widgets.update_widget",
    decision: "deny" as const,
    reason: "Denied.",
    rule_id: "rule.1",
  };

  it("matches the event contract in DESIGN.md", () => {
    expect(Object.keys(GovernanceEvent.parse(minimal)).sort()).toEqual(
      [
        "decision",
        "execution_id",
        "hook",
        "id",
        "reason",
        "rule_id",
        "ts",
        "tool",
        "user_id",
      ].sort(),
    );
  });

  it("allows an empty execution_id, which is what /access has", () => {
    // `/access` governs discovery; there is no execution to identify yet.
    expect(
      GovernanceEvent.parse({ ...minimal, hook: "access", execution_id: "" })
        .execution_id,
    ).toBe("");
  });

  it("carries before and after only when something changed", () => {
    const modified = GovernanceEvent.parse({
      ...minimal,
      decision: "modify",
      before: { identifier: "0000000000" },
      after: { identifier: "[REDACTED]" },
    });
    expect(modified.before).toEqual({ identifier: "0000000000" });
    expect(modified.after).toEqual({ identifier: "[REDACTED]" });
  });

  it("survives a JSON round-trip, which is how it reaches the panel", () => {
    const event = GovernanceEvent.parse(minimal);
    expect(GovernanceEvent.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });
});
