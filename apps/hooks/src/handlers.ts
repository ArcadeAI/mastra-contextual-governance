/**
 * The three hooks, as functions from Arcade's payload to Arcade's response.
 *
 * Nothing here decides anything. Each handler resolves `context.user_id` to a
 * `Subject`, hands the pure `PolicyEngine` our own types, and translates the
 * `Decision` it gets back into the generated response type — plus the audit
 * rows describing what was decided. If an `if` about who may do what appears
 * in this file, it belongs in `@cg/governance-core` instead.
 *
 * Every handler is total: given a cache in the `failed` state, or a subject
 * the roster does not know, it still returns a well-formed response — the
 * denying one — and the rows recording why. The HTTP layer adds the last
 * fail-closed net for the cases where even a payload could not be parsed.
 *
 * Pure apart from `ctx.now` and `ctx.newId`, which are injected so tests can
 * pin them.
 */
import { evaluatePermission, resolveVisibility, type ToolRef } from "@cg/governance-core";
import {
  qualify,
  type AccessHookRequest,
  type AccessHookResult,
  type GovernanceEvent,
  type PostHookRequest,
  type PostHookResult,
  type PreHookRequest,
  type PreHookResult,
  type ToolkitInfo,
  type Toolkits,
} from "@cg/policy-schema";

import { withCorrelation } from "./correlation.ts";
import { findSubject, type CacheState } from "./policy-cache.ts";

export interface HandlerContext {
  now: () => string;
  newId: () => string;
}

/** What a handler produces: the wire response and the rows to append. */
export interface Outcome<R> {
  response: R;
  events: GovernanceEvent[];
}

/** Why a request is being failed closed, in the words the audit row carries. */
function failClosedReason(state: CacheState, what: string): string {
  return state.status === "failed"
    ? `FAIL-CLOSED: the control plane could not load its policy (${state.error}), so ${what}.`
    : `FAIL-CLOSED: ${what}.`;
}

// ---------------------------------------------------------------------------
// /access
// ---------------------------------------------------------------------------

/**
 * Which of the tools Arcade is about to list may this user see.
 *
 * The response's `deny` map takes the *request's* `Toolkits` shape, down to the
 * innermost array of versions; spike #2 measured what any other shape does
 * (every tool in the project fails). So each denied tool's entry is the
 * request's own entry for it, copied across.
 *
 * Audit granularity is deliberate. Tools in a governed toolkit get one row per
 * decision — allowed or hidden — because those are the rows act 1 is about. A
 * toolkit the catalogue does not govern is hidden wholesale by the engine
 * (fail-closed on an unknown toolkit), and with the whole project catalogue in
 * the request that could be thousands of rows saying the same thing; those get
 * one row per toolkit, `Toolkit.*`, with the engine's reason and the count.
 */
export function handleAccess(
  request: AccessHookRequest,
  state: CacheState,
  ctx: HandlerContext,
): Outcome<AccessHookResult> {
  const ts = ctx.now();
  const deny: Toolkits = {};
  const events: GovernanceEvent[] = [];

  const base = { ts, execution_id: "", hook: "access" as const, user_id: request.user_id };

  for (const [toolkit, info] of Object.entries(request.toolkits)) {
    const versionsByTool = info.tools ?? {};
    const names = Object.keys(versionsByTool);
    if (names.length === 0) continue;

    if (state.status !== "ready") {
      deny[toolkit] = { tools: { ...versionsByTool } };
      events.push({
        ...base,
        id: ctx.newId(),
        tool: qualify(toolkit, "*"),
        decision: "deny",
        reason: failClosedReason(
          state,
          `all ${names.length} tool(s) in "${toolkit}" are hidden from this user`,
        ),
        rule_id: null,
      });
      continue;
    }

    const subject = findSubject(state, request.user_id);
    const refs: ToolRef[] = names.map((name) => ({ toolkit, name }));
    const decisions = resolveVisibility(subject, refs, state.policy);
    const governed = toolkit in state.catalogue;

    const hidden: NonNullable<ToolkitInfo["tools"]> = {};
    for (const { tool, decision } of decisions) {
      if (decision.effect === "deny") hidden[tool.name] = versionsByTool[tool.name] ?? [];
      if (governed) {
        events.push({
          ...base,
          id: ctx.newId(),
          tool: qualify(tool.toolkit, tool.name),
          decision: decision.effect,
          reason: decision.reason,
          rule_id: decision.rule_id,
        });
      }
    }
    if (Object.keys(hidden).length > 0) deny[toolkit] = { tools: hidden };

    if (!governed) {
      // Every decision for an ungoverned toolkit is the same engine denial.
      const first = decisions[0]?.decision;
      events.push({
        ...base,
        id: ctx.newId(),
        tool: qualify(toolkit, "*"),
        decision: first?.effect ?? "deny",
        reason: `${first?.reason ?? "Ungoverned toolkit."} (${names.length} tool(s) hidden)`,
        rule_id: first?.rule_id ?? null,
      });
    }
  }

  return { response: { deny }, events };
}

// ---------------------------------------------------------------------------
// /pre
// ---------------------------------------------------------------------------

/**
 * May this user make this call with these inputs.
 *
 * A denial's `error_message` is the engine's `reason` — the remediation
 * instruction the rule author wrote, already rendered with the call's values —
 * with the audit row's id appended as the correlation token (#6). The model
 * reads that string and nothing else.
 *
 * Grants are not consulted yet: `GrantChecker` (#10) has not landed, and the
 * engine only accepts grants that have been through it. Until then a denial
 * stands even after an approval — which is the honest state of the system,
 * not a placeholder allow.
 */
export function handlePre(
  request: PreHookRequest,
  state: CacheState,
  ctx: HandlerContext,
): Outcome<PreHookResult> {
  const id = ctx.newId();
  const tool = { toolkit: request.tool.toolkit, name: request.tool.name };
  const qualified = qualify(tool.toolkit, tool.name);
  const userId = request.context.user_id ?? "";

  // What the model is told when the policy itself is unavailable. The audit
  // row carries the full error; the model gets one sentence and the reference,
  // because a compiler's problem list is for the administrator, not the agent.
  const unavailable =
    `DENIED: the control plane cannot evaluate ${qualified} because its policy is ` +
    `unavailable. Do not retry ${qualified}; report the reference to an administrator.`;

  const decision =
    state.status === "ready"
      ? evaluatePermission({
          subject: findSubject(state, request.context.user_id),
          tool,
          inputs: request.inputs,
          policy: state.policy,
        })
      : {
          effect: "deny" as const,
          reason: failClosedReason(state, `${qualified} cannot be evaluated`),
          rule_id: null,
        };

  const event: GovernanceEvent = {
    id,
    ts: ctx.now(),
    execution_id: request.execution_id,
    hook: "pre",
    user_id: userId,
    tool: qualified,
    decision: decision.effect,
    reason: decision.reason,
    rule_id: decision.rule_id,
  };

  const response: PreHookResult =
    decision.effect === "allow"
      ? { code: "OK" }
      : {
          code: "CHECK_FAILED",
          error_message: withCorrelation(state.status === "ready" ? decision.reason : unavailable, id),
        };

  return { response, events: [event] };
}

// ---------------------------------------------------------------------------
// /post
// ---------------------------------------------------------------------------

/**
 * Pass-through, recorded. The `RedactionEngine` (#8) wires in at #16; until
 * then every output is allowed unchanged and the audit row says so, so the
 * panel's post lane is live from the first deploy and a reviewer can see that
 * nothing was rewritten rather than wonder whether it was.
 */
export function handlePost(request: PostHookRequest, ctx: HandlerContext): Outcome<PostHookResult> {
  const event: GovernanceEvent = {
    id: ctx.newId(),
    ts: ctx.now(),
    execution_id: request.execution_id,
    hook: "post",
    user_id: request.context.user_id ?? "",
    tool: qualify(request.tool.toolkit, request.tool.name),
    decision: "allow",
    reason: "Output passed through unchanged; output rules are not evaluated until #16.",
    rule_id: null,
  };
  return { response: { code: "OK" }, events: [event] };
}
