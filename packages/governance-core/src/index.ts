/**
 * The governance layer: hook framework, policy engine, redaction, audit,
 * event bus. Deliberately free of any loan-domain vocabulary, and — enforced
 * by `test/no-app-dependencies.test.ts` — of any dependency on `apps/*`.
 * Swapping the domain means replacing `apps/loan-mcp`, never touching this.
 *
 * The four pure modules arrive in #7 (PolicyEngine), #8 (RedactionEngine),
 * #9 (ApproverRouter) and #10 (GrantChecker).
 */
import { Effect, type GovernanceEvent, type HookPoint } from "@cg/policy-schema";

export { Effect, type GovernanceEvent, type HookPoint };

/** What every hook returns. `override` carries a modified payload for `modify`. */
export interface Decision {
  effect: Effect;
  reason: string;
  rule_id: string | null;
  override?: unknown;
}

/**
 * Arcade calls hooks over the public internet, so an outage must degrade to
 * denial rather than to open access (PRD user story 24). Hooks declare their
 * failure mode explicitly — spike #2 warns against relying on the default.
 */
export const FAIL_CLOSED: Decision = {
  effect: "deny",
  reason: "Governance hook unavailable; failing closed.",
  rule_id: null,
};
