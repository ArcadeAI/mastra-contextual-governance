/**
 * PolicyEngine — parameter-aware allow/deny. Pure: no I/O, no clock, no
 * randomness, no imports from any app, no business-domain vocabulary.
 *
 *     (subject, tool, inputs, policy) → Decision
 *
 * Two questions, two entry points:
 *
 * - `resolveVisibility` — which tools may this subject see at all. Backs the
 *   `/access` hook's `deny` list.
 * - `evaluatePermission` — given the *actual parameter values* of a call, may
 *   this subject make it. Backs the `/pre` hook.
 *
 * The second is the interesting one. Being allowed to call a tool and being
 * allowed to call it *with these arguments* are different questions, and the
 * rules here evaluate against parameter values, not just tool names.
 *
 * ## What a denial `reason` is
 *
 * Over MCP a denial reaches the model as
 * `"Tool execution was denied by an extension policy: " + reason` and nothing
 * else. The `reason` is therefore not an apology — it is the remediation
 * instruction the model will act on, written for a model that has no other
 * context. Rule-authored reasons come from the policy table, with `{{…}}`
 * placeholders filled from the call (see `renderReason`). Engine-authored
 * reasons (the fail-closed defaults below) follow the same standard: they say
 * what was wrong, name the tool and input involved, and say whether a retry
 * can fix it.
 *
 * ## Fail-closed defaults
 *
 * Anything the engine cannot decide *from the policy* is a denial with
 * `rule_id: null`: an unregistered subject, a tool or toolkit the catalogue
 * does not list, a rule whose condition cannot be evaluated because the input
 * is missing or malformed. A *catalogued* call that no rule speaks about is
 * allowed with `rule_id: null`, because a policy that lists a tool and says
 * nothing more about it has permitted it — and `compilePolicy` exists to make
 * sure that silence is deliberate rather than a typo.
 *
 * ## Loudness
 *
 * A rule that matches nothing is indistinguishable, at runtime, from a rule
 * that permits. So `compilePolicy` refuses, up front and with the offending
 * rule ids, any rule that references a toolkit or tool the catalogue does not
 * list, a condition whose operator and value make no sense together, a
 * combination the hook point cannot honour, or a `pre` denial whose reason
 * does not tell the model what to do next. The catalogue is data — read from
 * config and the observed gateway — and never hardcoded here.
 *
 * ## Grants
 *
 * Grants are an input, not a lookup. #10 (`GrantChecker`) decides whether a
 * grant is *valid* — unexpired, unrevoked, uses remaining, pinned inputs and
 * ceiling honoured, approver ≠ subject. This module only asks whether a valid
 * grant *applies*: same subject, same tool. When a `pre` rule would deny and
 * an applicable grant is present, the call is allowed and the decision keeps
 * the overridden rule's `rule_id`, so the audit trail records *which* denial
 * the grant lifted.
 */
import {
  type Condition,
  type Decision,
  type Grant,
  type Inputs,
  type PolicyRule,
  type Subject,
  type ToolMatcher,
} from "@cg/policy-schema";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A tool as a hook payload identifies it: `tool.toolkit` and `tool.name`. */
export type ToolRef = {
  readonly toolkit: string;
  readonly name: string;
};

/**
 * The policy as loaded from the policy table plus configuration.
 *
 * `catalogue` maps every governed toolkit — the `ARCADE_*_TOOLKIT` values from
 * config, never hardcoded — to the tool names it serves. It is required, and
 * it is what lets a misspelled toolkit *or tool* in a rule be a compile error
 * instead of a rule that silently matches nothing. It is also the fail-closed
 * boundary at runtime: a call to anything the catalogue does not list is
 * denied, so a tool the policy has never heard of cannot slip through on the
 * "no rule matched" default.
 */
export type Policy = {
  readonly catalogue: Readonly<Record<string, readonly string[]>>;
  readonly rules: readonly PolicyRule[];
};

/** A `Policy` that `compilePolicy` has validated, sorted and prepared. */
export type CompiledPolicy = {
  readonly catalogue: ReadonlyMap<string, ReadonlySet<string>>;
  readonly rules: readonly CompiledRule[];
  /** Brand: only `compilePolicy` produces one of these. */
  readonly [COMPILED]: true;
};

/** The subject making the call, or `null` when `user_id` resolved to nobody. */
export type SubjectOrUnknown = Subject | null;

/** One tool's visibility for one subject. */
export type VisibilityDecision = {
  readonly tool: ToolRef;
  readonly decision: Decision;
};

export type PermissionInput = {
  readonly subject: SubjectOrUnknown;
  readonly tool: ToolRef;
  readonly inputs: Inputs;
  readonly policy: CompiledPolicy;
  /**
   * Grants that #10 has already judged valid. The engine only checks that a
   * grant applies to this subject and this tool.
   */
  readonly grants?: readonly Grant[];
};

/** Raised by `compilePolicy`. `problems` has one line per offending rule. */
export class PolicyCompileError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Policy failed to compile:\n  - ${problems.join("\n  - ")}`);
    this.name = "PolicyCompileError";
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// Compilation — the loud part
// ---------------------------------------------------------------------------

const COMPILED: unique symbol = Symbol("compiled-policy");

const WILDCARD = "*";

type CompiledCondition = Condition & {
  /** Pre-compiled for `matches`; `null` for every other operator. */
  readonly regex: RegExp | null;
};

type CompiledRule = Omit<PolicyRule, "conditions"> & {
  readonly conditions: readonly CompiledCondition[];
};

/** Placeholders a rule's `reason` may use. See `renderReason`. */
const REASON_ROOTS = new Set(["inputs", "subject", "tool"]);
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/** A `Toolkit.tool` reference inside prose. */
const TOOL_REFERENCE = /\b([A-Za-z][A-Za-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
/** An argument mention: `name=` or a `{{inputs.…}}` placeholder. */
const ARGUMENT_MENTION = /\b[A-Za-z_][A-Za-z0-9_]*=|\{\{\s*inputs\./;
/**
 * The one sentence that exempts a `pre` denial from naming a remediation tool:
 * it tells the model, in so many words, that nothing it can call will help.
 */
export const NO_REMEDIATION = "Do not retry";

/**
 * Validates a policy against its configuration and prepares it for
 * evaluation. Throws `PolicyCompileError` listing *every* problem, so a seed
 * file with three typos is fixed in one round.
 *
 * Rules are ordered by ascending `priority`, ties broken by `id`, so
 * evaluation is deterministic whatever order the table returned them in.
 * Disabled rules are dropped here rather than skipped on every call.
 */
export function compilePolicy(policy: Policy): CompiledPolicy {
  const problems: string[] = [];
  const catalogue = new Map<string, ReadonlySet<string>>();

  for (const [toolkit, tools] of Object.entries(policy.catalogue)) {
    if (tools.length === 0) {
      problems.push(`catalogue: toolkit "${toolkit}" lists no tools, so nothing in it can be governed`);
    }
    catalogue.set(toolkit, new Set(tools));
  }
  if (catalogue.size === 0) {
    problems.push(
      "catalogue is empty: no toolkit is governed, so every rule would match nothing",
    );
  }
  const toolkits = new Set(catalogue.keys());

  const seen = new Set<string>();
  const compiled: CompiledRule[] = [];

  for (const rule of policy.rules) {
    const at = `rule "${rule.id}"`;

    if (seen.has(rule.id)) problems.push(`${at}: duplicate id`);
    seen.add(rule.id);

    if (rule.match.toolkit !== WILDCARD && !toolkits.has(rule.match.toolkit)) {
      problems.push(
        `${at}: references toolkit "${rule.match.toolkit}", which is not configured ` +
          `(configured: ${[...toolkits].map((t) => `"${t}"`).join(", ") || "none"}). ` +
          `A rule matching nothing is indistinguishable from a rule that permits.`,
      );
    }

    const known = catalogue.get(rule.match.toolkit);
    if (known && rule.match.tool !== WILDCARD && !known.has(rule.match.tool)) {
      problems.push(
        `${at}: references tool "${rule.match.tool}", which toolkit "${rule.match.toolkit}" ` +
          `does not serve (serves: ${[...known].map((t) => `"${t}"`).join(", ")}). ` +
          `A rule matching nothing is indistinguishable from a rule that permits.`,
      );
    }
    if (rule.match.toolkit === WILDCARD && rule.match.tool !== WILDCARD) {
      const served = [...catalogue.values()].some((tools) => tools.has(rule.match.tool));
      if (!served) {
        problems.push(
          `${at}: references tool "${rule.match.tool}", which no configured toolkit serves`,
        );
      }
    }

    if (rule.effect === "modify") {
      problems.push(`${at}: effect "modify" is not a PolicyRule effect; use allow or deny`);
    }

    if (rule.hook === "access" && rule.conditions.length > 0) {
      problems.push(
        `${at}: an access rule cannot have conditions; /access carries no inputs to evaluate`,
      );
    }

    if (rule.hook === "pre" && rule.effect === "deny") {
      const problem = checkRemediation(rule.reason, catalogue);
      if (problem) problems.push(`${at}: ${problem}`);
    }

    for (const placeholder of rule.reason.matchAll(PLACEHOLDER)) {
      const root = (placeholder[1] as string).split(".")[0] as string;
      if (!REASON_ROOTS.has(root)) {
        problems.push(
          `${at}: reason placeholder "${placeholder[0]}" must start with one of ` +
            `${[...REASON_ROOTS].join(", ")}`,
        );
      }
    }

    const conditions: CompiledCondition[] = [];
    for (const condition of rule.conditions) {
      const problem = checkCondition(condition);
      if (problem) problems.push(`${at}: condition on "${condition.input}" ${problem}`);
      conditions.push({
        ...condition,
        regex:
          condition.operator === "matches" && typeof condition.value === "string"
            ? safeRegex(condition.value)
            : null,
      });
    }

    if (rule.enabled) compiled.push({ ...rule, conditions });
  }

  if (problems.length > 0) throw new PolicyCompileError(problems);

  compiled.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  return { catalogue, rules: compiled, [COMPILED]: true };
}

/**
 * A `pre` denial's `reason` is the only thing the model will read. It must
 * either name a next tool to call — a `Toolkit.tool` the catalogue lists —
 * together with at least one argument (`name=` or an `{{inputs.…}}`
 * placeholder), or say `Do not retry` so the model stops rather than guesses.
 * Anything else is an apology, and the compiler refuses it.
 */
function checkRemediation(
  reason: string,
  catalogue: ReadonlyMap<string, ReadonlySet<string>>,
): string | null {
  if (reason.includes(NO_REMEDIATION)) return null;

  const named = [...reason.matchAll(TOOL_REFERENCE)].filter(([, toolkit, tool]) =>
    catalogue.get(toolkit as string)?.has(tool as string),
  );
  if (named.length === 0) {
    return (
      `a pre denial's reason must tell the model what to do next: name a catalogued ` +
      `remediation tool as "Toolkit.tool" with its arguments, or say "${NO_REMEDIATION}". ` +
      `Got: "${reason}"`
    );
  }
  if (!ARGUMENT_MENTION.test(reason)) {
    return (
      `a pre denial's reason names ${named.map((m) => `"${m[0]}"`).join(", ")} but no ` +
      `arguments for it; mention them as "name=…" or with {{inputs.…}} placeholders`
    );
  }
  return null;
}

/** Returns a description of what is wrong with the condition, or `null`. */
function checkCondition(condition: Condition): string | null {
  const { operator, value } = condition;
  switch (operator) {
    case "exists":
      return value === null || typeof value === "boolean"
        ? null
        : `uses "exists" with a value that is neither omitted nor a boolean`;
    case "exceeds_clearance":
      return value === null ? null : `uses "exceeds_clearance", which takes no value`;
    case "eq":
    case "neq":
      return value === null ? `uses "${operator}" with no value to compare against` : null;
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : `uses "${operator}" with a non-numeric value`;
    case "in":
    case "nin":
      return Array.isArray(value) ? null : `uses "${operator}" with a value that is not an array`;
    case "matches":
      if (typeof value !== "string") return `uses "matches" with a value that is not a string`;
      return safeRegex(value) ? null : `uses "matches" with an invalid regular expression`;
  }
}

function safeRegex(source: string): RegExp | null {
  try {
    // No `g`: a global regex carries `lastIndex` between calls, which would
    // make the engine stateful.
    return new RegExp(source, "u");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Visibility — the /access question
// ---------------------------------------------------------------------------

/**
 * Which of `tools` may `subject` see. One decision per tool, in the order
 * given. A tool is visible unless an `access` rule denies it — or unless the
 * engine must fail closed, in which case every tool is hidden.
 *
 * The hook handler (#12) turns the `deny` decisions into the `/access`
 * response's `deny` map; the translation is theirs so this stays a pure
 * function over our own types.
 */
export function resolveVisibility(
  subject: SubjectOrUnknown,
  tools: readonly ToolRef[],
  policy: CompiledPolicy,
): VisibilityDecision[] {
  return tools.map((tool) => ({
    tool,
    decision: decide({ hook: "access", subject, tool, inputs: {}, policy, grants: [] }),
  }));
}

/** Convenience over `resolveVisibility`: only the tools the subject must not see. */
export function hiddenTools(
  subject: SubjectOrUnknown,
  tools: readonly ToolRef[],
  policy: CompiledPolicy,
): VisibilityDecision[] {
  return resolveVisibility(subject, tools, policy).filter(
    ({ decision }) => decision.effect === "deny",
  );
}

// ---------------------------------------------------------------------------
// Permission — the /pre question
// ---------------------------------------------------------------------------

/**
 * May `subject` call `tool` with exactly these `inputs`. This is the
 * parameter-aware check: rules' conditions are evaluated against the values
 * actually submitted.
 */
export function evaluatePermission(input: PermissionInput): Decision {
  return decide({ hook: "pre", ...input, grants: input.grants ?? [] });
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

type Evaluation = {
  readonly hook: "access" | "pre";
  readonly subject: SubjectOrUnknown;
  readonly tool: ToolRef;
  readonly inputs: Inputs;
  readonly policy: CompiledPolicy;
  readonly grants: readonly Grant[];
};

function decide(ev: Evaluation): Decision {
  const { hook, subject, tool, inputs, policy } = ev;
  const qualified = `${tool.toolkit}.${tool.name}`;

  if (subject === null) {
    return failClosed(
      `DENIED: the control plane has no registered subject for this user, so it cannot ` +
        `determine your authority to call ${qualified}. No tool call can fix this — ` +
        `an administrator must register the identity before any tool can be used.`,
    );
  }

  const served = policy.catalogue.get(tool.toolkit);
  if (!served) {
    return failClosed(
      `DENIED: toolkit "${tool.toolkit}" is not governed by this control plane ` +
        `(governed: ${[...policy.catalogue.keys()].map((t) => `"${t}"`).join(", ")}). ` +
        `This is a configuration error, not something a retry can fix. ${NO_REMEDIATION} ${qualified}; ` +
        `report that the toolkit name in the policy configuration does not match the deployed one.`,
    );
  }
  if (!served.has(tool.name)) {
    return failClosed(
      `DENIED: "${tool.name}" is not a tool the control plane governs in toolkit ` +
        `"${tool.toolkit}" (governed: ${[...served].map((t) => `"${t}"`).join(", ")}). ` +
        `${NO_REMEDIATION} ${qualified}. If you meant one of the governed tools, call that one instead.`,
    );
  }

  for (const rule of policy.rules) {
    if (rule.hook !== hook) continue;
    if (!matchesTool(rule.match, tool)) continue;
    if (!matchesSubject(rule, subject)) continue;

    const outcome = evaluateConditions(rule, subject, inputs);

    if (outcome.kind === "unevaluable") {
      return {
        effect: "deny",
        reason: outcome.reason(qualified),
        rule_id: rule.id,
      };
    }
    if (outcome.kind === "no-match") continue;

    if (rule.effect === "deny" && hook === "pre") {
      const grant = ev.grants.find((g) => grantApplies(g, subject, tool));
      if (grant) {
        return {
          effect: "allow",
          reason: `Covered by an active grant (${grant.id}).`,
          rule_id: rule.id,
        };
      }
    }

    return {
      effect: rule.effect,
      reason: renderReason(rule.reason, { subject, tool, inputs }),
      rule_id: rule.id,
    };
  }

  return { effect: "allow", reason: "No rule matched.", rule_id: null };
}

function failClosed(reason: string): Decision {
  return { effect: "deny", reason, rule_id: null };
}

function matchesTool(match: ToolMatcher, tool: ToolRef): boolean {
  const { toolkit, tool: name } = match;
  return (
    (toolkit === WILDCARD || toolkit === tool.toolkit) &&
    (name === WILDCARD || name === tool.name)
  );
}

function matchesSubject(rule: CompiledRule, subject: Subject): boolean {
  const m = rule.subjects;
  if (m === null) return true;
  if (m.user_ids !== null && !m.user_ids.includes(subject.user_id)) return false;
  if (m.roles !== null && !m.roles.includes(subject.role)) return false;
  if (m.clearance_below !== null && !(subject.clearance < m.clearance_below)) return false;
  if (m.clearance_at_least !== null && !(subject.clearance >= m.clearance_at_least)) {
    return false;
  }
  return true;
}

function grantApplies(grant: Grant, subject: Subject, tool: ToolRef): boolean {
  return grant.subject_id === subject.user_id && matchesTool(grant.match, tool);
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

type ConditionOutcome =
  | { kind: "match" }
  | { kind: "no-match" }
  | { kind: "unevaluable"; reason: (qualifiedTool: string) => string };

/** All conditions must hold. An empty list always holds. */
function evaluateConditions(
  rule: CompiledRule,
  subject: Subject,
  inputs: Inputs,
): ConditionOutcome {
  for (const condition of rule.conditions) {
    const outcome = evaluateCondition(condition, subject, inputs);
    if (outcome.kind !== "match") return outcome;
  }
  return { kind: "match" };
}

function evaluateCondition(
  condition: CompiledCondition,
  subject: Subject,
  inputs: Inputs,
): ConditionOutcome {
  const { input, operator, value } = condition;
  const actual = readPath(inputs, input);
  const present = actual !== undefined && actual !== null;

  if (operator === "exists") {
    const wantPresent = value !== false;
    return present === wantPresent ? MATCH : NO_MATCH;
  }

  if (!present) {
    return {
      kind: "unevaluable",
      reason: (tool) =>
        `DENIED: ${tool} requires the input "${input}" and it was not provided. ` +
        `Retry ${tool} with "${input}" set.`,
    };
  }

  switch (operator) {
    case "eq":
      return deepEqual(actual, value) ? MATCH : NO_MATCH;
    case "neq":
      return deepEqual(actual, value) ? NO_MATCH : MATCH;
    case "in":
      return (value as unknown[]).some((v) => deepEqual(actual, v)) ? MATCH : NO_MATCH;
    case "nin":
      return (value as unknown[]).some((v) => deepEqual(actual, v)) ? NO_MATCH : MATCH;
    case "matches": {
      if (typeof actual !== "string") return malformed(input, "a string", actual);
      return (condition.regex as RegExp).test(actual) ? MATCH : NO_MATCH;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "exceeds_clearance": {
      if (typeof actual !== "number" || !Number.isFinite(actual)) {
        return malformed(input, "a number", actual);
      }
      const bound = operator === "exceeds_clearance" ? subject.clearance : (value as number);
      return compare(operator, actual, bound) ? MATCH : NO_MATCH;
    }
  }
}

const MATCH: ConditionOutcome = { kind: "match" };
const NO_MATCH: ConditionOutcome = { kind: "no-match" };

function malformed(input: string, expected: string, actual: unknown): ConditionOutcome {
  return {
    kind: "unevaluable",
    reason: (tool) =>
      `DENIED: the input "${input}" for ${tool} must be ${expected}, but ` +
      `${describe(actual)} was received. Retry ${tool} with "${input}" as ${expected}.`,
  };
}

function compare(
  operator: "gt" | "gte" | "lt" | "lte" | "exceeds_clearance",
  actual: number,
  bound: number,
): boolean {
  switch (operator) {
    case "gt":
    case "exceeds_clearance":
      return actual > bound;
    case "gte":
      return actual >= bound;
    case "lt":
      return actual < bound;
    case "lte":
      return actual <= bound;
  }
}

/** `a.b.c` into a nested record. `undefined` when any segment is missing. */
function readPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** A short, quoted rendering of a value for a denial reason. */
function describe(value: unknown): string {
  if (typeof value === "string") return `the string "${value}"`;
  if (typeof value === "number") return `the number ${String(value)}`;
  if (typeof value === "boolean") return `the boolean ${String(value)}`;
  if (Array.isArray(value)) return "an array";
  return "an object";
}

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

/**
 * Fills `{{inputs.x}}`, `{{subject.x}}` and `{{tool.toolkit}}` / `{{tool.name}}`
 * placeholders in a rule's `reason`, so a seed rule can say
 * `"{{inputs.amount}} exceeds your {{subject.clearance}} limit"` and the
 * model reads the numbers from its own call. A placeholder whose value is
 * absent renders as `(not provided)` rather than vanishing.
 */
export function renderReason(
  template: string,
  context: { subject: Subject; tool: ToolRef; inputs: Inputs },
): string {
  return template.replace(PLACEHOLDER, (_whole, path: string) => {
    const value = readPath(context, path);
    if (value === undefined || value === null) return "(not provided)";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}
