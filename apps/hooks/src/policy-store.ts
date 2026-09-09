/**
 * `governance.db` — who may do what, and what happened.
 *
 * Five tables a presenter can read at a glance, because one of them gets
 * edited live on stage:
 *
 *   subjects        the cast: user_id (email), display_name, role, clearance
 *   catalogue       every governed tool and the arguments a call must supply
 *   policy_rules    /access and /pre rules — one row each, JSON only where the
 *                   schema is genuinely nested (subjects, conditions)
 *   output_rules    /post redaction rules; stored now, evaluated from #16
 *   grants          narrow permissions produced by approvals; written from #10/#19
 *   audit_log       append-only, one row per decision — see `audit-log.ts`
 *
 * Plus `policy_revision`, a single integer that triggers bump on every write to
 * `subjects`, `catalogue` or `policy_rules`. That number is how the in-memory
 * policy cache (`policy-cache.ts`) notices an edit from *any* connection —
 * this process, a `sqlite3` shell on the Render disk, the rule editor — without
 * re-reading the tables on every hook call.
 *
 * Seed-if-empty, not seed-on-boot (decided on #29): the database sits on a
 * Render disk, so a clearance raised on stage in act 1 is still raised in act 3
 * and after a restart. Bootstrapping happens only when there is no schema, and
 * resetting is an explicit script (#23), never a side effect of deploying.
 *
 * Every row that leaves this module is `parse()`d through `@cg/policy-schema`
 * on the way out. Those schemas are `.strict()`, so a hand-edited row with a
 * misspelled field fails loudly here rather than evaluating as a rule narrower
 * or wider than the one someone thought they wrote.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import type { ToolCatalogue } from "@cg/governance-core";
import {
  OutputRule,
  PolicyRule,
  Subject,
  type OutputRuleInput,
  type PolicyRuleInput,
  type SubjectInput,
} from "@cg/policy-schema";

import fixture from "./fixtures/governance.json" with { type: "json" };

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

/** Placeholders the fixture uses for the two configured toolkit names. */
const TOOLKIT_PLACEHOLDERS = { $LOAN: "loanToolkit", $APPROVALS: "approvalsToolkit" } as const;

export interface SeedOptions {
  loanToolkit: string;
  approvalsToolkit: string;
  /** Persona key → email, from `PERSONA_<KEY>_EMAIL`. Missing keys keep the fixture's address. */
  personaEmails: Record<string, string>;
}

const seedSubjectSchema = z
  .object({
    persona: z.string().min(1),
    user_id: z.string().email(),
    display_name: z.string().min(1),
    role: z.string().min(1),
    clearance: z.number().nonnegative(),
  })
  .strict();

// Hand-edited, so parsed rather than trusted: a typo fails at first boot with
// a field path instead of surfacing as a persona with no authority. The rules
// themselves are parsed through the strict domain schemas below, after the
// toolkit placeholders are filled in.
const fixtureSchema = z
  .object({
    "//": z.array(z.string()).optional(),
    catalogue: z.record(z.record(z.array(z.string()))),
    subjects: z.array(seedSubjectSchema).min(1),
    policy_rules: z.array(z.unknown()),
    output_rules: z.array(z.unknown()),
  })
  .strict();

export interface Seed {
  catalogue: ToolCatalogue;
  subjects: Subject[];
  policy_rules: PolicyRule[];
  output_rules: OutputRule[];
}

/**
 * The fixture with the configured toolkit names and persona emails substituted
 * in, parsed through the strict schemas. Pure; exported so a test can check the
 * seed compiles before anything touches a database.
 */
export function loadSeed(options: SeedOptions, raw: unknown = fixture): Seed {
  const parsed = fixtureSchema.parse(raw);

  const substitute = (text: string): string =>
    Object.entries(TOOLKIT_PLACEHOLDERS).reduce(
      (acc, [placeholder, key]) => acc.split(placeholder).join(options[key]),
      text,
    );
  const substituteDeep = (value: unknown): unknown => {
    if (typeof value === "string") return substitute(value);
    if (Array.isArray(value)) return value.map(substituteDeep);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [substitute(k), substituteDeep(v)]),
      );
    }
    return value;
  };

  const subjects = parsed.subjects.map(({ persona, ...subject }) => {
    const override = options.personaEmails[persona.toLowerCase()];
    const input: SubjectInput = { ...subject, user_id: override ?? subject.user_id };
    return Subject.parse(input);
  });

  return {
    catalogue: substituteDeep(parsed.catalogue) as ToolCatalogue,
    subjects,
    policy_rules: parsed.policy_rules.map((rule) => PolicyRule.parse(substituteDeep(rule))),
    output_rules: parsed.output_rules.map((rule) => OutputRule.parse(substituteDeep(rule))),
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
  -- The cast. clearance is the unit-free ceiling exceeds_clearance compares
  -- against; here it counts US dollars. Raise Dana's on stage and rerun.
  CREATE TABLE subjects (
    user_id      TEXT    PRIMARY KEY,
    display_name TEXT    NOT NULL,
    role         TEXT    NOT NULL,
    clearance    REAL    NOT NULL CHECK (clearance >= 0),
    attributes   TEXT    NOT NULL DEFAULT '{}'
  );

  -- Every governed tool. arguments is a JSON array of names; a trailing '?'
  -- marks one optional. A tool not listed here is denied at every hook.
  CREATE TABLE catalogue (
    toolkit   TEXT NOT NULL,
    tool      TEXT NOT NULL,
    arguments TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (toolkit, tool)
  );

  -- /access and /pre rules. Lower priority evaluates first; first match wins.
  -- Set enabled = 0 to switch a rule off without losing it.
  CREATE TABLE policy_rules (
    id          TEXT    PRIMARY KEY,
    description TEXT    NOT NULL DEFAULT '',
    hook        TEXT    NOT NULL CHECK (hook IN ('access', 'pre')),
    toolkit     TEXT    NOT NULL,
    tool        TEXT    NOT NULL,
    subjects    TEXT,
    conditions  TEXT    NOT NULL DEFAULT '[]',
    effect      TEXT    NOT NULL CHECK (effect IN ('allow', 'deny')),
    reason      TEXT    NOT NULL,
    priority    INTEGER NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
  );

  -- /post rules. Held here from the start so the whole policy is in one place;
  -- the RedactionEngine reads them from #16.
  CREATE TABLE output_rules (
    id          TEXT    PRIMARY KEY,
    description TEXT    NOT NULL DEFAULT '',
    toolkit     TEXT    NOT NULL,
    tool        TEXT    NOT NULL,
    subjects    TEXT,
    fields      TEXT    NOT NULL DEFAULT '[]',
    patterns    TEXT    NOT NULL DEFAULT '[]',
    reason      TEXT    NOT NULL,
    priority    INTEGER NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
  );

  -- Grants: one row per approval outcome, in the shape @cg/policy-schema's
  -- Grant describes. Written by the approval flow (#10, #19); read at /pre.
  CREATE TABLE grants (
    id             TEXT PRIMARY KEY,
    subject_id     TEXT NOT NULL,
    granted_by     TEXT NOT NULL,
    request_id     TEXT NOT NULL,
    toolkit        TEXT NOT NULL,
    tool           TEXT NOT NULL,
    resource_id    TEXT,
    pinned_inputs  TEXT NOT NULL DEFAULT '{}',
    ceiling        TEXT,
    issued_at      TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    uses_remaining INTEGER,
    revoked_at     TEXT
  );
  CREATE INDEX idx_grants_subject_tool ON grants(subject_id, toolkit, tool);

  -- One row per decision the control plane made, in GovernanceEvent's shape.
  --
  -- NOT a complete record of every refusal a persona met. Arcade evaluates a
  -- tool's auth requirements before /pre fires: a persona without a token for
  -- the tool is refused upstream of every hook, and that refusal writes no row
  -- here (measured, spike #2; DESIGN.md open risk 2). What this table holds is
  -- every decision *this service* made, including its own failures.
  CREATE TABLE audit_log (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    id           TEXT    NOT NULL UNIQUE,
    ts           TEXT    NOT NULL,
    execution_id TEXT    NOT NULL DEFAULT '',
    hook         TEXT    NOT NULL CHECK (hook IN ('access', 'pre', 'post')),
    user_id      TEXT    NOT NULL,
    tool         TEXT    NOT NULL,
    decision     TEXT    NOT NULL CHECK (decision IN ('allow', 'deny', 'modify')),
    reason       TEXT    NOT NULL,
    rule_id      TEXT,
    before       TEXT,
    after        TEXT
  );
  -- seq already orders rows by time, so no index on ts: a whole-project
  -- /access appends ~10k rows in one transaction, and every index is paid
  -- for on each of them.
  CREATE INDEX idx_audit_log_execution ON audit_log(execution_id);

  -- Append-only, enforced by the database rather than by convention. A
  -- compliance reviewer reading this table should not have to trust that
  -- nobody ran an UPDATE.
  CREATE TRIGGER audit_log_is_append_only_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER audit_log_is_append_only_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

  -- Bumped on every write to the tables the in-memory policy cache is built
  -- from, so an edit from any connection is noticed on the next hook call.
  CREATE TABLE policy_revision (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL
  );
  INSERT INTO policy_revision (id, revision) VALUES (1, 1);
`;

/** Triggers bumping `policy_revision` for every write to the cached tables. */
const REVISION_TRIGGERS = ["subjects", "catalogue", "policy_rules"]
  .flatMap((table) =>
    ["INSERT", "UPDATE", "DELETE"].map(
      (op) =>
        `CREATE TRIGGER bump_revision_${table}_${op.toLowerCase()} AFTER ${op} ON ${table}
         BEGIN UPDATE policy_revision SET revision = revision + 1 WHERE id = 1; END;`,
    ),
  )
  .join("\n");

// ---------------------------------------------------------------------------
// Opening and seeding
// ---------------------------------------------------------------------------

/**
 * Opens `governance.db`, bootstrapping it from the fixture only when it has
 * no schema.
 */
export function openGovernance(path: string, seedOptions: SeedOptions): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // Another connection (the reset script, a sqlite3 shell) may hold a write
  // lock for a moment; wait rather than fail a hook call over it.
  db.exec("PRAGMA busy_timeout = 1000");

  if (!hasSchema(db)) seed(db, loadSeed(seedOptions));

  return db;
}

export function hasSchema(db: Database): boolean {
  const row = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'policy_rules'",
    )
    .get();
  return row !== null;
}

/**
 * `bun:sqlite` binds named parameters on the `$name` form; a plain `{ id }`
 * binds nothing and every column arrives NULL.
 */
type NamedBindings = Record<string, string | number | null>;

function bind(row: Record<string, unknown>): NamedBindings {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      `$${key}`,
      value === null || value === undefined
        ? null
        : typeof value === "string" || typeof value === "number"
          ? value
          : typeof value === "boolean"
            ? Number(value)
            : JSON.stringify(value),
    ]),
  );
}

/**
 * Creates the schema and inserts the seed rows in **one** transaction.
 *
 * The DDL has to be inside the transaction, not just the inserts. A seed that
 * throws halfway then leaves no tables at all and the next boot retries with a
 * clear error. Creating the tables first and wrapping only the inserts produces
 * the one failure that cannot recover on its own: a schema with no rows, which
 * `hasSchema` reads as already seeded, so every later boot comes up green with
 * nobody in the cast and no rules — permanently, on a disk that persists. Found
 * the hard way in `apps/loan-app`, and copied from there.
 *
 * Exported for the test that holds this line.
 */
export function seed(db: Database, data: Seed): void {
  db.transaction(() => {
    db.exec(SCHEMA);
    db.exec(REVISION_TRIGGERS);

    const insertSubject = db.prepare<unknown, NamedBindings>(
      `INSERT INTO subjects (user_id, display_name, role, clearance, attributes)
       VALUES ($user_id, $display_name, $role, $clearance, $attributes)`,
    );
    const insertCatalogue = db.prepare<unknown, NamedBindings>(
      `INSERT INTO catalogue (toolkit, tool, arguments) VALUES ($toolkit, $tool, $arguments)`,
    );
    const insertRule = db.prepare<unknown, NamedBindings>(
      `INSERT INTO policy_rules
         (id, description, hook, toolkit, tool, subjects, conditions, effect, reason, priority, enabled)
       VALUES
         ($id, $description, $hook, $toolkit, $tool, $subjects, $conditions, $effect, $reason, $priority, $enabled)`,
    );
    const insertOutputRule = db.prepare<unknown, NamedBindings>(
      `INSERT INTO output_rules
         (id, description, toolkit, tool, subjects, fields, patterns, reason, priority, enabled)
       VALUES
         ($id, $description, $toolkit, $tool, $subjects, $fields, $patterns, $reason, $priority, $enabled)`,
    );

    try {
      for (const subject of data.subjects) insertSubject.run(bind(subject));
      for (const [toolkit, tools] of Object.entries(data.catalogue)) {
        for (const [tool, args] of Object.entries(tools)) {
          insertCatalogue.run(bind({ toolkit, tool, arguments: args }));
        }
      }
      for (const { match, ...rule } of data.policy_rules) {
        insertRule.run(bind({ ...rule, toolkit: match.toolkit, tool: match.tool }));
      }
      for (const { match, ...rule } of data.output_rules) {
        insertOutputRule.run(bind({ ...rule, toolkit: match.toolkit, tool: match.tool }));
      }
    } finally {
      insertSubject.finalize();
      insertCatalogue.finalize();
      insertRule.finalize();
      insertOutputRule.finalize();
    }
  })();
}

// ---------------------------------------------------------------------------
// Reading policy
// ---------------------------------------------------------------------------

/** Everything the policy cache is built from, read in one consistent snapshot. */
export interface PolicySnapshot {
  revision: number;
  catalogue: ToolCatalogue;
  subjects: Subject[];
  rules: PolicyRule[];
}

/** The one integer the cache polls. Microseconds; one indexed row. */
export function readRevision(db: Database): number {
  const row = db
    .query<{ revision: number }, []>("SELECT revision FROM policy_revision WHERE id = 1")
    .get();
  if (row === null) throw new Error("governance.db has no policy_revision row");
  return row.revision;
}

interface SubjectRow {
  user_id: string;
  display_name: string;
  role: string;
  clearance: number;
  attributes: string;
}

interface CatalogueRow {
  toolkit: string;
  tool: string;
  arguments: string;
}

interface RuleRow {
  id: string;
  description: string;
  hook: string;
  toolkit: string;
  tool: string;
  subjects: string | null;
  conditions: string;
  effect: string;
  reason: string;
  priority: number;
  enabled: number;
}

/**
 * Reads subjects, catalogue and rules inside one read transaction, so the
 * revision reported is the one the rows belong to. Every row is parsed through
 * the strict schema on the way out — a hand-edited row that no longer conforms
 * throws here, and the cache treats that as fail-closed rather than serving the
 * rule someone thought they wrote.
 */
export function readPolicy(db: Database): PolicySnapshot {
  return db.transaction(() => {
    const revision = readRevision(db);

    const subjects = db
      .query<SubjectRow, []>("SELECT * FROM subjects ORDER BY user_id")
      .all()
      .map((row) => Subject.parse({ ...row, attributes: JSON.parse(row.attributes) }));

    const catalogue: Record<string, Record<string, string[]>> = {};
    for (const row of db
      .query<CatalogueRow, []>("SELECT * FROM catalogue ORDER BY toolkit, tool")
      .all()) {
      (catalogue[row.toolkit] ??= {})[row.tool] = z.array(z.string()).parse(JSON.parse(row.arguments));
    }

    const rules = db
      .query<RuleRow, []>("SELECT * FROM policy_rules ORDER BY priority, id")
      .all()
      .map(({ toolkit, tool, subjects: subjectsJson, conditions, enabled, ...rest }) => {
        const input: PolicyRuleInput = {
          ...rest,
          hook: rest.hook as PolicyRuleInput["hook"],
          effect: rest.effect as PolicyRuleInput["effect"],
          match: { toolkit, tool },
          subjects: subjectsJson === null ? null : JSON.parse(subjectsJson),
          conditions: JSON.parse(conditions),
          enabled: enabled === 1,
        };
        return PolicyRule.parse(input);
      });

    return { revision, catalogue, subjects, rules };
  })();
}

/** Every `/post` rule, parsed. Not cached yet: nothing evaluates them until #16. */
export function readOutputRules(db: Database): OutputRule[] {
  interface Row extends Omit<RuleRow, "hook" | "effect" | "conditions"> {
    fields: string;
    patterns: string;
  }
  return db
    .query<Row, []>("SELECT * FROM output_rules ORDER BY priority, id")
    .all()
    .map(({ toolkit, tool, subjects: subjectsJson, fields, patterns, enabled, ...rest }) => {
      const input: OutputRuleInput = {
        ...rest,
        match: { toolkit, tool },
        subjects: subjectsJson === null ? null : JSON.parse(subjectsJson),
        fields: JSON.parse(fields),
        patterns: JSON.parse(patterns),
        enabled: enabled === 1,
      };
      return OutputRule.parse(input);
    });
}

/** How many rows each table holds — for `/health` and the boot log line. */
export function counts(db: Database): Record<string, number> {
  const count = (table: string): number =>
    db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
  return {
    subjects: count("subjects"),
    catalogue: count("catalogue"),
    policy_rules: count("policy_rules"),
    output_rules: count("output_rules"),
    grants: count("grants"),
    audit_log: count("audit_log"),
  };
}
