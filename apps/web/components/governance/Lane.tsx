/**
 * One control point's column: its key, its plain-language gloss, and its events
 * newest-first so the freshest card is always in the same place on screen.
 *
 * The lane draws at most `visible` cards. Everything the timeline holds beyond
 * that, plus everything it has already let go, is *counted and stated* — an
 * audit surface that quietly discards records would be arguing against the
 * thing this whole project is arguing for.
 */
import type { GovernanceEvent, HookPoint } from "@cg/policy-schema";

import { EventCard } from "./EventCard.tsx";
import { LANES } from "./decisions.ts";

export function Lane({
  hook,
  events,
  behind,
  visible,
  flashKey,
  correlatedIds,
}: {
  hook: HookPoint;
  /** Newest first. */
  events: readonly GovernanceEvent[];
  /** Events this lane received and no longer holds. */
  behind: number;
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
        {/*
          In the header, not under the cards. Under them it is the first thing a
          burst pushes out of a lane that clips its overflow — so the one line
          saying "there is more than this" would disappear exactly when it
          became true, which is the silent-drop failure this panel must not have.
        */}
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
