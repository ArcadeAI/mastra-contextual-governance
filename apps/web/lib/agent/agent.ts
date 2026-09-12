/**
 * The agent. Claude Sonnet 5 via `@ai-sdk/anthropic`, temperature 0, model id
 * from the environment — `DESIGN.md` → Model.
 *
 * ## The system prompt says nothing about being denied
 *
 * This is the load-bearing decision in the file and it is easy to undo by
 * accident. Spike #6 measured that a hook's `error_message` crosses to the
 * model verbatim over MCP, and issue #14 draws the conclusion: *"there is no
 * excuse for putting denial-handling instructions in the system prompt. If the
 * model doesn't act on the remediation text, the text is wrong — fix it in #12,
 * not in the prompt."*
 *
 * So there is no sentence below about escalation, about approvals, about
 * retrying, or about what to do when a tool fails. `DESIGN.md` → Determinism:
 * **the hook writes the remediation instruction, not the system prompt.** A
 * prompt that also wrote it would make the demo pass while proving nothing —
 * the model would be following our instructions, and the claim under test is
 * that it follows the control plane's.
 *
 * What the prompt does say is what the model could not know: that it is working
 * inside a bank's loan book, and that its tools write to a system of record.
 * Nothing about authority, because authority is not its question.
 *
 * ## Temperature 0, and one model id
 *
 * Temperature is pinned at the call site rather than at construction because
 * `modelSettings` is a per-execution option in Mastra and a default set here
 * can be overridden by a caller who does not know it exists. One place, on
 * every run: `run.ts`.
 */
import { Agent } from "@mastra/core/agent";
import { createAnthropic } from "@ai-sdk/anthropic";

/** What the model is told. Deliberately short, and deliberately silent about governance. */
export const INSTRUCTIONS = [
  "You are a loan operations assistant inside a commercial bank's loan origination system.",
  "",
  "You work on loan applications on behalf of the person you are talking to. Your tools read and",
  "write the bank's system of record: reading is safe, and recording a decision is a real,",
  "irreversible write against a real application. Read an application before you record a decision",
  "on it.",
  "",
  "Answer in plain prose. When you have done something, say what you did. When something did not",
  "happen, say what came back and why, in the words you were given.",
].join("\n");

export interface ModelOptions {
  /** `MODEL_ID` — `claude-sonnet-5`. Kept in the environment so it can be swapped without a change here. */
  modelId: string;
  /** `ANTHROPIC_API_KEY`. */
  apiKey: string;
}

/**
 * The language model, or a caller-supplied one.
 *
 * The seam exists for one reason: a suite has to be able to drive the whole
 * governed chain — real control plane, real loan book, real MCP transport —
 * on a machine with no Anthropic key, and separately to drive it with the real
 * model when there is one. Everything downstream of the model is identical in
 * both cases, which is what makes the cheap run worth running.
 */
export type ModelLike = Parameters<typeof buildAgent>[0]["model"];

export function anthropicModel(options: ModelOptions) {
  // `createAnthropic` rather than the default `anthropic` export: the default
  // reads `ANTHROPIC_API_KEY` off `process.env` at call time, and this service
  // reads its environment in exactly one place (`lib/config.ts`).
  return createAnthropic({ apiKey: options.apiKey })(options.modelId);
}

/** Stable across turns and processes, so a trace names the same agent every time. */
export const AGENT_ID = "loan-operations";

export function buildAgent(options: {
  model: ConstructorParameters<typeof Agent>[0]["model"];
  tools: Record<string, unknown>;
  instructions?: string;
}): Agent {
  return new Agent({
    id: AGENT_ID,
    name: "loan-operations",
    instructions: options.instructions ?? INSTRUCTIONS,
    model: options.model,
    // `exactOptionalPropertyTypes` is on, so the cast has to drop `undefined`
    // rather than widen to it: an optional property may be absent, but it may
    // not be present and undefined.
    tools: options.tools as NonNullable<ConstructorParameters<typeof Agent>[0]["tools"]>,
  });
}
