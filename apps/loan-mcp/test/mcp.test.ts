/**
 * The MCP surface, exercised over real HTTP by the reference client — not by
 * calling the tool handlers directly.
 *
 * `initialize`, `tools/list` and `tools/call` all go over the wire through
 * `@modelcontextprotocol/sdk`'s own Streamable HTTP client, because the thing
 * that has to work is the transport Arcade will proxy, and a handler invoked
 * in-process proves nothing about it.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const dbPath = join(tmpdir(), `cg-loan-mcp-${crypto.randomUUID()}`, "loans.db");

let child: Subprocess;
let baseUrl: string;

/** Boots the service the way Render does: `bun src/index.ts`, env only. */
beforeAll(async () => {
  const port = 8000 + Math.floor(Math.random() * 1000);
  baseUrl = `http://127.0.0.1:${port}`;

  child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "index.ts")], {
    env: { ...process.env, PORT: String(port), LOANS_DB_PATH: dbPath },
    stdout: "pipe",
    stderr: "pipe",
  });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error("loan-mcp did not come up");
    await Bun.sleep(50);
  }
});

afterAll(() => {
  child?.kill();
  rmSync(dirname(dbPath), { recursive: true, force: true });
});

/** A bare MCP client. No wrapper, no shared state with the server. */
async function connect(): Promise<Client> {
  const client = new Client({ name: "loan-mcp-test-client", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
  return client;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

describe("health", () => {
  test("answers for Render's health check", async () => {
    const body = await (await fetch(`${baseUrl}/health`)).json();

    expect(body).toMatchObject({ status: "ok", service: "loan-mcp" });
    expect(body.loans).toBeGreaterThan(1);
  });
});

describe("initialize", () => {
  test("succeeds and reports the name Arcade derives the toolkit from", async () => {
    const client = await connect();
    const info = client.getServerVersion();
    await client.close();

    expect(info).toMatchObject({ name: "loan-app", version: "1.0.0" });
  });

  test("claims no capability it cannot honour", async () => {
    const client = await connect();
    const capabilities = client.getServerCapabilities();
    await client.close();

    // Stateless: each server is closed with its response, so there is never a
    // channel to send `notifications/tools/list_changed` on.
    expect(capabilities?.tools).toEqual({ listChanged: false });
    expect(capabilities?.resources).toBeUndefined();
    expect(capabilities?.prompts).toBeUndefined();
  });

  test("the reported name survives Arcade's normalisation as LoanApp", () => {
    // Lowercase, strip every `mcp` and `server` substring, split on
    // non-alphanumerics, PascalCase — measured in
    // docs/spikes/02-remote-mcp-hooks.md. `loan-mcp` would collapse to `Loan`,
    // so this guards the one property of the name that matters. The real value
    // is still to be read off a `/pre` payload on #13.
    const normalise = (name: string) =>
      name
        .toLowerCase()
        .replaceAll("mcp", "")
        .replaceAll("server", "")
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join("");

    expect(normalise("loan-app")).toBe("LoanApp");
  });
});

describe("tools/list", () => {
  test("advertises exactly the four loan tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "approve_loan",
      "deny_loan",
      "get_loan",
      "search_loans",
    ]);
  });

  test("every tool carries a description and a typed input schema", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();

    for (const tool of tools) {
      expect(tool.description ?? "").not.toBeEmpty();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  test("describes each argument, so a model can fill them without coaching", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();

    for (const tool of tools) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<
        string,
        { description?: string }
      >;

      expect(Object.keys(properties).length).toBeGreaterThan(0);
      for (const [name, schema] of Object.entries(properties)) {
        expect(schema.description ?? "", `${tool.name}.${name}`).not.toBeEmpty();
      }
    }
  });

  test("marks the reads read-only and the writes not", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();

    const readOnly = Object.fromEntries(
      tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint]),
    );

    expect(readOnly).toEqual({
      search_loans: true,
      get_loan: true,
      approve_loan: false,
      deny_loan: false,
    });
  });

  test("requires only loan_id on get_loan and nothing on search_loans", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();

    const required = (name: string) =>
      tools.find((tool) => tool.name === name)?.inputSchema.required ?? [];

    expect(required("search_loans")).toEqual([]);
    expect(required("get_loan")).toEqual(["loan_id"]);
    expect(required("approve_loan").sort()).toEqual(["amount", "loan_id"]);
    expect(required("deny_loan").sort()).toEqual(["loan_id", "reason"]);
  });
});

describe("search_loans", () => {
  test("returns plausible surrounding loans with no filter", async () => {
    const client = await connect();
    const result = await callTool(client, "search_loans", {});
    await client.close();

    const body = JSON.parse(textOf(result));
    expect(body.count).toBeGreaterThan(4);
    expect(body.loans.map((loan: { loan_id: string }) => loan.loan_id)).toContain("LN-2291");
  });

  test("honours the filters", async () => {
    const client = await connect();
    const result = await callTool(client, "search_loans", {
      status: "pending",
      min_amount: 90_000,
      max_amount: 100_000,
    });
    await client.close();

    const body = JSON.parse(textOf(result));
    expect(body.loans).toHaveLength(1);
    expect(body.loans[0]).toMatchObject({ loan_id: "LN-2291", amount: 95_000 });
  });

  test("rejects a filter of the wrong type", async () => {
    const client = await connect();
    const result = await callTool(client, "search_loans", { status: "in_review" });
    await client.close();

    expect(result.isError).toBe(true);
  });
});

describe("get_loan", () => {
  test("returns the full record, unredacted", async () => {
    const client = await connect();
    const result = await callTool(client, "get_loan", { loan_id: "LN-2291" });
    await client.close();

    const loan = JSON.parse(textOf(result));

    expect(loan).toMatchObject({
      loan_id: "LN-2291",
      borrower_name: "Northwind Bakery LLC",
      amount: 95_000,
    });

    // Acts 3 and 4 depend on all of this arriving intact. Whatever the post
    // hook does to it, it does downstream of here.
    expect(loan.bank_account_number).toMatch(/^\d{16}$/);
    expect(loan.tax_id).toMatch(/^\d{2}-\d{7}$/);
    expect(loan.underwriter_notes).toContain("approve_loan");
    expect(textOf(result)).not.toContain("[REDACTED]");
  });

  test("errors on an unknown loan", async () => {
    const client = await connect();
    const result = await callTool(client, "get_loan", { loan_id: "LN-0000" });
    await client.close();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("LN-0000");
  });
});

describe("decisions", () => {
  test("approve_loan records the approval, and a second one is visible", async () => {
    const client = await connect();

    const first = JSON.parse(
      textOf(await callTool(client, "approve_loan", { loan_id: "LN-2292", amount: 15_500 })),
    );
    expect(first.status).toBe("approved");
    expect(first.decisions).toHaveLength(1);

    const second = JSON.parse(
      textOf(await callTool(client, "approve_loan", { loan_id: "LN-2292", amount: 9_000 })),
    );
    expect(second.decisions).toHaveLength(2);
    expect(second.decisions.map((d: { amount: number }) => d.amount)).toEqual([15_500, 9_000]);

    await client.close();
  });

  test("deny_loan records the reason verbatim", async () => {
    const client = await connect();
    const reason = "Collateral appraisal is more than twelve months old.";

    const loan = JSON.parse(
      textOf(await callTool(client, "deny_loan", { loan_id: "LN-2299", reason })),
    );
    await client.close();

    expect(loan.status).toBe("denied");
    expect(loan.decisions.at(-1)).toMatchObject({ decision: "denied", reason, amount: null });
  });

  test("survives across connections — the loan book is the only state", async () => {
    const client = await connect();
    const loan = JSON.parse(textOf(await callTool(client, "get_loan", { loan_id: "LN-2299" })));
    await client.close();

    expect(loan.status).toBe("denied");
  });
});

describe("transport", () => {
  test("GET /mcp is 405 — a stateless server offers no standalone stream", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      headers: { Accept: "text/event-stream" },
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  test("issues no session id, so any instance can serve any call", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "curl", version: "0" },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = await response.json();
    expect(body.result.serverInfo).toMatchObject({ name: "loan-app" });
  });

  test("an unknown path is still a 404", async () => {
    expect((await fetch(`${baseUrl}/loans`)).status).toBe(404);
  });
});
