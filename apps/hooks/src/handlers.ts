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
import {
  consumeGrant,
  evaluatePermission,
  resolveVisibility,
  routeApproval,
  selectGrant,
  type GrantRejection,
  type ToolRef,
  type ValidatedGrant,
} from "@cg/governance-core";
import {
  qualify,
  type AccessHookRequest,
  type AccessHookResult,
  type Decision,
  type GovernanceEvent,
  type Inputs,
  type PostHookRequest,
  type PostHookResult,
  type PreHookRequest,
  type PreHookResult,
  type Subject,
  type ToolkitInfo,
  type Toolkits,
} from "@cg/policy-schema";

import {
  DECIDE,
  grantFrom,
  REQUEST_APPROVAL,
  withResolvedApproval,
  type ApprovalControl,
} from "./approval-governance.ts";
import type { StoredApproval } from "./approvals-store.ts";
import { withCorrelation } from "./correlation.ts";
import { findSubject, type CacheState } from "./policy-cache.ts";

export interface HandlerContext {
  now: () => string;
  newId: () => string;
  /**
   * The approval flow's half of `/pre`: the approval a `Decide` call names,
   * and the grants an approval issues and a retry spends. Required rather than
   * optional — a server built without it would silently stop consulting
   * grants, and a control that quietly does nothing is the failure this repo
   * is organised against.
   */
  approvals: ApprovalControl;
}

/** What a handler produces: the wire response and the rows to append. */
export interface Outcome<R> {
  response: R;
  events: GovernanceEvent[];
}

/** Why a request is being failed closed, in the words the audit row carries. */
function failClosedReason(state: CacheState, what: string): string {
  switch (state.status) {
    case "failed":
      return `FAIL-CLOSED: the control plane could not load its policy (${state.error}), so ${what}.`;
    case "cold":
      return `FAIL-CLOSED: the control plane has not loaded its policy yet, so ${what}.`;
    case "ready":
      return `FAIL-CLOSED: ${what}.`;
  }
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
 * One audit row per tool decided, allowed or hidden, governed or not — the
 * whole-project catalogue makes that thousands of rows per call, and that is
 * the cost of a table a reviewer can reconstruct every decision from. The
 * rows go in as one transaction (see `audit-log.ts`), and the bench shows the
 * cost: tens of milliseconds against a 5 s budget.
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
  const subject = findSubject(state, request.user_id);

  for (const [toolkit, info] of Object.entries(request.toolkits)) {
    const versionsByTool = info.tools ?? {};
    const names = Object.keys(versionsByTool);
    if (names.length === 0) continue;

    const refs: ToolRef[] = names.map((name) => ({ toolkit, name }));
    const decisions: readonly { tool: ToolRef; decision: Decision }[] =
      state.status === "ready"
        ? resolveVisibility(subject, refs, state.policy)
        : refs.map((tool) => ({
            tool,
            decision: {
              effect: "deny",
              reason: failClosedReason(state, `${qualify(tool.toolkit, tool.name)} is hidden`),
              rule_id: null,
            },
          }));

    const hidden: NonNullable<ToolkitInfo["tools"]> = {};
    for (const { tool, decision } of decisions) {
      if (decision.effect === "deny") hidden[tool.name] = versionsByTool[tool.name] ?? [];
      events.push({
        ...base,
        id: ctx.newId(),
        tool: qualify(tool.toolkit, tool.name),
        decision: decision.effect,
        reason: decision.reason,
        rule_id: decision.rule_id,
      });
    }
    if (Object.keys(hidden).length > 0) deny[toolkit] = { tools: hidden };
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
 * The audit row's `reason` is allowed to say *more* than the model is told,
 * and does: which grants were examined and rejected, who a request was routed
 * to, which grant an approval issued. Those are facts a compliance reviewer
 * and the control-plane panel need and the model has no business acting on, so
 * they never reach `error_message`.
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

  const { decision, auditReason } =
    state.status === "ready"
      ? decidePre(request, tool, state, ctx)
      : {
          decision: {
            effect: "deny" as const,
            reason: failClosedReason(state, `${qualified} cannot be evaluated`),
            rule_id: null,
          },
          auditReason: failClosedReason(state, `${qualified} cannot be evaluated`),
        };

  const event: GovernanceEvent = {
    id,
    ts: ctx.now(),
    execution_id: request.execution_id,
    hook: "pre",
    user_id: userId,
    tool: qualified,
    decision: decision.effect,
    reason: auditReason,
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

/** A `/pre` decision, plus the fuller account the audit row carries. */
interface PreDecision {
  decision: Decision;
  auditReason: string;
}

type ReadyState = Extract<CacheState, { status: "ready" }>;

/**
 * The `/pre` decision when the policy is loaded: resolve, evaluate, and — only
 * then — write.
 *
 * The order is the point. Nothing is written before the engine has allowed the
 * call, so there is no path on which a grant exists for a decision that was
 * refused; and the grant a decision issues is built from the approval record,
 * never from the arguments of the call that triggered it.
 */
function decidePre(
  request: PreHookRequest,
  tool: ToolRef,
  state: ReadyState,
  ctx: HandlerContext,
): PreDecision {
  const control = ctx.approvals;
  const subject = findSubject(state, request.context.user_id);
  const clickerId = subject?.user_id ?? request.context.user_id ?? "";
  const inApprovals = tool.toolkit === control.toolkit;

  // A `Decide` call names an approval by an opaque id and nothing else; the
  // three facts the decision turns on live in `governance.db`. Resolving them
  // here is what lets `pre.decide-*` be policy rows rather than code.
  const stored: StoredApproval | null =
    inApprovals && tool.name === DECIDE ? resolveApproval(request.inputs, control) : null;
  const inputs: Inputs =
    inApprovals && tool.name === DECIDE
      ? withResolvedApproval(request.inputs, stored, clickerId)
      : request.inputs;

  // Grants this subject holds for this exact call. `GrantChecker` judges each
  // one against *these* inputs — a grant validated in the abstract and then
  // applied to another resource is the replay it exists to stop.
  const selection =
    subject === null
      ? { grant: null as ValidatedGrant | null, rejected: [] as readonly GrantRejection[] }
      : selectGrant({
          grants: control.store.grantsFor(subject.user_id, tool),
          subject,
          tool,
          inputs,
          now: new Date(ctx.now()),
        });

  const evaluate = (grants: readonly ValidatedGrant[]): Decision =>
    evaluatePermission({ subject, tool, inputs, policy: state.policy, grants });

  // Evaluated twice, and cheaply: the engine is pure. The second answer is
  // what says whether the grant was *decisive*, which is the only condition
  // under which a use is spent. A call policy would have allowed anyway must
  // not burn the one use an approval bought.
  const withoutGrant = evaluate([]);
  const decision = selection.grant === null ? withoutGrant : evaluate([selection.grant]);
  const decisive =
    selection.grant !== null && decision.effect === "allow" && withoutGrant.effect === "deny";

  const notes: string[] = [];
  if (decisive && selection.grant !== null) {
    const spent = consumeGrant(selection.grant);
    control.store.consume(spent);
    notes.push(
      `Grant ${spent.id} was decisive and has been consumed (${spent.uses_remaining ?? "unlimited"} ` +
        `use(s) left, expires ${spent.expires_at}).`,
    );
  }
  for (const rejection of selection.rejected) {
    notes.push(`Grant ${rejection.grant_id} did not apply: ${rejection.message}`);
  }

  if (decision.effect === "allow" && inApprovals && tool.name === DECIDE && stored !== null) {
    notes.unshift(...settleDecision(stored, subject, inputs, control, ctx));
  }
  if (decision.effect === "allow" && inApprovals && tool.name === REQUEST_APPROVAL) {
    notes.unshift(narrateRouting(request.inputs, subject, state));
  }

  const auditReason = [decision.reason, ...notes].filter((line) => line.length > 0).join(" ");
  return { decision, auditReason };
}

/** The stored approval a `Decide` call names, or `null` for anything else. */
function resolveApproval(inputs: Inputs, control: ApprovalControl): StoredApproval | null {
  const requestId = inputs["request_id"];
  return typeof requestId === "string" ? control.store.approval(requestId) : null;
}

/**
 * Issue the grant an approved decision buys — the one write in this service
 * that produces authority, and it happens only downstream of an allow.
 *
 * A denial issues nothing: the point of a denial is that the retry stays
 * blocked. The unique index over `request_id` is what stops a `Decide`
 * replayed before the store has flipped the request to `approved` from minting
 * a second grant for the same approval.
 */
function settleDecision(
  stored: StoredApproval,
  subject: Subject | null,
  inputs: Inputs,
  control: ApprovalControl,
  ctx: HandlerContext,
): string[] {
  const decidedBy = subject?.user_id ?? "";
  const outcome = inputs["decision"];
  const record = stored.record;
  const headline =
    `${decidedBy} decides ${record.id} (${record.action} on ${record.resource_id} for ` +
    `${record.amount}) as "${String(outcome)}".`;

  if (outcome !== "approved") return [`${headline} No grant is issued by a denial.`];

  const grant = grantFrom(stored, decidedBy, control, new Date(ctx.now()));
  const inserted = control.store.issueGrant(grant);
  if (inserted === "duplicate_request") {
    return [`${headline} A grant for this approval already exists; no second one was issued.`];
  }
  const ceiling =
    grant.ceiling === null
      ? "no numeric ceiling"
      : `${grant.ceiling.input} at most ${grant.ceiling.max}`;
  return [
    `${headline} Grant ${grant.id} issued to ${grant.subject_id} for ` +
      `${qualify(grant.match.toolkit, grant.match.tool)} on ${String(grant.resource_id)}, ` +
      `${ceiling}, ${String(grant.uses_remaining)} use, expiring ${grant.expires_at}.`,
  ];
}

/**
 * Who this escalation will reach, worked out by the control plane rather than
 * read back from the tool.
 *
 * `routeApproval` is the same deterministic rule `tools/approvals` runs (both
 * checked against `approver-routing-cases.json`), so saying it here costs one
 * pure call and gives the panel the routing beat — including who was
 * *deliberately not* asked, which is the part the demo is about.
 */
function narrateRouting(inputs: Inputs, subject: Subject | null, state: ReadyState): string {
  const amount = inputs["amount"];
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || subject === null) {
    return "";
  }
  const roster = [...state.subjects.values()];
  const routed = routeApproval(amount, subject.user_id, roster);
  if (routed.outcome === "no_eligible_approver") {
    return `Nobody on the roster holds authority for ${amount}, so this escalation has no approver.`;
  }
  const notAsked = routed.candidates.slice(1).map((s) => `${s.display_name} (${s.clearance})`);
  return (
    `Routing ${amount} from ${subject.display_name} to ${routed.approver.display_name} ` +
    `(clearance ${routed.approver.clearance}), the lowest sufficient approver` +
    (notAsked.length > 0 ? `; also sufficient and not asked: ${notAsked.join(", ")}.` : ".")
  );
}

// ---------------------------------------------------------------------------
// /post
// ---------------------------------------------------------------------------

/**
 * Pass-through, recorded — while the control plane is healthy. The
 * `RedactionEngine` (#8) wires in at #16; until then every output is allowed
 * unchanged and the audit row says so, so the panel's post lane is live from
 * the first deploy and a reviewer can see that nothing was rewritten rather
 * than wonder whether it was.
 *
 * "Allowed unchanged" is a decision, and a decision needs a policy to be made
 * against. With the cache cold or failed there is no policy, so `/post` fails
 * closed like the other two hooks: `CHECK_FAILED`, the output withheld, a deny
 * row. A pass-through is only correct when the control plane can vouch for it.
 */
export function handlePost(
  request: PostHookRequest,
  state: CacheState,
  ctx: HandlerContext,
): Outcome<PostHookResult> {
  const id = ctx.newId();
  const qualified = qualify(request.tool.toolkit, request.tool.name);

  const decision: Decision =
    state.status === "ready"
      ? {
          effect: "allow",
          reason: "Output passed through unchanged; output rules are not evaluated until #16.",
          rule_id: null,
        }
      : {
          effect: "deny",
          reason: failClosedReason(state, `the output of ${qualified} cannot be released`),
          rule_id: null,
        };

  const event: GovernanceEvent = {
    id,
    ts: ctx.now(),
    execution_id: request.execution_id,
    hook: "post",
    user_id: request.context.user_id ?? "",
    tool: qualified,
    decision: decision.effect,
    reason: decision.reason,
    rule_id: decision.rule_id,
  };

  const response: PostHookResult =
    decision.effect === "allow"
      ? { code: "OK" }
      : {
          code: "CHECK_FAILED",
          error_message: withCorrelation(
            `DENIED: the control plane cannot release the output of ${qualified} because its ` +
              `policy is unavailable. Do not retry ${qualified}; report the reference to an administrator.`,
            id,
          ),
        };

  return { response, events: [event] };
}
