/**
 * The governed business system. Owns `loans.db` and serves the loan tools over
 * Streamable HTTP MCP at `POST /mcp`, registered in Arcade as a Remote MCP
 * server.
 *
 * It looks like a bank's internal loan origination service and knows nothing
 * about governance: it does not check authority, withhold fields, or consult
 * anything before applying a write. That is the whole point — the controls
 * live outside it, in a control plane it cannot influence. Anything that would
 * check a caller belongs in `apps/hooks`.
 *
 * This service depends on nothing under `packages/` on purpose: it is the part
 * a forker throws away and replaces with their own domain.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { countLoans, openLoanBook } from "./db.ts";
import { createLoanServer, SERVER_INFO } from "./mcp.ts";

const SERVICE = "loan-mcp";
const MCP_PATH = "/mcp";

const port = Number(process.env.PORT ?? 8082);
const dbPath = process.env.LOANS_DB_PATH ?? "./loans.db";

const db = openLoanBook(dbPath);

/**
 * One server and transport per request, in stateless mode.
 *
 * Nothing needs to survive between calls — every tool's state is in SQLite —
 * and a stateless server has no session table to lose when Render restarts it
 * mid-demo. `enableJsonResponse` returns each result as a complete JSON body
 * rather than an SSE stream: no tool here streams or sends notifications, so
 * there is nothing for a stream to carry.
 */
async function handleMcp(request: Request): Promise<Response> {
  const server = createLoanServer(db);
  // Omitting `sessionIdGenerator` is what selects stateless mode. The SDK's
  // own example passes it as `undefined`, which `exactOptionalPropertyTypes`
  // rejects; leaving it out means the same thing.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });

  await server.connect(transport);

  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}

const server = Bun.serve({
  port,
  idleTimeout: 60,
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/health") {
      return Response.json({
        status: "ok",
        service: SERVICE,
        mcp: { path: MCP_PATH, ...SERVER_INFO },
        loans: countLoans(db),
      });
    }

    if (pathname === MCP_PATH) {
      // Stateless: there is no server-initiated stream to attach to, so the
      // spec's answer to `GET /mcp` is 405 and clients treat it as normal.
      if (request.method === "GET") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }

      return handleMcp(request);
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(
  `[${SERVICE}] listening on :${server.port} — MCP at ${MCP_PATH}, ` +
    `${countLoans(db)} loans in ${dbPath}`,
);
