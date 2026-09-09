/**
 * The panel's no-backend stream.
 *
 * Replays #5's `aGovernanceEventSequence()` as real `text/event-stream` frames,
 * in the same shape `apps/hooks` will send on #20. It exists so the control
 * plane panel can be opened, demoed and reviewed with nothing else running —
 * `bun run dev:web` and the acts play — and so the wire format has a second
 * implementation, which is the cheapest way to notice the client and the server
 * disagreeing about it.
 *
 * It is a fixture, and says so: the panel labels this mode rather than letting
 * a rehearsal mistake a replay for the live control plane.
 */
import { aGovernanceEventSequence } from "@cg/policy-schema";

import { GOVERNANCE_EVENT_NAME } from "../../../../lib/governance/subscribe.ts";

export const dynamic = "force-dynamic";

/** Paced so each act lands separately, the way it would from a real tool call. */
const DEFAULT_DELAY_MS = 900;
/** Keeps the connection open once the story has played out. */
const KEEP_ALIVE_MS = 15_000;

/** Plain timers, not `Bun.sleep`: this runs under whichever runtime Next uses. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function GET(request: Request): Response {
  // `Number(null)` is 0, not NaN, so an absent parameter has to be checked for
  // rather than coerced — otherwise the default pacing silently becomes "all at
  // once" and the acts land on top of each other.
  const requested = new URL(request.url).searchParams.get("delayMs");
  const parsed = requested === null ? Number.NaN : Number(requested);
  const delayMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DELAY_MS;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (text: string): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          open = false;
        }
      };

      request.signal.addEventListener("abort", () => {
        open = false;
      });

      // A comment first, so the client reports itself live straight away rather
      // than after the first event a second later.
      send(": governance fixture stream\n\n");

      for (const event of aGovernanceEventSequence()) {
        if (!open) break;
        await sleep(delayMs);
        if (!open) break;
        send(
          `event: ${GOVERNANCE_EVENT_NAME}\n` +
            `id: ${event.id}\n` +
            `data: ${JSON.stringify(event)}\n\n`,
        );
      }

      // Hold the connection rather than closing it. A close would send the
      // client into its reconnect loop and replay the whole story on a timer,
      // which looks like the control plane deciding the same call over and over.
      while (open) {
        await sleep(KEEP_ALIVE_MS);
        send(": keep-alive\n\n");
      }

      try {
        controller.close();
      } catch {
        // Already closed by the client going away.
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Render sits behind a proxy that will otherwise buffer the whole
      // response and deliver the acts all at once, at the end.
      "x-accel-buffering": "no",
    },
  });
}
