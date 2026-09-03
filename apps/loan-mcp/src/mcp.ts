/**
 * The MCP surface of the loan book: four tools over Streamable HTTP.
 *
 * Every tool does exactly what it says and nothing else. There is no check on
 * who is calling, no field withheld, nothing consulted before a write is
 * applied. `apps/hooks` decides what is permitted, from outside this process,
 * on a path this service cannot see or influence.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Database } from "bun:sqlite";
import { z } from "zod";

import { getLoan, recordDecision, searchLoans } from "./db.ts";

/**
 * Arcade derives the toolkit name from what this server reports here — not
 * from the ID it is registered under in the dashboard. It lowercases the name,
 * strips every `mcp` and `server` **substring**, then PascalCases what is
 * left, so `loan-mcp` would collapse to `Loan`. `loan-app` survives intact.
 * Measured in docs/spikes/02-remote-mcp-hooks.md; confirm the real value off a
 * `/pre` payload on #13 before any rule is keyed on it.
 *
 * Changing this string renames every tool's fully-qualified name and silently
 * invalidates rules keyed on the old one.
 */
export const SERVER_INFO = { name: "loan-app", version: "1.0.0" } as const;

/** JSON, pretty-printed, as one text block. */
function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function noSuchLoan(loanId: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `No loan application found with ID ${loanId}.` }],
  };
}

const loanIdArg = z
  .string()
  .describe("The loan application ID, in the form LN-0000 — for example LN-2291.");

/**
 * Builds a server instance. One per request: the HTTP transport runs
 * stateless, so nothing is carried between calls except the database itself.
 */
export function createLoanServer(db: Database): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Loan origination system for a commercial bank. Loan applications are identified " +
      "by IDs of the form LN-0000. Use search_loans to find applications, get_loan to " +
      "read one in full, and approve_loan or deny_loan to record a decision on one.",
  });

  server.registerTool(
    "search_loans",
    {
      title: "Search loan applications",
      description:
        "Find loan applications in the loan book, newest submission first. Use this " +
        "when you do not already have a loan ID: to list what is awaiting a decision, " +
        "or to find applications within a dollar range. All filters are optional and " +
        "combine; with none supplied this returns every application on file. Each hit " +
        "carries the list-view fields only — ID, borrower, amount, status, purpose and " +
        "submission date. To read a borrower's financials, the underwriter's notes or " +
        "the decisions already recorded, call get_loan with an ID from these results.",
      inputSchema: {
        status: z
          .enum(["pending", "approved", "denied"])
          .optional()
          .describe(
            "Return only applications in this state. 'pending' means no decision has " +
              "been recorded yet.",
          ),
        min_amount: z
          .number()
          .nonnegative()
          .optional()
          .describe("Return only applications requesting at least this many US dollars."),
        max_amount: z
          .number()
          .nonnegative()
          .optional()
          .describe("Return only applications requesting at most this many US dollars."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ status, min_amount, max_amount }) => {
      const results = searchLoans(db, {
        ...(status !== undefined && { status }),
        ...(min_amount !== undefined && { min_amount }),
        ...(max_amount !== undefined && { max_amount }),
      });

      return json({ count: results.length, loans: results });
    },
  );

  server.registerTool(
    "get_loan",
    {
      title: "Get a loan application in full",
      description:
        "Read one loan application's complete file by ID. Returns everything the loan " +
        "book holds on it: borrower details, the requested amount and purpose, credit " +
        "score, annual revenue and years in business, the underwriter's notes, the " +
        "borrower's bank account number and tax ID, and every approval or denial " +
        "already recorded against it, oldest first. Use this whenever you need more " +
        "than the list-view fields search_loans returns, and always before recording a " +
        "decision on an application.",
      inputSchema: { loan_id: loanIdArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ loan_id }) => {
      const loan = getLoan(db, loan_id);
      return loan === null ? noSuchLoan(loan_id) : json(loan);
    },
  );

  server.registerTool(
    "approve_loan",
    {
      title: "Approve a loan application",
      description:
        "Approve a loan application for a given dollar amount, committing the decision " +
        "to the loan book: the approval is appended to the application's decision " +
        "history and its status becomes 'approved'. Use this only to actually extend " +
        "credit — it is a write against the bank's system of record, not a " +
        "recommendation or a draft, and there is no undo. Returns the application as it " +
        "stands after the approval.",
      inputSchema: {
        loan_id: loanIdArg,
        amount: z
          .number()
          .positive()
          .describe(
            "The amount to approve, in US dollars. Need not equal the amount requested " +
              "— an application may be approved for less.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ loan_id, amount }) => {
      const loan = recordDecision(db, {
        loan_id,
        decision: "approved",
        amount,
        reason: null,
      });

      return loan === null ? noSuchLoan(loan_id) : json(loan);
    },
  );

  server.registerTool(
    "deny_loan",
    {
      title: "Deny a loan application",
      description:
        "Decline a loan application with a stated reason, committing the decision to " +
        "the loan book: the denial is appended to the application's decision history " +
        "and its status becomes 'denied'. Use this only to actually decline the " +
        "application — it is a write against the bank's system of record, and there is " +
        "no undo. Returns the application as it stands after the denial.",
      inputSchema: {
        loan_id: loanIdArg,
        reason: z
          .string()
          .min(1)
          .describe(
            "Why the application is being declined. Recorded verbatim in the decision " +
              "history and read by auditors, so write it for a human.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ loan_id, reason }) => {
      const loan = recordDecision(db, {
        loan_id,
        decision: "denied",
        amount: null,
        reason,
      });

      return loan === null ? noSuchLoan(loan_id) : json(loan);
    },
  );

  return server;
}
