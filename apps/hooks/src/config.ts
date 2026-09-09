/**
 * Environment, read in one place. Every variable is documented in the repo's
 * `.env.example`.
 *
 * Two of these are load-bearing in a way that fails silently if wrong, so they
 * are read here and nowhere else: the toolkit names. A policy rule keyed on a
 * toolkit Arcade does not actually call `Loan` matches nothing, and a rule that
 * matches nothing is indistinguishable from a rule that permits. The catalogue
 * built from these values is what lets `compilePolicy` refuse such a rule at
 * boot instead of letting the demo run and enforce nothing.
 */

/**
 * The bearer token Arcade presents on every hook call. Refused under
 * NODE_ENV=production — Render prompts for the real one (`sync: false`).
 */
const DEV_SECRET = "cg-hooks-dev-secret-not-for-production";

export interface HooksConfig {
  port: number;
  dbPath: string;
  /** What `Authorization: Bearer …` must carry on `/access`, `/pre` and `/post`. */
  signingSecret: string;
  /** `tool.toolkit` as Arcade files the deployed `tools/loan`. Measured on #35. */
  loanToolkit: string;
  /** `tool.toolkit` for `tools/approvals`. Derived, not observed — confirm on #18. */
  approvalsToolkit: string;
  /**
   * Per-persona email overrides, keyed by the fixture's persona key. Read only
   * when `governance.db` is first seeded: the email is the join key across
   * Arcade `user_id`, the OAuth subject and the loan book's actor, and
   * `apps/idp` reads the same four variables so the two databases cannot
   * disagree about who a persona is.
   */
  personaEmails: Record<string, string>;
  /**
   * Our own budget for answering a hook, well inside Arcade's 5s. A request
   * that runs past it is failed closed and audited as such; the point is to
   * be the one deciding, rather than Arcade timing us out and every tool
   * failing with "policy service could not be reached".
   */
  deadlineMs: number;
}

export function readConfig(env: Record<string, string | undefined> = process.env): HooksConfig {
  const secret = env.ARCADE_HOOK_SIGNING_SECRET?.trim();
  if (!secret && env.NODE_ENV === "production") {
    throw new Error("ARCADE_HOOK_SIGNING_SECRET is required in production");
  }

  const personaEmails: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const match = /^PERSONA_([A-Z0-9_]+)_EMAIL$/.exec(key);
    if (match && value?.trim()) personaEmails[(match[1] as string).toLowerCase()] = value.trim();
  }

  return {
    port: Number(env.PORT ?? 8081),
    dbPath: env.GOVERNANCE_DB_PATH ?? "./governance.db",
    signingSecret: secret || DEV_SECRET,
    loanToolkit: env.ARCADE_LOAN_TOOLKIT?.trim() || "Loan",
    approvalsToolkit: env.ARCADE_APPROVALS_TOOLKIT?.trim() || "Approvals",
    personaEmails,
    deadlineMs: Number(env.HOOK_DEADLINE_MS ?? 2500),
  };
}

export function usingDevSecret(config: HooksConfig): boolean {
  return config.signingSecret === DEV_SECRET;
}
