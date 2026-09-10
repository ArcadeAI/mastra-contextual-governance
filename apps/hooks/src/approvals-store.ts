/**
 * `approval_requests` — the escalations a human acts on.
 *
 * The row is the wire record written out under "The approvals store contract"
 * in `tools/approvals/README.md`, one column per field, plus the control
 * plane's own resolution of the bare `action` name (see `action-binding.ts`).
 * Every record that leaves this module is `parse()`d through
 * `@cg/policy-schema`'s `ApprovalRecord`, so a hand-edited row that no longer
 * conforms fails here rather than rendering as a blank on the approval page.
 *
 * Two things this module deliberately does not do.
 *
 * **It does not authorize.** Answering a read is not permission and recording
 * a decision is not deciding: whether the person clicking may decide is a
 * `/pre` decision on `Approvals.Decide`, made before the decision request is
 * ever sent. The requester can read the DM she sent, so she can reach the read
 * too — which is exactly why the link is safe to put in a conversation.
 *
 * **It does not overwrite a decision.** `recordDecision` writes only while the
 * request is `pending` and reports `already_decided` otherwise. The contract
 * does not specify that case and the pre-hook's "still pending" rule is the
 * control that stops it, but a store that would let `denied` be rewritten to
 * `approved` is a store the audit trail cannot vouch for, and refusing costs
 * one `WHERE` clause.
 */
import type { Database } from "bun:sqlite";

import { ApprovalRecord, type ApprovalStatus } from "@cg/policy-schema";

import type { ActionBinding } from "./action-binding.ts";

/**
 * Ids are minted here and nowhere else. The toolkit does not supply one on
 * purpose: an id the toolkit invented is an id the model could predict, and
 * therefore ask about before anyone had approved it. `apr_` plus 12 Crockford
 * base32 characters, ~60 bits, matching the shape `audit-log.ts` uses.
 */
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function newApprovalId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "apr_";
  for (const byte of bytes) out += ID_ALPHABET[byte % 32];
  return out;
}

/** What `POST /approvals` supplies, after the API layer has resolved it. */
export interface NewApproval {
  requester_id: string;
  requester_display_name: string;
  approver_id: string;
  approver_display_name: string;
  candidate_approver_ids: string[];
  action: string;
  resource_id: string;
  amount: number;
  required_clearance: number;
  rule: { id: string; description: string } | null;
  justification: string;
}

/** A stored request: the wire record plus what the control plane resolved. */
export interface StoredApproval {
  record: ApprovalRecord;
  binding: ActionBinding;
}

export interface DecisionInput {
  decision: Extract<ApprovalStatus, "approved" | "denied">;
  note: string | null;
  decided_by: string;
}

export type DecisionOutcome =
  | { outcome: "recorded"; approval: StoredApproval }
  | { outcome: "not_found" }
  | { outcome: "already_decided"; approval: StoredApproval };

interface Row {
  id: string;
  requester_id: string;
  approver_id: string;
  candidate_approver_ids: string;
  action: string;
  resource_id: string;
  amount: number;
  required_clearance: number;
  rule_id: string | null;
  rule_description: string | null;
  justification: string;
  status: string;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  note: string | null;
  match_toolkit: string;
  match_tool: string;
  resource_input: string;
  amount_input: string | null;
  requester_display_name: string;
  approver_display_name: string;
}

const SELECT = "SELECT * FROM approval_requests WHERE id = $id";

export function createApproval(
  db: Database,
  input: NewApproval,
  binding: ActionBinding,
  clock: { now: () => string; newId?: () => string },
): StoredApproval {
  const id = (clock.newId ?? newApprovalId)();
  const created_at = clock.now();

  db.prepare(
    `INSERT INTO approval_requests
       (id, requester_id, requester_display_name, approver_id, approver_display_name,
        candidate_approver_ids, action, resource_id, amount, required_clearance,
        rule_id, rule_description, justification, status, created_at,
        match_toolkit, match_tool, resource_input, amount_input)
     VALUES
       ($id, $requester_id, $requester_display_name, $approver_id, $approver_display_name,
        $candidate_approver_ids, $action, $resource_id, $amount, $required_clearance,
        $rule_id, $rule_description, $justification, 'pending', $created_at,
        $match_toolkit, $match_tool, $resource_input, $amount_input)`,
  ).run({
    $id: id,
    $requester_id: input.requester_id,
    $requester_display_name: input.requester_display_name,
    $approver_id: input.approver_id,
    $approver_display_name: input.approver_display_name,
    $candidate_approver_ids: JSON.stringify(input.candidate_approver_ids),
    $action: input.action,
    $resource_id: input.resource_id,
    $amount: input.amount,
    $required_clearance: input.required_clearance,
    $rule_id: input.rule?.id ?? null,
    $rule_description: input.rule?.description ?? null,
    $justification: input.justification,
    $created_at: created_at,
    $match_toolkit: binding.toolkit,
    $match_tool: binding.tool,
    $resource_input: binding.resourceInput,
    $amount_input: binding.amountInput,
  });

  const stored = readApproval(db, id);
  if (stored === null) throw new Error(`approval ${id} vanished immediately after being written`);
  return stored;
}

export function readApproval(db: Database, id: string): StoredApproval | null {
  const row = db.query<Row, { $id: string }>(SELECT).get({ $id: id });
  return row === null ? null : fromRow(row);
}

export function recordDecision(
  db: Database,
  id: string,
  input: DecisionInput,
  now: () => string,
): DecisionOutcome {
  return db.transaction((): DecisionOutcome => {
    const existing = readApproval(db, id);
    if (existing === null) return { outcome: "not_found" };
    if (existing.record.status !== "pending") {
      return { outcome: "already_decided", approval: existing };
    }

    db.prepare(
      `UPDATE approval_requests
          SET status = $status, note = $note, decided_at = $decided_at, decided_by = $decided_by
        WHERE id = $id AND status = 'pending'`,
    ).run({
      $id: id,
      $status: input.decision,
      $note: input.note,
      $decided_at: now(),
      $decided_by: input.decided_by,
    });

    const updated = readApproval(db, id);
    if (updated === null) throw new Error(`approval ${id} vanished while being decided`);
    return { outcome: "recorded", approval: updated };
  })();
}

/** How many requests are outstanding. For `/health` and the boot log line. */
export function pendingCount(db: Database): number {
  return (
    db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM approval_requests WHERE status = 'pending'",
      )
      .get()?.n ?? 0
  );
}

function fromRow(row: Row): StoredApproval {
  const record = ApprovalRecord.parse({
    id: row.id,
    requester_id: row.requester_id,
    requester_display_name: row.requester_display_name,
    approver_id: row.approver_id,
    approver_display_name: row.approver_display_name,
    candidate_approver_ids: JSON.parse(row.candidate_approver_ids),
    action: row.action,
    resource_id: row.resource_id,
    amount: row.amount,
    required_clearance: row.required_clearance,
    rule:
      row.rule_id === null ? null : { id: row.rule_id, description: row.rule_description ?? "" },
    justification: row.justification,
    status: row.status,
    created_at: row.created_at,
    decided_at: row.decided_at,
    decided_by: row.decided_by,
    note: row.note,
  });

  return {
    record,
    binding: {
      toolkit: row.match_toolkit,
      tool: row.match_tool,
      resourceInput: row.resource_input,
      amountInput: row.amount_input,
    },
  };
}
