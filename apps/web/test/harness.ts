/**
 * What the approval page's tests run against: the real control plane, and a
 * stand-in for Arcade that behaves the way Arcade behaves.
 *
 * **The control plane is real.** `apps/hooks` is booted as a subprocess on an
 * OS-assigned port, the same way `tools/loan`'s suite boots `apps/loan-app`.
 * `apps/web` does not depend on it in the package graph and should not start
 * to, so a subprocess is how the two are exercised together without inventing
 * an edge between them. Its port is read off its own boot line rather than
 * chosen: this worktree owns a block of ten ports and the reviewer's owns a
 * different one, so nothing here may pick a number.
 *
 * **Arcade is a stand-in, and a faithful one.** It does what the real engine
 * does for a tool with no auth requirement: call `/pre`, and run the tool only
 * if the answer is `OK`. A `CHECK_FAILED` comes back as a failed execution
 * carrying the hook's own message. So the refusal these tests see is produced
 * by the actual pre-hook against the actual policy — the only fiction is the
 * transport.
 *
 * What that leaves unverified is stated plainly and is not pretended away:
 * nothing here has spoken to `api.arcade.dev`. #13 registers the gateway and
 * the provider; until then the live round trip has no test in this repo.
 */
import { spawn, type Subprocess } from "bun";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { WebConfig } from "../lib/config.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

export const HOOK_SECRET = "hook-secret-for-web-tests";
export const STORE_TOKEN = "store-token-for-web-tests";

export const DANA = "dana.okafor@bank.example";
export const SAM = "sam.reyes@bank.example";
export const RILEY = "riley.chen@bank.example";
export const MORGAN = "morgan.ellis@bank.example";

export interface Harness {
  config: WebConfig;
  hooksHost: string;
  /** Write an escalation straight to the store, as the toolkit would. */
  escalate(overrides?: Record<string, unknown>): Promise<Record<string, unknown>>;
  read(id: string): Promise<Record<string, unknown> | null>;
  /** Every `/pre` call the stand-in Arcade made, in order. */
  preCalls: Array<{ user_id: string; tool: string }>;
  stop(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const hooks = await startHooks();
  const preCalls: Harness["preCalls"] = [];
  const arcade = startArcade(hooks.host, preCalls);

  const config: WebConfig = {
    hooksHost: hooks.host,
    approvalsStoreToken: STORE_TOKEN,
    arcadeApiUrl: `http://localhost:${arcade.port}`,
    arcadeApiKey: "arcade-key-for-web-tests",
    approvalsToolkit: "Approvals",
  };

  const store = (method: string, path: string, body?: unknown) =>
    fetch(`http://${hooks.host}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${STORE_TOKEN}` },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  return {
    config,
    hooksHost: hooks.host,
    preCalls,
    async escalate(overrides = {}) {
      const response = await store("POST", "/approvals", { ...ESCALATION, ...overrides });
      if (response.status !== 201) throw new Error(`escalate: ${response.status} ${await response.text()}`);
      return ((await response.json()) as { request: Record<string, unknown> }).request;
    },
    async read(id) {
      const response = await store("GET", `/approvals/${id}`);
      if (response.status === 404) return null;
      return ((await response.json()) as { request: Record<string, unknown> }).request;
    },
    async stop() {
      arcade.stop(true);
      hooks.process.kill();
      await hooks.process.exited;
    },
  };
}

/** Act 2's escalation, as `tools/approvals` sends it. */
export const ESCALATION = {
  requester_id: DANA,
  action: "approve_loan",
  resource_id: "LN-2291",
  amount: 95_000,
  justification: "Eleven years in business, 742 credit score, $1.4M annual revenue.",
  approver_id: RILEY,
  candidate_approver_ids: [RILEY, MORGAN],
  required_clearance: 95_000,
};

// ---------------------------------------------------------------------------
// The real control plane, as a subprocess
// ---------------------------------------------------------------------------

interface Hooks {
  host: string;
  process: Subprocess<"ignore", "pipe", "pipe">;
}

async function startHooks(): Promise<Hooks> {
  const child = spawn({
    cmd: ["bun", join(REPO_ROOT, "apps", "hooks", "src", "index.ts")],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // 0, so the OS picks. The service prints what it got, and that line is
      // how the port is learned — never a literal and never a guess.
      PORT: "0",
      GOVERNANCE_DB_PATH: ":memory:",
      ARCADE_HOOK_SIGNING_SECRET: HOOK_SECRET,
      APPROVALS_STORE_TOKEN: STORE_TOKEN,
      ARCADE_LOAN_TOOLKIT: "Loan",
      ARCADE_APPROVALS_TOOLKIT: "Approvals",
      NODE_ENV: "test",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const port = await readPort(child);
  return { host: `localhost:${port}`, process: child };
}

/** Reads `listening on :<port>` off the service's own boot line. */
async function readPort(child: Subprocess<"ignore", "pipe", "pipe">): Promise<number> {
  const decoder = new TextDecoder();
  const reader = child.stdout.getReader();
  let buffered = "";
  const deadline = setTimeout(() => child.kill(), 20_000);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const match = /listening on :(\d+)/.exec(buffered);
      if (match) return Number(match[1]);
    }
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
  throw new Error(`apps/hooks did not report a port. Output so far:\n${buffered}`);
}

// ---------------------------------------------------------------------------
// Arcade, as the engine behaves for a tool with no auth requirement
// ---------------------------------------------------------------------------

function startArcade(hooksHost: string, preCalls: Harness["preCalls"]) {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname !== "/v1/tools/execute") {
        return Response.json({ error: "not found" }, { status: 404 });
      }

      const body = (await request.json()) as {
        tool_name: string;
        input: Record<string, unknown>;
        user_id: string;
      };
      const [toolkit, name] = body.tool_name.split(".");
      preCalls.push({ user_id: body.user_id, tool: body.tool_name });

      // 1. The pre-execution hook, exactly as the engine calls it.
      const pre = await fetch(`http://${hooksHost}/pre`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${HOOK_SECRET}` },
        body: JSON.stringify({
          execution_id: `tc_${Math.random().toString(36).slice(2, 10)}`,
          tool: { name, toolkit, version: "1.0.0" },
          inputs: body.input,
          context: { authorization: [{}], user_id: body.user_id },
        }),
      });
      const verdict = (await pre.json()) as { code: string; error_message?: string };

      if (verdict.code !== "OK") {
        return Response.json({
          success: false,
          output: {
            error: {
              message: verdict.error_message ?? "denied",
              code: "CHECK_FAILED",
              can_retry: false,
            },
          },
        });
      }

      // 2. The tool itself. `Approvals.Decide` is a stateless client of the
      //    store, so running it is one HTTP call — the same one the deployed
      //    Python worker makes, with `decided_by` taken from the identity
      //    Arcade supplies and never from an argument.
      const recorded = await fetch(
        `http://${hooksHost}/approvals/${String(body.input.request_id)}/decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${STORE_TOKEN}` },
          body: JSON.stringify({
            decision: body.input.decision,
            note: body.input.note ?? null,
            decided_by: body.user_id,
          }),
        },
      );
      const payload = (await recorded.json()) as { request?: unknown; error?: string };
      if (!recorded.ok) {
        return Response.json({
          success: false,
          output: { error: { message: payload.error ?? "the approvals store refused", can_retry: false } },
        });
      }
      return Response.json({ success: true, output: { value: payload.request } });
    },
  });
}
