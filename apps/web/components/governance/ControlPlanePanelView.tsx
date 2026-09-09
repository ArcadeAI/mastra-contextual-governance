/**
 * The panel, as a pure function of a timeline.
 *
 * Split out from the subscribing component on purpose: everything worth
 * asserting about this surface — that a denial shows its rule, that a removed
 * value never reaches the markup, that three states are distinguishable
 * without colour — is a property of *this*, and none of it needs a socket, a
 * browser, or a fake timer to check.
 */
import type { GovernanceEvent } from "@cg/policy-schema";

import { correlate, isCorrelated, type CorrelationKey } from "../../lib/governance/correlation.ts";
import type { StreamStatus } from "../../lib/governance/subscribe.ts";
import type { StreamMode } from "../../lib/governance/stream-url.ts";
import { allEvents, HOOK_POINTS, type Timeline } from "../../lib/governance/timeline.ts";
import { DECISION_ORDER, DECISIONS } from "./decisions.ts";
import { Lane } from "./Lane.tsx";

/** Cards drawn per lane. Beyond this a lane counts rather than draws. */
export const VISIBLE_PER_LANE = 6;

const CONNECTION: Readonly<Record<StreamStatus, string>> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
};

export interface ControlPlanePanelViewProps {
  readonly timeline: Timeline;
  readonly status: StreamStatus;
  readonly mode: StreamMode;
  /**
   * What the chat is currently showing, if anything — a denial's text, or an
   * execution id. Everything it joins to is outlined. Absent means no
   * highlight, which is the normal state.
   */
  readonly correlationKey?: CorrelationKey | undefined;
}

export function ControlPlanePanelView({
  timeline,
  status,
  mode,
  correlationKey,
}: ControlPlanePanelViewProps) {
  const correlated: GovernanceEvent[] =
    correlationKey === undefined ? [] : correlate(allEvents(timeline), correlationKey);
  const correlatedIds = new Set(correlated.map((event) => event.id));

  return (
    <div className="cg-panel">
      <header className="cg-header">
        <h2 className="cg-title">Control plane</h2>
        <div className="cg-connection" data-status={status}>
          {mode === "fixture" && <span className="cg-mode">Fixture replay</span>}
          <span className="cg-dot" aria-hidden="true" />
          <span>{CONNECTION[status]}</span>
        </div>
      </header>

      <div className="cg-tally">
        {DECISION_ORDER.map((decision) => (
          <p className="cg-stat" data-decision={decision} key={decision}>
            <span className="cg-stat-value">{timeline.counts[decision]}</span>
            <span className="cg-stat-label">{DECISIONS[decision].tally}</span>
          </p>
        ))}
      </div>

      <div className="cg-lanes">
        {HOOK_POINTS.map((hook) => (
          <Lane
            key={hook}
            hook={hook}
            events={timeline.lanes[hook]}
            behind={timeline.behind[hook]}
            visible={VISIBLE_PER_LANE}
            flashKey={
              timeline.lanes[hook][0]?.id === timeline.latestId
                ? (timeline.lanes[hook][0] ?? null)
                : null
            }
            correlatedIds={correlatedIds}
          />
        ))}
      </div>

      {/*
        DESIGN.md open risk 2, said out loud rather than left as a gap. Arcade
        evaluates a tool's auth requirements before the first hook runs, so a
        call refused there writes no audit row and can never appear here. An
        empty lane is therefore not evidence that nothing was attempted, and a
        panel that implied otherwise would be overclaiming exactly where this
        demo needs to be trusted.
      */}
      <p className="cg-footnote">
        Every decision the access, pre and post hooks made is here. Arcade checks whether the
        caller holds a tool&rsquo;s credential before any hook runs, and a call refused there
        leaves no record — so an empty lane means no hook was reached, not that nothing was
        tried.
      </p>
    </div>
  );
}

/** Re-exported so callers can highlight without importing two modules. */
export { isCorrelated };
