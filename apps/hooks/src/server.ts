/**
 * The HTTP layer. Thin on purpose: bearer auth, parse, hand to a handler,
 * append the audit rows, respond. The one piece of behaviour that is its own
 * is the fail-closed net around all of that.
 *
 * Fails closed, and the failure is audited. Whatever goes wrong between the
 * request arriving and the response leaving — an unparseable body, a throw in
 * the engine, the audit write itself failing, our own deadline passing — the
 * answer Arcade gets is a denial, and a row saying why is appended if the
 * store will take one. A `/access` whose body cannot be read at all gets a 5xx,
 * which Arcade's `failure_mode: fail_closed` (set on #13) turns into a denial
 * of every tool the call was about; everything else gets a well-formed denying
 * response, because that is precise where a 5xx is blunt.
 *
 * The deadline is ours, inside Arcade's 5s. The handlers are synchronous CPU
 * work and cannot be interrupted, so the race guards the asynchronous part
 * (reading the body) and, more usefully, guarantees the *response* — a
 * handler that somehow ran long still produces a denial at the deadline rather
 * than an Arcade timeout, and the log line carries the duration so the slow
 * path is found rather than suspected.
 */
import type { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";

import {
  AccessHookRequest,
  HOOK_CONTRACT_VERSION,
  HOOK_ENDPOINT_PATHS,
  PostHookRequest,
  PreHookRequest,
  type AccessHookResult,
  type ErrorResponse,
  type GovernanceEvent,
  type HookPoint,
  type PreHookResult,
} from "@cg/policy-schema";

import { count as auditCount, newEventId, record } from "./audit-log.ts";
import type { HooksConfig } from "./config.ts";
import { withCorrelation } from "./correlation.ts";
import { handleAccess, handlePost, handlePre, type HandlerContext, type Outcome } from "./handlers.ts";
import type { PolicyCache } from "./policy-cache.ts";
import { counts } from "./policy-store.ts";

export const SERVICE = "hooks";

export interface ServerDeps {
  config: HooksConfig;
  db: Database;
  cache: PolicyCache;
  log?: (line: string) => void;
}

type HookPath = (typeof HOOK_ENDPOINT_PATHS)[keyof typeof HOOK_ENDPOINT_PATHS];

const HOOK_BY_PATH: Record<string, HookPoint> = {
  [HOOK_ENDPOINT_PATHS.accessHook]: "access",
  [HOOK_ENDPOINT_PATHS.preHook]: "pre",
  [HOOK_ENDPOINT_PATHS.postHook]: "post",
};

class Timeout extends Error {
  constructor(ms: number) {
    super(`hook did not answer within ${ms}ms`);
    this.name = "Timeout";
  }
}

export function createServer(deps: ServerDeps) {
  const { config, db, cache } = deps;
  const log = deps.log ?? ((line: string) => console.log(`[${SERVICE}] ${line}`));
  const ctx: HandlerContext = { now: () => new Date().toISOString(), newId: newEventId };

  const authorized = (request: Request): boolean => {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    // Hash both sides so lengths match, then compare in constant time.
    const digest = (s: string) => createHash("sha256").update(s).digest();
    return token.length > 0 && timingSafeEqual(digest(token), digest(config.signingSecret));
  };

  const json = (body: unknown, status = 200): Response => Response.json(body, { status });

  /**
   * Parse → handle, for one hook. Throws on anything it cannot turn into a
   * decision; `handleHook` below converts that into the fail-closed response.
   */
  const evaluate = (hook: HookPoint, body: unknown): Outcome<unknown> => {
    const state = cache.current();

    switch (hook) {
      case "access":
        return handleAccess(AccessHookRequest.parse(body), state, ctx);
      case "pre":
        return handlePre(PreHookRequest.parse(body), state, ctx);
      case "post":
        return handlePost(PostHookRequest.parse(body), ctx);
    }
  };

  /**
   * The net. Builds the denying response for `hook` and audits the failure,
   * using whatever of the raw body can be read to say who and what it was
   * about. Never throws: if even the audit write fails, the denial still goes
   * out and the log carries both errors.
   */
  const failClosed = (hook: HookPoint, raw: unknown, cause: unknown): Response => {
    const error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    const id = newEventId();
    const body = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const toolInfo = (body.tool ?? {}) as Record<string, unknown>;
    const context = (body.context ?? {}) as Record<string, unknown>;
    const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

    const tool =
      hook === "access"
        ? "*"
        : `${str(toolInfo.toolkit, "?")}.${str(toolInfo.name, "?")}`;
    const userId = hook === "access" ? str(body.user_id) : str(context.user_id);

    const reason =
      `FAIL-CLOSED: the control plane could not evaluate this ${hook} request (${error}). ` +
      `Do not retry ${tool}; report the reference to an administrator.`;

    const event: GovernanceEvent = {
      id,
      ts: ctx.now(),
      execution_id: str(body.execution_id),
      hook,
      user_id: userId,
      tool,
      decision: "deny",
      reason,
      rule_id: null,
    };
    try {
      record(db, [event]);
    } catch (auditCause) {
      log(`AUDIT WRITE FAILED while failing closed (${id}): ${String(auditCause)}`);
    }

    if (hook === "access") {
      // Deny everything the request named. If even that cannot be read, a 5xx
      // is the one signal left, and Arcade's fail_closed mode makes it a denial.
      const toolkits = AccessHookRequest.safeParse(body);
      if (toolkits.success) {
        const response: AccessHookResult = { deny: toolkits.data.toolkits };
        return json(response);
      }
      const response: ErrorResponse = { error: withCorrelation(reason, id), code: "CHECK_FAILED" };
      return json(response, 500);
    }

    const response: PreHookResult = {
      code: "CHECK_FAILED",
      error_message: withCorrelation(reason, id),
    };
    return json(response);
  };

  const withDeadline = <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Timeout(config.deadlineMs)), config.deadlineMs);
    });
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
  };

  const handleHook = async (hook: HookPoint, request: Request): Promise<Response> => {
    const started = performance.now();
    // Read the body once; the fail-closed path needs it for the audit row.
    let raw: unknown = null;
    let outcome: Outcome<unknown> | null = null;
    let response: Response;
    try {
      const text = await withDeadline(request.text());
      raw = text.length > 0 ? JSON.parse(text) : null;
      outcome = evaluate(hook, raw);
      // Recorded before the response leaves. A decision that was made but not
      // written is the one thing a reviewer cannot recover later.
      record(db, outcome.events);
      response = json(outcome.response);
    } catch (cause) {
      response = failClosed(hook, raw, cause);
      log(`${hook} FAILED CLOSED in ${Math.round(performance.now() - started)}ms: ${String(cause)}`);
    }

    const ms = (performance.now() - started).toFixed(1);
    if (outcome !== null) {
      const first = outcome.events[0];
      const summary =
        outcome.events.length === 1 && first
          ? `${first.user_id || "?"} ${first.tool} → ${first.decision}${first.rule_id ? ` (${first.rule_id})` : ""}`
          : `${outcome.events.length} decision(s)`;
      log(`${hook} ${response.status} ${ms}ms ${summary}`);
    }
    return response;
  };

  const health = (): Response => {
    const state = cache.current();
    const body = {
      // The generated HealthResponse vocabulary, so Arcade's periodic check
      // reads it; the rest is ours, for a human at the terminal.
      status: state.status === "ready" ? "healthy" : "unhealthy",
      service: SERVICE,
      hook_contract: HOOK_CONTRACT_VERSION,
      policy:
        state.status === "ready"
          ? { status: "ready", revision: state.revision, loaded_at: state.loaded_at }
          : { status: "failed", revision: state.revision, failed_at: state.failed_at, error: state.error },
      counts: counts(db),
      audit_rows: auditCount(db),
      failure_mode: "fail-closed",
    };
    return json(body, state.status === "ready" ? 200 : 503);
  };

  return Bun.serve({
    port: config.port,
    idleTimeout: 30,
    async fetch(request) {
      const { pathname } = new URL(request.url);

      if (pathname === HOOK_ENDPOINT_PATHS.healthCheck) {
        return request.method === "GET" ? health() : json({ error: "Method not allowed" }, 405);
      }

      const hook = HOOK_BY_PATH[pathname as HookPath];
      if (hook === undefined) return json({ error: "Not found" }, 404);
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      if (!authorized(request)) return json({ error: "Unauthorized" }, 401);

      return handleHook(hook, request);
    },
  });
}
