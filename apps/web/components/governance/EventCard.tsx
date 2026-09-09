/**
 * One decision, as a card.
 *
 * Everything the audience needs is on the face of it. Nothing is behind a
 * hover: the panel is watched from across a room by people who cannot reach
 * the trackpad, and half of them are looking at a photograph of it.
 *
 * Reading order is deliberate and matches how a presenter narrates: *what
 * happened* (the decision, largest and coloured), *to what* (the tool), *to
 * whom* (the user), *because of what* (the rule), *and why* (the reason). The
 * `rule_id` is on every card that has one, not only denials — "which rule
 * allowed this" is the question act 1 turns on.
 */
import type { GovernanceEvent } from "@cg/policy-schema";

import { DECISIONS } from "./decisions.ts";
import { MaskedDiff } from "./MaskedDiff.tsx";

/** `16:04:31` — the wall clock a presenter can point at. UTC, as the event is. */
function timeOf(ts: string): string {
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return "";
  return at.toISOString().slice(11, 19);
}

export function EventCard({
  event,
  correlated = false,
}: {
  event: GovernanceEvent;
  /** This is the decision the chat is currently showing. Outlined, not tinted. */
  correlated?: boolean;
}) {
  const decision = DECISIONS[event.decision];
  const showDiff = event.decision === "modify" || event.before !== undefined;

  return (
    <article
      className="cg-event"
      data-decision={event.decision}
      data-correlated={correlated ? "true" : "false"}
      data-event-id={event.id}
    >
      <div className="cg-decision">
        <span className="cg-glyph" aria-hidden="true">
          {decision.glyph}
        </span>
        <span>{decision.label}</span>
        <time className="cg-time" dateTime={event.ts}>
          {timeOf(event.ts)}
        </time>
      </div>

      <p className="cg-tool">{event.tool}</p>

      {/* The rule gets a line of its own. "Which rule did this" is the question
          the whole panel exists to answer, and it loses that job crammed into a
          run of metadata. */}
      {event.rule_id !== null && <p className="cg-rule">{event.rule_id}</p>}

      <p className="cg-meta">{event.user_id}</p>

      {event.reason !== "" && <p className="cg-reason">{event.reason}</p>}

      {showDiff && <MaskedDiff before={event.before} after={event.after} />}
    </article>
  );
}
