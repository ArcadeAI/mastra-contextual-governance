/**
 * The four buttons on the sign-in panel.
 *
 * Names and roles only — **no emails and no passwords**. That is the point of
 * the slice: the persona a button names is a request to start a sign-in, and
 * the identity that comes back is whatever `apps/idp` asserts about whoever
 * typed a password. If this list carried emails, the temptation would be to
 * trust one, and `context.user_id` would become a value the browser chose.
 *
 * The cast is `DESIGN.md`'s. It is a demo fixture in the same category as the
 * IdP itself: a forker deletes both and points at their own directory.
 */
export interface PersonaButton {
  /** The key the sign-in route echoes back as a label. Never an identity. */
  key: string;
  name: string;
  role: string;
}

export const PERSONAS: readonly PersonaButton[] = [
  { key: "dana", name: "Dana Okafor", role: "Loan Officer" },
  { key: "sam", name: "Sam Reyes", role: "Credit Analyst" },
  { key: "riley", name: "Riley Chen", role: "VP Credit" },
  { key: "morgan", name: "Morgan Ellis", role: "Chief Credit Officer" },
] as const;

/** A persona key the roster knows, or `undefined`. An unknown key is dropped, never echoed. */
export function knownPersona(key: string | null | undefined): string | undefined {
  return PERSONAS.find((persona) => persona.key === key?.trim().toLowerCase())?.key;
}
