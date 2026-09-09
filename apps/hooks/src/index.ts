/**
 * The control plane. Owns `governance.db`, serves Arcade's `/access`, `/pre`
 * and `/post` hooks, and records every decision it makes.
 *
 *     POST /access   which tools this user may see        → { deny }
 *     POST /pre      may this user make this call          → { code, error_message? }
 *     POST /post     pass-through until #16                → { code }
 *     GET  /health   policy revision, counts, fail-closed  (no auth)
 *
 * Boot order matters: the policy is loaded into memory *before* the port
 * opens, so the first `/access` Arcade sends — possibly the 1.6 MB one — is
 * served from a warm cache. A policy that fails to load does not stop the
 * service from starting; it starts failing closed, says so on `/health` with
 * a 503, and reloads on the next edit.
 */
import { usingDevSecret, readConfig } from "./config.ts";
import { createPolicyCache } from "./policy-cache.ts";
import { counts, openGovernance } from "./policy-store.ts";
import { createServer, SERVICE } from "./server.ts";

const log = (line: string) => console.log(`[${SERVICE}] ${line}`);

const config = readConfig();
const db = openGovernance(config.dbPath, config);
const cache = createPolicyCache(db, log);
const state = cache.reload();

const server = createServer({ config, db, cache, log });

const tally = counts(db);
log(
  `listening on :${server.port} — ${config.dbPath}: ${tally.subjects} subjects, ` +
    `${tally.policy_rules} rules, ${tally.audit_log} audit rows; ` +
    `toolkits ${config.loanToolkit}, ${config.approvalsToolkit}`,
);
if (state.status === "failed") log(`STARTED FAIL-CLOSED: ${state.error}`);
if (usingDevSecret(config)) {
  log("ARCADE_HOOK_SIGNING_SECRET is unset — using the development token. Not for production.");
}
