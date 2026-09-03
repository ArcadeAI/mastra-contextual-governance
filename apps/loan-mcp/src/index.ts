/**
 * The governed business system. Owns `loans.db` and serves the loan tools over
 * Streamable HTTP MCP, registered in Arcade as a Remote MCP server.
 *
 * A stub for now. The MCP transport and the four loan tools land in #11.
 *
 * This service depends on nothing under `packages/` on purpose: it is the part
 * a forker throws away and replaces with their own domain.
 */
const SERVICE = "loan-mcp";
const port = Number(process.env.PORT ?? 8082);

const server = Bun.serve({
  port,
  fetch(request) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/health") {
      return Response.json({ status: "ok", service: SERVICE });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`[${SERVICE}] listening on :${server.port}`);
