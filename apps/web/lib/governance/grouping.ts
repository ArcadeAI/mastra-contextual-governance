/**
 * Repeated `/access` decisions, collapsed into one row for display.
 *
 * Arcade calls `/access` once per tool-schema resolution, so a single
 * `tools/call` fans out into several access decisions for the same person and
 * the same tool. Measured at the #13 sitting with retry off: one
 * `Loan.GetLoan` call produced **three** access rows and one
 * `Loan.ApproveLoan` produced **two** (#64). The audit log is right — each of
 * those is a real hook call and a real decision — but a lane drawing one card
 * per event shows what an audience reads as duplicates, and the `/pre` denial
 * that act 2 turns on gets pushed down the screen by them.
 *
 * **This is presentation, and only presentation.** Nothing here runs anywhere
 * near `audit_log` or the SSE stream; the raw record stays complete, the
 * timeline still holds every event, and the tallies still count every one of
 * them. A row carrying `×3` is a claim that three decisions were made, not a
 * claim that one was.
 *
 * Three rules, each of which the panel would be wrong without:
 *
 * - **Only adjacent events group.** Reaching past an intervening event to
 *   merge two that match would reorder the lane, and not reordering is the
 *   timeline's first property (`timeline.ts`): a burst shares timestamps to
 *   the millisecond, and a panel that shuffles a deny past the allow after it
 *   tells the room the opposite of what happened.
 * - **The key is `user_id`, `tool` and `decision` together.** Two different
 *   decisions about the same tool are the interesting case, never a duplicate,
 *   and they stay two rows.
 * - **A group spans at most {@link ACCESS_GROUP_WINDOW_MS}**, measured from
 *   its newest member rather than from the previous one. Chaining
 *   neighbour-to-neighbour would let a slow drip of matching decisions, one
 *   every two seconds for a minute, collapse into a single row claiming they
 *   arrived together.
 */
import type { GovernanceEvent, HookPoint } from "@cg/policy-schema";

/**
 * How far apart two access decisions may be and still be one row.
 *
 * A few seconds: the fan-out for one `tools/call` lands inside a few hundred
 * milliseconds, and a person re-running the same call is slower than this.
 * One constant, so "a short window" is a number somebody can change once.
 */
export const ACCESS_GROUP_WINDOW_MS = 3_000;

/**
 * The lanes that group. Only `access` fans out — `/pre` and `/post` are called
 * once per execution, so two adjacent identical rows there are two real
 * attempts and collapsing them would hide the retry that is the whole beat.
 */
export const GROUPED_HOOKS: ReadonlySet<HookPoint> = new Set<HookPoint>(["access"]);

/** One card. Usually one event; sometimes a run of them. */
export interface EventRow {
  /**
   * What the card is drawn from: the newest member, so the freshest card
   * still carries the freshest facts. Always `events[0]` — named separately
   * because a non-empty array is not a thing the type system says here.
   */
  readonly event: GovernanceEvent;
  /** Every member, newest first. Length 1 for an ungrouped row. */
  readonly events: readonly GovernanceEvent[];
}

/** How many decisions this row stands for. */
export function rowCount(row: EventRow): number {
  return row.events.length;
}

/** Milliseconds, or `NaN` for a timestamp that will not parse. */
function instant(event: GovernanceEvent): number {
  return Date.parse(event.ts);
}

/** Same person, same tool, same outcome — the three the issue names. */
function sameSubject(left: GovernanceEvent, right: GovernanceEvent): boolean {
  return (
    left.user_id === right.user_id &&
    left.tool === right.tool &&
    left.decision === right.decision
  );
}

/**
 * `events` — newest first, as a lane holds them — as rows, adjacent matching
 * access decisions collapsed.
 *
 * Every input event comes back out, in the order it went in: flattening the
 * result reproduces `events` exactly. That is the property that makes this
 * grouping rather than de-duplication, and `access-grouping.test.tsx` asserts
 * it directly.
 */
export function groupAccessEvents(
  events: readonly GovernanceEvent[],
  windowMs: number = ACCESS_GROUP_WINDOW_MS,
): EventRow[] {
  const rows: Array<{ event: GovernanceEvent; events: GovernanceEvent[] }> = [];

  for (const event of events) {
    const open = rows[rows.length - 1];
    const joins =
      open !== undefined &&
      sameSubject(open.event, event) &&
      // An unparseable timestamp gives NaN, every comparison against it is
      // false, and the event starts its own row. Refusing to group what we
      // cannot place in time is the safe direction: the worst case is a row
      // the panel could have merged and did not.
      Math.abs(instant(open.event) - instant(event)) <= windowMs;

    if (joins) open.events.push(event);
    else rows.push({ event, events: [event] });
  }

  return rows;
}

/** Each event as its own row, for the lanes that do not group. */
function ungrouped(events: readonly GovernanceEvent[]): EventRow[] {
  return events.map((event) => ({ event, events: [event] }));
}

/**
 * The rows a lane draws. The one place that decides which hook points group,
 * so a lane component never has to.
 */
export function rowsFor(
  hook: HookPoint,
  events: readonly GovernanceEvent[],
  windowMs: number = ACCESS_GROUP_WINDOW_MS,
): EventRow[] {
  return GROUPED_HOOKS.has(hook) ? groupAccessEvents(events, windowMs) : ungrouped(events);
}
