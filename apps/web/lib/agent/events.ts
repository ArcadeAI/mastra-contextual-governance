/**
 * What the chat route streams, one JSON object per line.
 *
 * NDJSON rather than plain text because three of these are not text: a tool
 * call the person should see happening, a hook denial that the panel will later
 * join on its `[ref …]` token (#21), and layer 2's authorization link, which
 * has to be clickable and has to be distinguishable from a refusal. A plain
 * text stream would flatten all of that into prose and the page would have to
 * parse English.
 *
 * Deliberately not the AI SDK's UI message stream. That protocol is richer than
 * this slice needs and it would put the shape of a vendor's stream between the
 * control plane and the screen; these seven kinds are the whole vocabulary and
 * `test/chat-stream.test.ts` reads them back.
 */

export type ChatEvent =
  /** A run of assistant text. Concatenate in order; there is no other text source. */
  | { kind: "text"; text: string }
  /** The model chose a tool. Emitted before the call is made, so a slow call is visible. */
  | { kind: "tool-call"; tool: string; inputs: Record<string, unknown> }
  /** The tool ran. The value is not streamed — the reply says what happened. */
  | { kind: "tool-result"; tool: string }
  /**
   * A hook refused. `reason` is the rule's own remediation text with Arcade's
   * prefix stripped; `ref` is the audit row id the control plane embedded (#6),
   * or `null` when the message carries none.
   */
  | { kind: "denied"; tool: string; reason: string; ref: string | null }
  /**
   * Layer 2: a credential is missing, nothing was refused. The page renders the
   * link as a step to take. **No hook fired and no audit row exists** for this,
   * which is why it is its own kind and not a `denied`.
   */
  | { kind: "authorization"; tool: string; url: string; instructions?: string }
  /** Anything that stopped the run. The message is shown; it is not a tool outcome. */
  | { kind: "error"; message: string }
  /** The run finished. `calls` is every tool call attempted, denials included. */
  | { kind: "done"; calls: number };

/** The content type the chat route answers with. */
export const NDJSON = "application/x-ndjson";

/**
 * Where the chat route lives.
 *
 * Here rather than beside the handler, and the reason is a build failure rather
 * than tidiness: `components/chat/Chat.tsx` is a client component, importing
 * this constant from `lib/agent/handlers.ts` pulled `@mastra/mcp` into the
 * browser bundle through it, and `next build` stopped on
 * `Module not found: Can't resolve 'fs'` — the MCP SDK's stdio transport.
 *
 * This module is the contract between the two sides and depends on nothing, so
 * it is the one thing both may import. `handlers.ts` re-exports it for callers
 * that only care about the server side.
 */
export const CHAT_PATH = "/api/chat";

export function encodeEvent(event: ChatEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Parse a whole NDJSON body. Blank lines are skipped; a line that is not JSON
 * is skipped rather than thrown on, because a truncated stream should leave the
 * events that did arrive readable.
 */
export function decodeEvents(body: string): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (const line of body.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as ChatEvent);
    } catch {
      continue;
    }
  }
  return events;
}

/** Every `text` event joined — the reply as a person reads it. */
export function replyText(events: readonly ChatEvent[]): string {
  return events
    .filter((event): event is Extract<ChatEvent, { kind: "text" }> => event.kind === "text")
    .map((event) => event.text)
    .join("");
}
