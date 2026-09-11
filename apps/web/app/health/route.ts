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
 * It still does not read `APPROVALS_STORE_TOKEN`'s production guard, so it
 * answers `200` either way — a health check that fails on a misconfiguration
 * would take the service out of rotation instead of telling anyone what to fix.
 */
import { identityReadiness, readWebConfig } from "../../lib/config.ts";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok", service: "web", ...identityReadiness(readWebConfig()) });
}
