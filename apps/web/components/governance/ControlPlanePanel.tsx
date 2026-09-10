"use client";

/**
 * The panel, wired to a stream.
 *
 * All this adds to {@link ControlPlanePanelView} is a subscription and a piece
 * of state. The stream's address arrives as a prop because it is resolved in a
 * server component — see `lib/governance/stream-url.ts` for why a
 * `NEXT_PUBLIC_` variable would be empty in the deployed browser and fine in
 * development, which is the worst way to find out.
 */
import { useEffect, useState } from "react";

import type { CorrelationKey } from "../../lib/governance/correlation.ts";
import type { StreamMode } from "../../lib/governance/stream-url.ts";
import { subscribeToGovernanceEvents, type StreamStatus } from "../../lib/governance/subscribe.ts";
import { appendEvents, emptyTimeline } from "../../lib/governance/timeline.ts";
import { ControlPlanePanelView } from "./ControlPlanePanelView.tsx";

export interface ControlPlanePanelProps {
  readonly streamUrl: string;
  readonly mode: StreamMode;
  readonly correlationKey?: CorrelationKey | undefined;
}

export function ControlPlanePanel({ streamUrl, mode, correlationKey }: ControlPlanePanelProps) {
  const [timeline, setTimeline] = useState(emptyTimeline);
  const [status, setStatus] = useState<StreamStatus>("connecting");

  useEffect(() => {
    const controller = new AbortController();

    void subscribeToGovernanceEvents(streamUrl, {
      // The subscriber hands over everything one read of the socket yielded, so
      // a burst of a thousand events costs a handful of renders rather than a
      // thousand. Appending the batch in one update is the other half of that.
      onEvents: (batch) => setTimeline((current) => appendEvents(current, batch)),
      onStatus: setStatus,
      onUnusableFrame: (data, problem) => {
        // Loud on purpose. A frame the panel cannot read is a contract
        // mismatch with the hook server, and the symptom — a panel that shows
        // nothing — looks identical to a control plane deciding nothing.
        console.warn(`[control-plane] unusable frame (${problem}):`, data);
      },
      signal: controller.signal,
    });

    return () => controller.abort();
  }, [streamUrl]);

  return (
    <ControlPlanePanelView
      timeline={timeline}
      status={status}
      mode={mode}
      correlationKey={correlationKey}
    />
  );
}
