/**
 * The control plane. Owns `governance.db`, serves Arcade's `/access`, `/pre`
 * and `/post` hooks, and fans decisions out to the UI over SSE.
 *
 * A stub for now: the point of this slice is that the deploy pipeline works
 * before any logic goes into it. The hook endpoints land in #12.
 */
import { FAIL_CLOSED } from "@cg/governance-core";

const SERVICE = "hooks";
const port = Number(process.env.PORT ?? 8081);

const server = Bun.serve({
  port,
  fetch(request) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/health") {
      return Response.json({
        status: "ok",
        service: SERVICE,
        // Proves the workspace link resolved at runtime, not just at typecheck.
        failure_mode: FAIL_CLOSED.effect === "deny" ? "fail-closed" : "unknown",
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`[${SERVICE}] listening on :${server.port}`);

