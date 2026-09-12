/**
 * `/chat` — the tracer bullet's whole user interface.
 *
 * A server component, so the session is unsealed on the server and the only
 * thing that reaches the browser is the persona's email. The gateway token
 * never leaves this process; the chat route reads it from the cookie on each
 * turn.
 */
import { cookies } from "next/headers";

import { Chat } from "../../components/chat/Chat.tsx";
import { configurationProblems, readIdentitySurface } from "../../lib/config.ts";
import { ConfigurationBanner } from "../../components/identity/SignInPanel.tsx";
import { readSessionFromCookies } from "../../lib/identity/session.ts";
import { SIGNIN_PATH, GATEWAY_START_PATH } from "../../lib/identity/handlers.ts";

/** Reads a session cookie; a prerender of "who is signed in" is wrong or empty. */
export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const jar = await cookies();
  const config = readIdentitySurface();
  const session = await readSessionFromCookies(
    new Map(jar.getAll().map((cookie) => [cookie.name, cookie.value])),
    config,
  );

  return (
    <main style={{ maxWidth: "42rem", margin: "0 auto", padding: "3rem 1.5rem" }}>
      <h1 style={{ fontSize: "1.5rem", margin: "0 0 0.5rem" }}>Loan operations</h1>
      <p style={{ color: "var(--muted)", marginTop: 0, fontSize: "0.875rem" }}>
        The agent reaches its tools through the Arcade gateway as the person signed in here. Every
        call passes the control plane first.
      </p>

      <ConfigurationBanner problems={configurationProblems(config)} />

      {session ? null : (
        <p style={{ fontSize: "0.875rem" }}>
          <a href={SIGNIN_PATH}>Sign in</a> first — the agent acts as whoever is signed in on this
          browser, and there is nobody yet.
        </p>
      )}
      {session && !session.gateway ? (
        <p style={{ fontSize: "0.875rem" }}>
          Signed in, but this browser holds no gateway token.{" "}
          <a href={GATEWAY_START_PATH}>Authorize the gateway</a>.
        </p>
      ) : null}

      <Chat signedInAs={session?.email ?? null} />
    </main>
  );
}
