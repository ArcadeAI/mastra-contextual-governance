/**
 * One control point's column: its name, what it controls, its own tally, and
 * its events newest-first so the freshest card is always in the same place.
 *
 * The lane header is the largest thing on the panel after the title. The three
 * control points are the structure the audience should find first; a card is a
 * detail inside one of them.
 *
 * The lane draws at most `visible` cards. Everything the timeline holds beyond
 * that, plus everything it has already let go, is *counted and stated* in the
 * header — an audit surface that quietly discards records would argue against
 * the thing this project argues for. It sits in the header rather than under
 * the cards because under them it is the first thing a burst pushes out of a
 * lane that clips its overflow, so the one line saying "there is more than
 * this" would disappear exactly when it became true.
 */
import type { Effect, GovernanceEvent, HookPoint } from "@cg/policy-schema";

import { EventCard } from "./EventCard.tsx";
import { DECISION_ORDER, DECISIONS, LANES } from "./decisions.ts";

export function Lane({
  hook,
  events,
  behind,
  counts,
  visible,
  flashKey,
  correlatedIds,
}: {
  hook: HookPoint;
  /** Newest first. */
  events: readonly GovernanceEvent[];
  /** Events this lane received and no longer holds. */
  behind: number;
  /** This lane's own decisions, over everything it ever received. */
  counts: Readonly<Record<Effect, number>>;
  /** How many cards to draw. The rest are counted, not dropped. */
  visible: number;
  /**
   * The newest event in this lane, or `null`. Used as a React key on the flash
   * element so a new event remounts it and restarts the animation — no timers,
   * and no way for the lane to get stuck lit.
   */
  flashKey: GovernanceEvent | null;
  correlatedIds: ReadonlySet<string>;
}) {
  const lane = LANES[hook];
  const drawn = events.slice(0, visible);
  const notDrawn = events.length - drawn.length + behind;
  // Only decisions this lane has actually made. A lane that has denied nothing
  // should not carry a zero for it; the global tally is where totals live.
  const present = DECISION_ORDER.filter((decision) => counts[decision] > 0);

  return (
    <section className="cg-lane" aria-labelledby={`cg-lane-${hook}`}>
      {flashKey !== null && (
        <span
          className="cg-flash"
          data-decision={flashKey.decision}
          key={flashKey.id}
          aria-hidden="true"
        />
      )}

      <header className="cg-lane-head">
        <h3 className="cg-lane-name" id={`cg-lane-${hook}`}>
          {lane.name}
        </h3>
        <p className="cg-lane-gloss">{lane.gloss}</p>

        {present.length > 0 && (
          <p className="cg-lane-counts">
            {present.map((decision) => (
              <span className="cg-lane-count" data-decision={decision} key={decision}>
                <span className="cg-lane-count-value">{counts[decision]}</span>
                <span>{DECISIONS[decision].lane}</span>
              </span>
            ))}
          </p>
        )}

        {notDrawn > 0 && (
          <p className="cg-lane-behind">
            {notDrawn.toLocaleString("en-US")} earlier {notDrawn === 1 ? "decision" : "decisions"}
          </p>
        )}
      </header>

      <div className="cg-lane-events">
        {drawn.length === 0 ? (
          <p className="cg-lane-empty">{lane.empty}</p>
        ) : (
          drawn.map((event) => (
            <EventCard key={event.id} event={event} correlated={correlatedIds.has(event.id)} />
          ))
        )}
      </div>
    </section>
  );
}
