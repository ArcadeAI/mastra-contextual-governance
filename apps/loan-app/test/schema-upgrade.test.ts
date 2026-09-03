/**
 * A `loans.db` from before a column existed must still open, keep its rows,
 * and work — the disk persists across deploys (#29), so every schema change
 * after the first meets a database that predates it.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { getLoan, openLoanBook, recordDecision } from "../src/db.ts";

/** The schema exactly as #30 shipped it: no `decided_by`. */
const SCHEMA_AT_30 = `
  CREATE TABLE loans (
    loan_id TEXT PRIMARY KEY, borrower_name TEXT NOT NULL, amount INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
    purpose TEXT NOT NULL, submitted_at TEXT NOT NULL, credit_score INTEGER NOT NULL,
    annual_revenue INTEGER NOT NULL, years_in_business INTEGER NOT NULL,
    bank_account_number TEXT NOT NULL, tax_id TEXT NOT NULL, underwriter_notes TEXT NOT NULL
  );
  CREATE TABLE loan_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, loan_id TEXT NOT NULL REFERENCES loans(loan_id),
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
    amount INTEGER, reason TEXT, decided_at TEXT NOT NULL
  );
  INSERT INTO loans VALUES ('LN-0030', 'Old Schema Co', 12000, 'approved', 'Legacy',
    '2026-01-01', 700, 100000, 3, '0000000000000000', '00-0000000', 'Predates decided_by.');
  INSERT INTO loan_decisions (loan_id, decision, amount, reason, decided_at)
    VALUES ('LN-0030', 'approved', 12000, NULL, '2026-01-02T00:00:00.000Z');
`;

describe("opening a loans.db written by an earlier schema", () => {
  test("keeps every row, adds the missing column, and writes work", () => {
    const path = join(tmpdir(), `cg-loans-old-${crypto.randomUUID()}`, "loans.db");
    mkdirSync(dirname(path), { recursive: true });
    const legacy = new Database(path, { create: true });
    legacy.exec(SCHEMA_AT_30);
    legacy.close();

    const db = openLoanBook(path);
    try {
      const before = getLoan(db, "LN-0030");
      expect(before?.decisions).toEqual([
        {
          decision: "approved",
          amount: 12000,
          reason: null,
          decided_by: null,
          decided_at: "2026-01-02T00:00:00.000Z",
        },
      ]);

      const after = recordDecision(db, {
        loan_id: "LN-0030",
        decision: "approved",
        amount: 9000,
        reason: null,
        decided_by: "dana@example.test",
      });
      expect(after?.decisions).toHaveLength(2);
      expect(after?.decisions.at(-1)?.decided_by).toBe("dana@example.test");

      // Not reseeded: the fixture's loans are absent, the legacy row is the only one.
      expect(getLoan(db, "LN-2291")).toBeNull();
    } finally {
      db.close();
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  test("is idempotent — a current database opens unchanged", () => {
    const path = join(tmpdir(), `cg-loans-cur-${crypto.randomUUID()}`, "loans.db");
    openLoanBook(path).close();
    const db = openLoanBook(path);
    try {
      expect(getLoan(db, "LN-2291")).not.toBeNull();
    } finally {
      db.close();
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });
});
