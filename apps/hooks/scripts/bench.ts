/**
 * Measures hook latency rather than hoping. Boots the real server on a random
 * port against an in-memory database and times, over HTTP:
 *
 *   - /access with the whole-project catalogue spike #2 measured (~1.6 MB)
 *   - /access scoped to the one governed toolkit
 *   - /pre for a denial and an allow
 *
 * Arcade's hook timeout is 5s. The number to watch is the 1.6 MB p95.
 *
 *   bun run --cwd apps/hooks bench
 */
import { createPolicyCache } from "../src/policy-cache.ts";
import { openGovernance } from "../src/policy-store.ts";
import { createServer } from "../src/server.ts";

const SECRET = "bench";
const SAM = "sam.reyes@bank.example";
const DANA = "dana.okafor@bank.example";
const V = [{ version: "1.0.0" }];
const LOAN_TOOLS = { SearchLoans: V, GetLoan: V, ApproveLoan: V, DenyLoan: V };

const db = openGovernance(":memory:", { loanToolkit: "Loan", approvalsToolkit: "Approvals", personaEmails: {} });
const cache = createPolicyCache(db);
cache.start();
const server = createServer({
  config: { port: 0, dbPath: ":memory:", signingSecret: SECRET, loanToolkit: "Loan", approvalsToolkit: "Approvals", personaEmails: {}, deadlineMs: 2500, policyPollMs: 250 },
  db,
  cache,
  log: () => {},
});
const base = `http://localhost:${server.port}`;

function bigCatalogue(targetBytes: number) {
  const toolkits: Record<string, unknown> = { Loan: { tools: LOAN_TOOLS } };
  let bytes = 0;
  for (let t = 0; bytes < targetBytes; t++) {
    const tools: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      tools[`Tool${i}WithALongerNameLikeArcadeUses`] = [
        { version: "1.0.0", requirements: { authorization: [{ provider_id: "prov", oauth2: { scopes: ["a", "b"] } }] } },
      ];
    }
    toolkits[`Toolkit${t}`] = { tools };
    bytes = JSON.stringify(toolkits).length;
  }
  return { bytes, toolkits };
}

async function time(label: string, path: string, body: unknown, runs: number) {
  const payload = JSON.stringify(body);
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: payload,
    });
    await res.arrayBuffer();
    if (res.status !== 200) throw new Error(`${label}: HTTP ${res.status}`);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const q = (p: number) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))]!.toFixed(1);
  console.log(
    `${label.padEnd(34)} ${(payload.length / 1024).toFixed(0).padStart(5)} KB  ` +
      `p50 ${q(0.5).padStart(7)}ms  p95 ${q(0.95).padStart(7)}ms  max ${q(1).padStart(7)}ms  (n=${runs})`,
  );
}

const { bytes, toolkits } = bigCatalogue(1_600_000);
console.log(`whole-project catalogue: ${Object.keys(toolkits).length} toolkits, ${(bytes / 1024 / 1024).toFixed(2)} MB\n`);

await time("/access whole-project catalogue", "/access", { user_id: SAM, toolkits }, 20);
await time("/access scoped to Loan", "/access", { user_id: SAM, toolkits: { Loan: { tools: LOAN_TOOLS } } }, 200);
await time("/pre deny (act 2)", "/pre", {
  execution_id: "tc_bench",
  tool: { name: "ApproveLoan", toolkit: "Loan", version: "1.0.0" },
  inputs: { loan_id: "LN-2291", amount: 95_000 },
  context: { authorization: [{}], user_id: DANA },
}, 200);
await time("/pre allow", "/pre", {
  execution_id: "tc_bench",
  tool: { name: "GetLoan", toolkit: "Loan", version: "1.0.0" },
  inputs: { loan_id: "LN-2291" },
  context: { authorization: [{}], user_id: DANA },
}, 200);

console.log(`\naudit rows written: ${db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_log").get()?.n}`);
cache.stop();
server.stop(true);
db.close();
