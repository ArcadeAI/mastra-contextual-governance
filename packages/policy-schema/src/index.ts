/**
 * Shared contracts for the governance layer.
 *
 * Real hook payload types land in #5, generated from the OpenAPI spec in
 * `ArcadeAI/schemas`. This slice defines only the governance event, because
 * the scaffold needs something to typecheck and every service already agrees
 * on this shape (DESIGN.md, "Event contract").
 */
import { z } from "zod";

export const HookPoint = z.enum(["access", "pre", "post"]);
export type HookPoint = z.infer<typeof HookPoint>;

export const Effect = z.enum(["allow", "deny", "modify"]);
export type Effect = z.infer<typeof Effect>;

/** One decision by one hook, as streamed to the control-plane panel. */
export const GovernanceEvent = z.object({
  id: z.string(),
  ts: z.string().datetime(),
  execution_id: z.string(),
  hook: HookPoint,
  user_id: z.string(),
  tool: z.string(),
  decision: Effect,
  reason: z.string(),
  rule_id: z.string().nullable(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type GovernanceEvent = z.infer<typeof GovernanceEvent>;
