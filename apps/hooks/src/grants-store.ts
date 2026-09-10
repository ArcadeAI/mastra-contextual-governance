/**
 * `grants` — the narrow, expiring permissions an approval produces.
 *
 * Rows in `@cg/policy-schema`'s `Grant` shape, written by the `/pre` handler
 * when it allows an `Approvals.Decide` that approves, and read by the same
 * handler on the retry. This module is storage only: it holds no opinion about
 * whether a grant authorises anything, because that question belongs to
 * `GrantChecker` (#10) and asking it twice, in two places, is how the two
 * answers start to differ.
 *
 * `insertGrant` returns `duplicate_request` rather than throwing on the unique
 * index over `request_id`. One approval issues one grant, enforced by the
 * database: issuing the grant and flipping the request to `approved` are two
 * writes, and a `Decide` replayed between them would otherwise mint a second
 * grant for the same approval — each single use, two uses in total.
 */
import type { Database } from "bun:sqlite";

import { Grant } from "@cg/policy-schema";

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function newGrantId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "grn_";
  for (const byte of bytes) out += ID_ALPHABET[byte % 32];
  return out;
}

interface Row {
  id: string;
  subject_id: string;
  granted_by: string;
  request_id: string;
  toolkit: string;
  tool: string;
  resource_id: string | null;
  pinned_inputs: string;
  ceiling: string | null;
  issued_at: string;
  expires_at: string;
  uses_remaining: number | null;
  revoked_at: string | null;
}

export type InsertOutcome = "inserted" | "duplicate_request";

export function insertGrant(db: Database, grant: Grant): InsertOutcome {
  const parsed = Grant.parse(grant);
  try {
    db.prepare(
      `INSERT INTO grants
         (id, subject_id, granted_by, request_id, toolkit, tool, resource_id,
          pinned_inputs, ceiling, issued_at, expires_at, uses_remaining, revoked_at)
       VALUES
         ($id, $subject_id, $granted_by, $request_id, $toolkit, $tool, $resource_id,
          $pinned_inputs, $ceiling, $issued_at, $expires_at, $uses_remaining, $revoked_at)`,
    ).run({
      $id: parsed.id,
      $subject_id: parsed.subject_id,
      $granted_by: parsed.granted_by,
      $request_id: parsed.request_id,
      $toolkit: parsed.match.toolkit,
      $tool: parsed.match.tool,
      $resource_id: parsed.resource_id,
      $pinned_inputs: JSON.stringify(parsed.pinned_inputs),
      $ceiling: parsed.ceiling === null ? null : JSON.stringify(parsed.ceiling),
      $issued_at: parsed.issued_at,
      $expires_at: parsed.expires_at,
      $uses_remaining: parsed.uses_remaining,
      $revoked_at: parsed.revoked_at,
    });
    return "inserted";
  } catch (cause) {
    if (isUniqueViolation(cause)) return "duplicate_request";
    throw cause;
  }
}

/**
 * Every grant this subject holds for this tool, however stale. Filtering is
 * `GrantChecker`'s job and it reports each rejection, which is what lets the
 * audit log show that an expired grant was present and ignored rather than
 * that nothing was there.
 */
export function grantsFor(
  db: Database,
  subjectId: string,
  tool: { toolkit: string; name: string },
): Grant[] {
  return db
    .query<Row, { $subject_id: string; $toolkit: string; $tool: string }>(
      `SELECT * FROM grants
        WHERE subject_id = $subject_id AND toolkit = $toolkit AND tool = $tool
        ORDER BY issued_at ASC, id ASC`,
    )
    .all({ $subject_id: subjectId, $toolkit: tool.toolkit, $tool: tool.name })
    .map(fromRow);
}

export function grantForRequest(db: Database, requestId: string): Grant | null {
  const row = db
    .query<Row, { $request_id: string }>("SELECT * FROM grants WHERE request_id = $request_id")
    .get({ $request_id: requestId });
  return row === null ? null : fromRow(row);
}

/**
 * Write back a grant `consumeGrant` has spent. Single use is enforced by the
 * row, not by the returned value, so this is the step that makes it true.
 */
export function persistConsumption(db: Database, grant: Grant): void {
  db.prepare("UPDATE grants SET uses_remaining = $uses WHERE id = $id").run({
    $id: grant.id,
    $uses: grant.uses_remaining,
  });
}

export function allGrants(db: Database): Grant[] {
  return db.query<Row, []>("SELECT * FROM grants ORDER BY issued_at ASC, id ASC").all().map(fromRow);
}

function fromRow(row: Row): Grant {
  return Grant.parse({
    id: row.id,
    subject_id: row.subject_id,
    granted_by: row.granted_by,
    request_id: row.request_id,
    match: { toolkit: row.toolkit, tool: row.tool },
    resource_id: row.resource_id,
    pinned_inputs: JSON.parse(row.pinned_inputs),
    ceiling: row.ceiling === null ? null : JSON.parse(row.ceiling),
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    uses_remaining: row.uses_remaining,
    revoked_at: row.revoked_at,
  });
}

function isUniqueViolation(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.includes("UNIQUE constraint failed");
}
