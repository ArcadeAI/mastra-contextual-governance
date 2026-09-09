/**
 * The audit log: one row per decision, appended and never touched again.
 *
 * Rows are `GovernanceEvent`s — the same shape the control-plane panel renders
 * (#21), so the panel shows the audit log rather than a prettier parallel
 * story. Every write is parsed through the strict schema first; a row that
 * would not read back is not written.
 *
 * `record` is synchronous and inside the hook's request path on purpose. A
 * decision that was made but not recorded is the one thing a compliance
 * reviewer cannot recover from later, so the write happens before the response
 * leaves — and if it fails, the caller fails closed (see `index.ts`).
 *
 * The table cannot claim completeness, and this module does not either: a
 * persona refused upstream by Arcade's own auth requirements never reaches a
 * hook and leaves no row here. See the `audit_log` DDL in `policy-store.ts`.
 */
import type { Database } from "bun:sqlite";

import { GovernanceEvent } from "@cg/policy-schema";

/** The columns as they come back from SQLite. */
interface AuditRow {
  id: string;
  ts: string;
  execution_id: string;
  hook: string;
  user_id: string;
  tool: string;
  decision: string;
  reason: string;
  rule_id: string | null;
  before: string | null;
  after: string | null;
}

/**
 * Event ids double as the correlation token embedded in a denial's
 * `error_message` (#6), so they are short enough to sit in text a model reads
 * and random enough that two denials in the same second do not collide:
 * `evt_` and 10 base32 characters, ~50 bits.
 */
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford, no i/l/o/u

export function newEventId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = "evt_";
  for (const byte of bytes) out += ID_ALPHABET[byte % 32];
  return out;
}

/**
 * Appends `events` in one transaction. Either all of them land or none do,
 * which is what lets a single `/access` call — which decides for many tools
 * at once — be reconstructed as a unit.
 */
export function record(db: Database, events: readonly GovernanceEvent[]): void {
  if (events.length === 0) return;

  const insert = db.prepare(
    `INSERT INTO audit_log
       (id, ts, execution_id, hook, user_id, tool, decision, reason, rule_id, before, after)
     VALUES
       ($id, $ts, $execution_id, $hook, $user_id, $tool, $decision, $reason, $rule_id, $before, $after)`,
  );

  try {
    db.transaction(() => {
      for (const raw of events) {
        const event = GovernanceEvent.parse(raw);
        insert.run({
          $id: event.id,
          $ts: event.ts,
          $execution_id: event.execution_id,
          $hook: event.hook,
          $user_id: event.user_id,
          $tool: event.tool,
          $decision: event.decision,
          $reason: event.reason,
          $rule_id: event.rule_id,
          $before: event.before === undefined ? null : JSON.stringify(event.before),
          $after: event.after === undefined ? null : JSON.stringify(event.after),
        });
      }
    })();
  } finally {
    insert.finalize();
  }
}

/** Most recent first. For `/health`, tests and the reset script's sanity check. */
export function recent(db: Database, limit = 50): GovernanceEvent[] {
  return db
    .query<AuditRow, { $limit: number }>(
      "SELECT * FROM audit_log ORDER BY seq DESC LIMIT $limit",
    )
    .all({ $limit: limit })
    .map(fromRow);
}

/** Every row for one Arcade execution, oldest first — `/pre` then `/post`. */
export function byExecution(db: Database, executionId: string): GovernanceEvent[] {
  return db
    .query<AuditRow, { $execution_id: string }>(
      "SELECT * FROM audit_log WHERE execution_id = $execution_id ORDER BY seq ASC",
    )
    .all({ $execution_id: executionId })
    .map(fromRow);
}

export function count(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_log").get()?.n ?? 0;
}

function fromRow(row: AuditRow): GovernanceEvent {
  return GovernanceEvent.parse({
    id: row.id,
    ts: row.ts,
    execution_id: row.execution_id,
    hook: row.hook,
    user_id: row.user_id,
    tool: row.tool,
    decision: row.decision,
    reason: row.reason,
    rule_id: row.rule_id,
    ...(row.before !== null && { before: JSON.parse(row.before) }),
    ...(row.after !== null && { after: JSON.parse(row.after) }),
  });
}
