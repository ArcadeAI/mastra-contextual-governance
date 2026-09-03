/**
 * The governance vocabulary. Hand-written, because it is ours.
 *
 * Everything here is domain-agnostic on purpose: it talks about subjects,
 * tools, inputs, outputs and clearances, never about what the governed system
 * happens to do. Forking this template means replacing the governed app and
 * its seed data and touching nothing under `packages/` — a type in this file that
 * named the demo's business domain would break that promise, so `#24` greps for
 * it. Anything scenario-specific belongs in the app, not here.
 *
 * Nullable rather than optional, nearly everywhere. These records round-trip
 * through `bun:sqlite` and across SSE, and `undefined` does not survive
 * `JSON.stringify` — an absent key and a key set to `undefined` serialise
 * identically, so a field that is *meaningfully* empty says so with `null`.
 *
 * Every object here is `.strict()` — the opposite of the generated hook
 * contract next door, and for the opposite reason. Those payloads are Arcade's
 * and may grow; these are ours and may not. Zod 3 strips unknown keys by
 * default, so a misspelled field in a policy row would parse cleanly and
 * evaluate as though it had never been written: a rule narrower than intended
 * becomes a blanket rule, and a constraint someone thought they had applied is
 * simply absent. That is a silent fail-open in the policy table of a demo whose
 * whole thesis is that controls must not fail silently. Strict makes it a parse
 * error at seed time instead.
 *
 * `Timestamp` is `z.string().datetime()`, which accepts only `Z`-suffixed UTC
 * instants: `2026-01-01T00:00:00.000Z`. It rejects a `+00:00` offset and it
 * rejects SQLite's own `datetime('now')` format. Anything writing these rows
 * must stamp them with `new Date().toISOString()` and never let SQLite supply
 * the value, or every row fails on the way back out.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Which of Arcade's three control points a rule or event belongs to. */
export const HookPoint = z.enum(["access", "pre", "post"]);
export type HookPoint = z.infer<typeof HookPoint>;

/** What a decision does. `modify` means the payload was rewritten, not blocked. */
export const Effect = z.enum(["allow", "deny", "modify"]);
export type Effect = z.infer<typeof Effect>;

/** ISO 8601 instant, UTC. Every timestamp in this package is this. */
export const Timestamp = z.string().datetime();
export type Timestamp = z.infer<typeof Timestamp>;

/** A tool input map, exactly as it arrives on a hook payload. */
export const Inputs = z.record(z.unknown());
export type Inputs = z.infer<typeof Inputs>;

/**
 * Matches a tool by `toolkit` and `name`, the only two fields a hook payload
 * carries. `"*"` matches any value for that segment.
 *
 * Spike 02 is the reason there is no `operations` or `service_domains` here:
 * `tool.metadata` is never populated on hook payloads — not for remote MCP
 * tools and not for hosted toolkits either — so a rule keyed on tool behaviour
 * matches nothing, which is indistinguishable from a rule that permits.
 * Classification lives in our own rules, keyed on the name.
 */
export const ToolMatcher = z
  .object({
    toolkit: z.string().min(1),
    tool: z.string().min(1),
  })
  .strict();
export type ToolMatcher = z.infer<typeof ToolMatcher>;

// ---------------------------------------------------------------------------
// Subject — who a decision is about
// ---------------------------------------------------------------------------

/**
 * The identity a decision is made about, as the control plane knows it.
 *
 * `user_id` is whatever Arcade puts in `context.user_id` — for this demo a real
 * email address, so OAuth actually works. `clearance` is a unit-free numeric
 * ceiling: the routing and limit rules compare numbers and never learn what
 * the number counts.
 */
export const Subject = z
  .object({
    user_id: z.string().min(1),
    display_name: z.string(),
    /** Opaque role key. Policy rules match on it; nothing interprets it. */
    role: z.string().min(1),
    /**
     * Upper bound on the numeric inputs this subject may pass, compared by the
     * `exceeds_clearance` condition. `0` means "no numeric authority at all".
     */
    clearance: z.number().nonnegative(),
    /** Extension point for forkers: any additional attributes rules can match on. */
    attributes: z.record(z.unknown()).default({}),
  })
  .strict();
export type Subject = z.infer<typeof Subject>;

/**
 * Which subjects a rule applies to. Every field is a narrowing filter, `null`
 * means "do not narrow on this", and a matcher that narrows on nothing matches
 * everyone — so a rule with no `subjects` is a blanket rule, which is the
 * common case.
 *
 * The two clearance bounds are what let a redaction rule apply to junior
 * subjects and not to senior ones (#8: "rules can be conditioned on the
 * subject's role or clearance") without the rule knowing what clearance
 * measures. Both bounds together express a band.
 *
 * `.strict()`, and this is the important part. An unrecognised key here — a
 * typo, or a predicate someone assumed existed — would otherwise be stripped
 * silently, leaving `{ user_ids: null, roles: null, ... }`: a matcher that
 * narrows on nothing and therefore applies to everyone. A rule intended for
 * one role would quietly govern the whole roster. Strict turns that into a
 * parse error at seed time.
 */
export const SubjectMatcher = z
  .object({
    user_ids: z.array(z.string()).nullable().default(null),
    roles: z.array(z.string()).nullable().default(null),
    /** Applies only to subjects whose clearance is strictly below this. */
    clearance_below: z.number().nullable().default(null),
    /** Applies only to subjects whose clearance is greater than or equal to this. */
    clearance_at_least: z.number().nullable().default(null),
  })
  .strict();
export type SubjectMatcher = z.infer<typeof SubjectMatcher>;

// ---------------------------------------------------------------------------
// Conditions — the parameter-aware part
// ---------------------------------------------------------------------------

/**
 * How a condition compares. `exceeds_clearance` is the only operator that
 * reads the subject rather than the rule: it is true when the numeric value at
 * `input` is greater than `Subject.clearance`, which is how an authority limit
 * gets expressed without the policy table knowing anyone's number.
 */
export const ConditionOperator = z.enum([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "nin",
  "matches",
  "exists",
  "exceeds_clearance",
]);
export type ConditionOperator = z.infer<typeof ConditionOperator>;

/**
 * One predicate over a tool's inputs.
 *
 * `input` is a dot path into the input map, so nested arguments are reachable
 * (`applicant.id`). `value` is unused by `exists` and `exceeds_clearance`; for
 * `in`/`nin` it is an array, and for `matches` a regular-expression source
 * string. Evaluation is #7's job — this type only says what can be written
 * down, and #7 owns rejecting the combinations that make no sense.
 */
export const Condition = z
  .object({
    input: z.string().min(1),
    operator: ConditionOperator,
    value: z.unknown().nullable().default(null),
  })
  .strict();
export type Condition = z.infer<typeof Condition>;

// ---------------------------------------------------------------------------
// PolicyRule — access and pre-execution
// ---------------------------------------------------------------------------

/**
 * One row of the policy table, evaluated at `/access` or `/pre`.
 *
 * `reason` is load-bearing rather than cosmetic. Over MCP a denial reaches the
 * model as `"Tool execution was denied by an extension policy: " + reason` and
 * nothing else (spike 02), so this string *is* the remediation instruction the
 * agent acts on. The hook writes it; the system prompt does not.
 *
 * Rules are ordered by ascending `priority`, first match wins. Ties are
 * resolved by `id` so evaluation is deterministic whatever order the database
 * returns rows in.
 */
export const PolicyRule = z
  .object({
    id: z.string().min(1),
    description: z.string(),
    /** `access` hides the tool during discovery; `pre` blocks the call. */
    hook: z.enum(["access", "pre"]),
    match: ToolMatcher,
    subjects: SubjectMatcher.nullable().default(null),
    /** All conditions must hold for the rule to fire. Empty means "always". */
    conditions: z.array(Condition).default([]),
    effect: Effect,
    reason: z.string(),
    priority: z.number().int(),
    enabled: z.boolean().default(true),
  })
  .strict();
export type PolicyRule = z.infer<typeof PolicyRule>;

// ---------------------------------------------------------------------------
// OutputRule — post-execution
// ---------------------------------------------------------------------------

/** What to do with matched content. `remove` drops it; the others leave a marker. */
export const RedactionStrategy = z.enum(["mask", "remove", "replace"]);
export type RedactionStrategy = z.infer<typeof RedactionStrategy>;

/** Redact a known field, addressed by dot path into the tool's output. */
export const FieldRedaction = z
  .object({
    path: z.string().min(1),
    strategy: RedactionStrategy,
    /** Used by `mask` and `replace`; ignored by `remove`. */
    replacement: z.string().default("[REDACTED]"),
  })
  .strict();
export type FieldRedaction = z.infer<typeof FieldRedaction>;

/**
 * Redact by pattern, for content whose shape is known but whose location is
 * not — free text a tool returns, including text that arrived from somewhere
 * untrusted and is trying to address the model.
 */
export const PatternRedaction = z
  .object({
    id: z.string().min(1),
    /** Regular-expression source. Stored as a string so the policy table is data. */
    regex: z.string().min(1),
    /** Regex flags. `g` is implied by the engine; declare only the rest. */
    flags: z.string().default("i"),
    strategy: RedactionStrategy,
    replacement: z.string().default("[REDACTED]"),
  })
  .strict();
export type PatternRedaction = z.infer<typeof PatternRedaction>;

/**
 * One row of the output-policy table, evaluated at `/post`.
 *
 * Two mechanisms in one type because they are two answers to the same
 * question — what must not reach the model — and a single rule commonly wants
 * both: pull the fields you can name, then sweep what is left for the shapes
 * you can recognise.
 */
export const OutputRule = z
  .object({
    id: z.string().min(1),
    description: z.string(),
    match: ToolMatcher,
    subjects: SubjectMatcher.nullable().default(null),
    fields: z.array(FieldRedaction).default([]),
    patterns: z.array(PatternRedaction).default([]),
    /** Recorded on the resulting event, and shown on the control-plane panel. */
    reason: z.string(),
    priority: z.number().int(),
    enabled: z.boolean().default(true),
  })
  .strict();
export type OutputRule = z.infer<typeof OutputRule>;

// ---------------------------------------------------------------------------
// Decision — what every hook returns
// ---------------------------------------------------------------------------

/**
 * The outcome of evaluating one hook. This is the internal shape; translating
 * it into a `PreHookResult` / `PostHookResult` / `AccessHookResult` is the hook
 * handler's job (#12).
 *
 * `override` carries the rewritten payload when `effect` is `modify` — inputs
 * at `/pre`, output at `/post` — and is absent otherwise. It is `unknown`
 * because what gets rewritten differs per hook point, and narrowing it here
 * would push a discriminated union into every consumer that only wants to log
 * the effect.
 */
export const Decision = z
  .object({
    effect: Effect,
    reason: z.string(),
    /** The rule that decided, or `null` for a default (no rule matched, or fail-closed). */
    rule_id: z.string().nullable(),
    override: z.unknown().optional(),
  })
  .strict();
export type Decision = z.infer<typeof Decision>;

// ---------------------------------------------------------------------------
// Approvals and grants
// ---------------------------------------------------------------------------

export const ApprovalStatus = z.enum(["pending", "approved", "denied", "expired"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/**
 * A blocked call, escalated to a human.
 *
 * `approver_id` is chosen deterministically from `candidate_approver_ids` —
 * minimum sufficient clearance, requester excluded (#9). The model does not
 * pick, and the candidate list is recorded so the panel can show *who was not*
 * bothered, which is the point being demonstrated.
 *
 * `required_clearance` is the numeric bar the approver had to clear, in the
 * same unit-free scale as `Subject.clearance`.
 */
export const ApprovalRequest = z
  .object({
    id: z.string().min(1),
    requester_id: z.string().min(1),
    approver_id: z.string().nullable(),
    candidate_approver_ids: z.array(z.string()).default([]),
    /** The call being escalated. */
    match: ToolMatcher,
    /** Opaque identifier of the thing being acted on, if the action names one. */
    resource_id: z.string().nullable(),
    /** The inputs as submitted. A grant is issued against exactly these. */
    inputs: Inputs,
    justification: z.string(),
    required_clearance: z.number().nonnegative().nullable(),
    status: ApprovalStatus,
    /** The approver's note, once they have decided. */
    note: z.string().nullable().default(null),
    /** Correlates back to the `/pre` payload that triggered the escalation. */
    execution_id: z.string().nullable().default(null),
    created_at: Timestamp,
    decided_at: Timestamp.nullable().default(null),
  })
  .strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

/**
 * A narrow, expiring permission produced by an approval — the thing the pre-hook
 * looks for on the retry.
 *
 * Deliberately not a role change. It is scoped to one tool and one resource,
 * pinned to the inputs that were approved, bounded above on the one input that
 * carries a numeric bound, limited in uses and time-boxed — so replaying it
 * against a larger value, a different resource, or next week all fail. `granted_by` is stored rather than
 * derived because separation of duties (#10) is checked against it: a grant
 * whose `granted_by` equals its `subject_id` is invalid no matter what the
 * approval record says.
 */
export const Grant = z
  .object({
    id: z.string().min(1),
    /** Who the grant empowers. */
    subject_id: z.string().min(1),
    /** Who approved it. Must differ from `subject_id`. */
    granted_by: z.string().min(1),
    /** The approval this grant came from. */
    request_id: z.string().min(1),
    match: ToolMatcher,
    resource_id: z.string().nullable(),
    /**
     * Inputs the retry must present *exactly*. Anything not named here is
     * unconstrained except by `ceiling`, and the input `ceiling` names is not
     * matched here — a ceiling is an upper bound, not an equality.
     */
    pinned_inputs: Inputs,
    /**
     * The numeric ceiling this grant authorises, if it authorises one.
     *
     * #10 has to reject a replay at a higher value while accepting a retry at or
     * below the approved one, so an exact-match input map cannot express it:
     * `{ input: "quantity", max: 95 }` means the named input must be present, be
     * a number, and be no greater than 95. Which input carries the bound is data,
     * so nothing here learns what the number counts.
     *
     * `null` for a grant with no numeric dimension at all.
     */
    ceiling: z
      .object({ input: z.string().min(1), max: z.number() })
      .strict()
      .nullable()
      .default(null),
    issued_at: Timestamp,
    expires_at: Timestamp,
    /** `null` means unlimited within the expiry window. */
    uses_remaining: z.number().int().nonnegative().nullable().default(1),
    revoked_at: Timestamp.nullable().default(null),
  })
  .strict();
export type Grant = z.infer<typeof Grant>;

// ---------------------------------------------------------------------------
// GovernanceEvent — the audit row and the SSE frame
// ---------------------------------------------------------------------------

/**
 * One decision by one hook: the audit record, and the frame the control-plane
 * panel renders. Same shape for both on purpose — the panel shows the audit
 * log rather than a prettier parallel story.
 *
 * `before` and `after` are the payload either side of a `modify`, which is what
 * makes the redaction and injection-stripping acts visible as a diff. They are
 * absent for `allow` and `deny`, where nothing changed.
 *
 * `execution_id` is Arcade's, and correlates `/pre` with `/post` exactly. It is
 * empty at `/access`, which has no execution to identify, and spike 02 found it
 * never reaches an MCP client — so the panel joins on it server-side and cannot
 * expect the browser to supply it.
 */
export const GovernanceEvent = z
  .object({
    id: z.string().min(1),
    ts: Timestamp,
    execution_id: z.string(),
    hook: HookPoint,
    user_id: z.string(),
    /** Fully-qualified `Toolkit.tool_name`, as the panel displays it. */
    tool: z.string(),
    decision: Effect,
    reason: z.string(),
    rule_id: z.string().nullable(),
    before: z.unknown().optional(),
    after: z.unknown().optional(),
  })
  .strict();
export type GovernanceEvent = z.infer<typeof GovernanceEvent>;
