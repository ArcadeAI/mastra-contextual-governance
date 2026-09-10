/**
 * One decision, as a card.
 *
 * The card answers three questions in the order a presenter narrates them, and
 * each answer is a different *kind* of type so the order survives being seen
 * rather than read:
 *
 * 1. **Which tool call** — largest, first, monospace, because it is an
 *    identifier and identifiers are the only thing monospace is used for here.
 * 2. **What happened** — the decision, in the display face and its own colour,
 *    so it is visibly a different sort of thing from the identifier above it.
 * 3. **Which rule** — a chip in the chrome colour, which is reserved and never
 *    a decision, so it cannot read as a fourth outcome and cannot be confused
 *    with the tool name.
 *
 * Above all three, a quiet line carrying the time at the leading edge and the
 * user at the far end — two identifiers that need to be present and need not
 * compete.
 *
 * Nothing is behind a hover. The panel is watched from across a room by people
 * who cannot reach the trackpad, and half of them are looking at a photograph
 * of it.
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
      <p className="cg-event-meta">
        <time className="cg-event-time" dateTime={event.ts}>
          {timeOf(event.ts)}
        </time>
        <span className="cg-event-user">{event.user_id}</span>
      </p>

      <p className="cg-tool">{event.tool}</p>

      <p className="cg-decision">
        <span className="cg-glyph" aria-hidden="true">
          {decision.glyph}
        </span>
        <span>{decision.label}</span>
      </p>

      {event.rule_id !== null && <p className="cg-rule">{event.rule_id}</p>}

      {event.reason !== "" && <p className="cg-reason">{event.reason}</p>}

      {showDiff && <MaskedDiff before={event.before} after={event.after} />}
    </article>
  );
}
