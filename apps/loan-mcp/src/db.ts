/**
 * `loans.db` — the loan book. Plain domain persistence: a `loans` table and an
 * append-only `loan_decisions` table.
 *
 * Nothing here inspects who is asking or what they are allowed to do. Every
 * read returns whatever the row holds and every write is applied as given.
 * That is deliberate: this is the system being governed, and the controls live
 * in `apps/hooks`, which this service cannot reach or influence.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import fixture from "./fixtures/loans.json" with { type: "json" };

export type LoanStatus = "pending" | "approved" | "denied";

/** One entry in a loan's decision history. Append-only — see `recordDecision`. */
export interface LoanDecision {
  decision: "approved" | "denied";
  /** Dollars, present on approvals only. */
  amount: number | null;
  reason: string | null;
  decided_at: string;
}

/** What `search_loans` returns per hit: the list-view columns. */
export interface LoanSummary {
  loan_id: string;
  borrower_name: string;
  amount: number;
  status: LoanStatus;
  purpose: string;
  submitted_at: string;
}

/**
 * What `get_loan` returns: the whole record.
 *
 * `bank_account_number`, `tax_id` and `underwriter_notes` are in here on
 * purpose. A loan origination system's detail view holds them, so ours does
 * too — a service that withheld them would be doing the control plane's job
 * and there would be nothing left to demonstrate.
 */
export interface LoanRecord extends LoanSummary {
  credit_score: number;
  annual_revenue: number;
  years_in_business: number;
  bank_account_number: string;
  tax_id: string;
  underwriter_notes: string;
  decisions: LoanDecision[];
}

const decisionFixtureSchema = z.object({
  decision: z.enum(["approved", "denied"]),
  amount: z.number().nullable(),
  reason: z.string().nullable(),
  decided_at: z.string(),
});

const loanFixtureSchema = z.object({
  loan_id: z.string(),
  borrower_name: z.string(),
  amount: z.number(),
  status: z.enum(["pending", "approved", "denied"]),
  purpose: z.string(),
  submitted_at: z.string(),
  credit_score: z.number(),
  annual_revenue: z.number(),
  years_in_business: z.number(),
  bank_account_number: z.string(),
  tax_id: z.string(),
  underwriter_notes: z.string(),
  decisions: z.array(decisionFixtureSchema),
});

// The fixture is hand-edited — by us now and by forkers later — so it is
// parsed rather than trusted. A typo should fail at boot with a field path,
// not surface as a loan that quietly has no borrower.
const fixtureSchema = z.object({ loans: z.array(loanFixtureSchema).min(1) });

const SCHEMA = `
  CREATE TABLE loans (
    loan_id             TEXT    PRIMARY KEY,
    borrower_name       TEXT    NOT NULL,
    amount              INTEGER NOT NULL,
    status              TEXT    NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
    purpose             TEXT    NOT NULL,
    submitted_at        TEXT    NOT NULL,
    credit_score        INTEGER NOT NULL,
    annual_revenue      INTEGER NOT NULL,
    years_in_business   INTEGER NOT NULL,
    bank_account_number TEXT    NOT NULL,
    tax_id              TEXT    NOT NULL,
    underwriter_notes   TEXT    NOT NULL
  );

  -- Append-only. An approval is an event, not a flag, so approving the same
  -- loan twice leaves two rows and shows up in the data instead of collapsing
  -- into an accidental no-op.
  CREATE TABLE loan_decisions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    loan_id    TEXT    NOT NULL REFERENCES loans(loan_id),
    decision   TEXT    NOT NULL CHECK (decision IN ('approved', 'denied')),
    amount     INTEGER,
    reason     TEXT,
    decided_at TEXT    NOT NULL
  );

  CREATE INDEX idx_loan_decisions_loan_id ON loan_decisions(loan_id);
  CREATE INDEX idx_loans_status ON loans(status);
`;

/**
 * Opens the loan book, bootstrapping it from the fixture only when it has no
 * schema.
 *
 * Seed-if-empty rather than seed-on-boot: `loans.db` lives on a Render disk
 * (decided on #29), so approvals made on stage are still there after a
 * restart. Getting back to a clean state is an explicit script (#23), never a
 * side effect of deploying.
 */
export function openLoanBook(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  if (!hasSchema(db)) seed(db);

  return db;
}

function hasSchema(db: Database): boolean {
  const row = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'loans'",
    )
    .get();

  return row !== null;
}

/**
 * `bun:sqlite` matches named parameters on the `$name` form, so a plain
 * `{ loan_id }` binds nothing and every column arrives NULL — which surfaces
 * as a constraint violation on a different column than the one you forgot.
 */
type NamedBindings = Record<string, string | number | boolean | null>;

function bind(row: NamedBindings): NamedBindings {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [`$${key}`, value]));
}

function seed(db: Database): void {
  const { loans } = fixtureSchema.parse(fixture);

  db.exec(SCHEMA);

  const insertLoan = db.prepare<unknown, NamedBindings>(`
    INSERT INTO loans (
      loan_id, borrower_name, amount, status, purpose, submitted_at,
      credit_score, annual_revenue, years_in_business,
      bank_account_number, tax_id, underwriter_notes
    ) VALUES (
      $loan_id, $borrower_name, $amount, $status, $purpose, $submitted_at,
      $credit_score, $annual_revenue, $years_in_business,
      $bank_account_number, $tax_id, $underwriter_notes
    )
  `);

  const insertDecision = db.prepare<unknown, NamedBindings>(`
    INSERT INTO loan_decisions (loan_id, decision, amount, reason, decided_at)
    VALUES ($loan_id, $decision, $amount, $reason, $decided_at)
  `);

  db.transaction(() => {
    for (const loan of loans) {
      const { decisions, ...columns } = loan;
      insertLoan.run(bind(columns));

      for (const decision of decisions) {
        insertDecision.run(bind({ loan_id: loan.loan_id, ...decision }));
      }
    }
  })();
}

export function searchLoans(
  db: Database,
  filters: { status?: LoanStatus; min_amount?: number; max_amount?: number },
): LoanSummary[] {
  // Every filter is optional, so each clause is skipped with `IS NULL` on its
  // own parameter rather than by concatenating SQL.
  return db
    .query<LoanSummary, { $status: string | null; $min: number | null; $max: number | null }>(
      `SELECT loan_id, borrower_name, amount, status, purpose, submitted_at
         FROM loans
        WHERE ($status IS NULL OR status = $status)
          AND ($min    IS NULL OR amount >= $min)
          AND ($max    IS NULL OR amount <= $max)
        ORDER BY submitted_at DESC, loan_id DESC`,
    )
    .all({
      $status: filters.status ?? null,
      $min: filters.min_amount ?? null,
      $max: filters.max_amount ?? null,
    });
}

export function getLoan(db: Database, loanId: string): LoanRecord | null {
  const loan = db
    .query<Omit<LoanRecord, "decisions">, { $loan_id: string }>(
      "SELECT * FROM loans WHERE loan_id = $loan_id",
    )
    .get({ $loan_id: loanId });

  if (loan === null) return null;

  const decisions = db
    .query<LoanDecision, { $loan_id: string }>(
      `SELECT decision, amount, reason, decided_at
         FROM loan_decisions
        WHERE loan_id = $loan_id
        ORDER BY id ASC`,
    )
    .all({ $loan_id: loanId });

  return { ...loan, decisions };
}

/**
 * Appends a decision and moves the loan's status to match.
 *
 * Returns the updated record, or `null` if no such loan exists. Applies the
 * decision exactly as asked: any question of whether the caller should have
 * been able to make it was settled — or not — before the call reached here.
 */
export function recordDecision(
  db: Database,
  input: {
    loan_id: string;
    decision: "approved" | "denied";
    amount: number | null;
    reason: string | null;
  },
): LoanRecord | null {
  const decided_at = new Date().toISOString();

  const applied = db.transaction(() => {
    const exists = db
      .query<{ loan_id: string }, { $loan_id: string }>(
        "SELECT loan_id FROM loans WHERE loan_id = $loan_id",
      )
      .get({ $loan_id: input.loan_id });

    if (exists === null) return false;

    db.query<unknown, NamedBindings>(
      `INSERT INTO loan_decisions (loan_id, decision, amount, reason, decided_at)
       VALUES ($loan_id, $decision, $amount, $reason, $decided_at)`,
    ).run(bind({ ...input, decided_at }));

    db.query("UPDATE loans SET status = $status WHERE loan_id = $loan_id").run({
      $status: input.decision,
      $loan_id: input.loan_id,
    });

    return true;
  })();

  return applied ? getLoan(db, input.loan_id) : null;
}

export function countLoans(db: Database): number {
  const row = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM loans").get();
  return row?.n ?? 0;
}
