/**
 * Same shape as the `/health` endpoints on `hooks` and `loan-app`, so the
 * Render blueprint can point all three services at one path.
 *
 * Since #82 it also reports which of this deployment's capabilities are
 * actually configured — the three identity ones, and since #14 the agent. That is not decoration: sign-in, the gateway hop and
 * the custom verifier each depend on variables a human sets by hand in the
 * Render dashboard and in the Arcade dashboard, they fail independently, and
 * two of the three fail at a step no hook observes — so an unset variable is
 * otherwise discovered mid-rehearsal as "the demo does nothing". The fields say
 * `configured` or `missing` and never which value is wrong, because the value
 * is a credential in two cases out of three.
 *
 * It still does not read `APPROVALS_STORE_TOKEN`'s production guard, and it
 * answers `200` whatever it finds — a health check that fails on a
 * misconfiguration would take the service out of rotation instead of telling
 * anyone what to fix, and Render would abandon the deploy before anybody could
 * read this. The refusal lives in the body (`"status":"degraded"`), on the home
 * page, and in the 503 every identity route and the chat route answer.
 * That is what `readIdentitySurface` is for: the same environment, read without
 * the guard that belongs to a credential this endpoint does not use.
 */
import { deploymentReadiness, readIdentitySurface } from "../../lib/config.ts";

export const dynamic = "force-dynamic";

export function GET() {
  const { status, ...capabilities } = deploymentReadiness(readIdentitySurface());
  // `status` first, because it is the field anybody actually reads and the one
  // the other three services answer. `degraded` whenever any capability is
  // missing — and still HTTP 200, so Render brings the instance up and a human
  // can read the four fields that say which one.
  return Response.json({ status, service: "web", ...capabilities });
}
