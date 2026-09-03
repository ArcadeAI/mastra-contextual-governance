/**
 * The governance layer: hook framework, policy engine, redaction, audit,
 * event bus. Deliberately free of any business-domain vocabulary, and —
 * enforced by `test/no-app-dependencies.test.ts` — of any dependency on
 * `apps/*`. Swapping the domain means replacing the governed app, never
 * touching this.
 *
 * The types live one layer down in `@cg/policy-schema` (#5) so that the apps,
 * the UI and this package all agree on one definition. Re-exported here for
 * convenience; `@cg/policy-schema` remains the single source.
 *
 * The four pure modules arrive in #7 (PolicyEngine), #8 (RedactionEngine),
 * #9 (ApproverRouter) and #10 (GrantChecker).
 */
import { type Decision } from "@cg/policy-schema";

export { Decision, Effect, GovernanceEvent, HookPoint } from "@cg/policy-schema";

export { routeApproval, type RoutingResult } from "./approver-router.ts";

/**
 * Arcade calls hooks over the public internet, so an outage must degrade to
 * denial rather than to open access (PRD user story 24). Hooks declare their
 * failure mode explicitly — spike #2 measured that there is no default to
 * inherit: `failure_mode` is a required field.
 */
export const FAIL_CLOSED: Decision = {
  effect: "deny",
  reason: "Governance hook unavailable; failing closed.",
  rule_id: null,
};
