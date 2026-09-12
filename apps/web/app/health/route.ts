/**
 * Same shape as the `/health` endpoints on `hooks` and `loan-app`, so the
 * Render blueprint can point all three services at one path.
 *
 * Since #82 it also reports which of the three identity capabilities this
 * deployment actually has. That is not decoration: sign-in, the gateway hop and
 * the custom verifier each depend on variables a human sets by hand in the
 * Render dashboard and in the Arcade dashboard, they fail independently, and
 * two of the three fail at a step no hook observes — so an unset variable is
 * otherwise discovered mid-rehearsal as "the demo does nothing". The fields say
 * `configured` or `missing` and never which value is wrong, because the value
 * is a credential in two cases out of three.
 *
 * Since #81 it also reports `panel_stream` — `live`, `fixture` or
 * `unconfigured` — because the control-plane panel is a fourth thing that
 * depends on hand-set variables and fails on its own. It failed quietly for
 * every production deploy between #21 and #81: the panel replayed a fixture
 * and nothing, here or on screen, said the live control plane was never being
 * watched. An `unconfigured` panel makes this endpoint `degraded` for the same
 * reason a missing capability does.
 *
 * It still does not read `APPROVALS_STORE_TOKEN`'s production guard, and it
 * answers `200` whatever it finds — a health check that fails on a
 * misconfiguration would take the service out of rotation instead of telling
 * anyone what to fix, and Render would abandon the deploy before anybody could
 * read this. The refusal lives in the body (`"status":"degraded"`), on the home
 * page, and in the 503 every identity route answers.
 * That is what `readIdentitySurface` is for: the same environment, read without
 * the guard that belongs to a credential this endpoint does not use.
 */
import { identityReadiness, readIdentitySurface } from "../../lib/config.ts";
import { panelStreamHealth } from "../../lib/governance/stream-url.ts";

export const dynamic = "force-dynamic";

export function GET() {
  const { status: identity, ...capabilities } = identityReadiness(readIdentitySurface());

  // The fourth capability, and the one #81 was opened for. It is not
  // `configured`/`missing` like the three above because there are three answers
  // rather than two: a panel can be watching the live control plane, replaying
  // the fixture on purpose, or watching nothing. Only the last is a fault —
  // `fixture` is a mode somebody chose and the panel says so on screen.
  const panel_stream = panelStreamHealth(process.env);

  // `status` first, because it is the field anybody actually reads and the one
  // the other three services answer. `degraded` whenever any capability is
  // missing or the panel has no stream — and still HTTP 200, so Render brings
  // the instance up and a human can read the fields that say which one.
  const status = identity === "ok" && panel_stream !== "unconfigured" ? "ok" : "degraded";

  return Response.json({ status, service: "web", ...capabilities, panel_stream });
}
