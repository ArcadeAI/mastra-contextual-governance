"use server";

/**
 * The two server actions the approval page needs, and nothing else.
 *
 * `decide` is the whole security claim of this slice in one function: it reads
 * the identity from the cookie *on the server*, and then makes an ordinary
 * Arcade tool call as that person. It does not write to `governance.db`, it
 * does not call the approvals store, and it has no branch that records a
 * decision when Arcade refuses. Every path to a recorded decision goes through
 * `/pre`.
 *
 * The note and the decision come from the form; the actor does not. An actor
 * the browser could post is an actor the browser could choose, and the whole
 * demo turns on the actor being something the caller cannot write.
 */
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { readWebConfig } from "../../../lib/config.ts";
import { submitDecision, type DecideResult } from "../../../lib/decide.ts";
import { fetchRoster } from "../../../lib/approvals-store.ts";
import { choosePersona, PERSONA_COOKIE } from "../../../lib/persona.ts";

export async function switchPersona(requestId: string, form: FormData): Promise<void> {
  const chosen = form.get("persona");
  if (typeof chosen === "string" && chosen.length > 0) {
    const store = await cookies();
    // Not a permission: it selects which real Arcade account the next tool
    // call is made under. Choosing the requester and pressing Approve is a
    // beat the demo wants, not a hole.
    store.set(PERSONA_COOKIE, chosen, { httpOnly: true, sameSite: "lax", path: "/" });
  }
  revalidatePath(`/approvals/${requestId}`);
}

export async function decide(
  requestId: string,
  approverFallback: string,
  _previous: DecideResult,
  form: FormData,
): Promise<DecideResult> {
  const decision = form.get("decision");
  if (decision !== "approved" && decision !== "denied") {
    return { state: "failed", message: "No decision was submitted." };
  }

  const config = readWebConfig();
  const store = await cookies();
  const roster = await fetchRoster(config);
  const userId = choosePersona(store.get(PERSONA_COOKIE)?.value, roster, approverFallback);

  const noteField = form.get("note");
  const note = typeof noteField === "string" && noteField.trim().length > 0 ? noteField.trim() : null;

  const result = await submitDecision({ userId, requestId, decision, note }, config);
  // Re-read on the way out so a recorded decision is reflected in the details
  // above the buttons, and a refusal visibly leaves them alone.
  revalidatePath(`/approvals/${requestId}`);
  return result;
}
