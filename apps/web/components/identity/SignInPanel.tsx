/**
 * "Sign in as …" — what the persona switcher becomes once `apps/web` has a real
 * identity.
 *
 * `DESIGN.md` → **Identity**: the switcher stops being a dropdown that picks a
 * label and becomes a sign-in against `apps/idp` under client C. Each button
 * starts an OIDC authorization and lands the browser on **cg-idp's** login page;
 * the persona who comes back is whoever typed a password there, not whichever
 * button was pressed.
 *
 * Deliberately minimal. The human's stated demo shape is one Chrome profile per
 * persona, so switching is rare and this panel is mostly a way in — the four
 * buttons matter less than the two facts underneath them: the email on screen
 * is the one the IdP asserted, and the gateway token beside it belongs to that
 * person.
 *
 * No client JavaScript. Four links and one form, so the whole thing works
 * before hydration and there is no state here that could disagree with the
 * cookie.
 */
import { PERSONAS } from "../../lib/identity/personas.ts";
import { SIGNIN_PATH, SIGNOUT_PATH, GATEWAY_START_PATH } from "../../lib/identity/handlers.ts";
import type { IdentityReadiness } from "../../lib/config.ts";
import type { Session } from "../../lib/identity/session.ts";

export interface SignInPanelProps {
  session: Session | null;
  readiness: IdentityReadiness;
}

const card: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: "6px",
  padding: "1.25rem",
  marginTop: "2rem",
};

const button: React.CSSProperties = {
  display: "inline-block",
  border: "1px solid var(--line)",
  borderRadius: "4px",
  padding: "0.5rem 0.85rem",
  fontSize: "0.875rem",
  textDecoration: "none",
  color: "inherit",
  background: "transparent",
  cursor: "pointer",
};

export function SignInPanel({ session, readiness }: SignInPanelProps) {
  return (
    <section style={card}>
      <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Sign in as …</h2>

      {readiness.signin === "missing" ? (
        <p style={{ color: "var(--muted)", fontSize: "0.875rem", marginTop: 0 }}>
          Sign-in is not configured on this deployment. <code>GET /health</code> names which of{" "}
          <code>signin</code>, <code>gateway</code> and <code>verifier</code> is missing, and{" "}
          <code>apps/web/README.md</code> says where each value comes from.
        </p>
      ) : null}

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        {PERSONAS.map((persona) => (
          <a key={persona.key} href={`${SIGNIN_PATH}?persona=${persona.key}`} style={button}>
            {persona.name}
            <span style={{ color: "var(--muted)" }}> — {persona.role}</span>
          </a>
        ))}
      </div>

      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "0.25rem 1rem",
          margin: "1.25rem 0 0",
          fontSize: "0.875rem",
        }}
      >
        <dt style={{ color: "var(--muted)" }}>Signed in as</dt>
        <dd style={{ margin: 0 }}>
          {/* The email the IdP asserted, lowercase — the same string Arcade
              receives as `user_id` and the loan book records as the actor. */}
          {session ? <code>{session.email}</code> : <span style={{ color: "var(--muted)" }}>nobody</span>}
        </dd>

        <dt style={{ color: "var(--muted)" }}>Gateway token</dt>
        <dd style={{ margin: 0 }}>
          {/* Never the token, and never a prefix of it. Whether one is held and
              when it expires is everything anyone needs to see; the value is a
              bearer for the whole gateway. */}
          {session?.gateway ? (
            <>held, expires {new Date(session.gateway.expires_at).toISOString()}</>
          ) : (
            <span style={{ color: "var(--muted)" }}>none</span>
          )}
        </dd>
      </dl>

      {session ? (
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", alignItems: "center" }}>
          {session.gateway ? null : (
            <a href={GATEWAY_START_PATH} style={button}>
              Authorize the gateway
            </a>
          )}
          <form action={SIGNOUT_PATH} method="post" style={{ margin: 0 }}>
            <button type="submit" style={button}>
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </section>
  );
}
