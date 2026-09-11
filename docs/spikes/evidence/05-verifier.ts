#!/usr/bin/env bun
/**
 * Spike 05 — a throwaway Arcade **custom user verifier** backed by `apps/idp`.
 *
 * Arcade's default verifier makes every end user sign in to an Arcade account
 * that is a member of the project. A custom verifier replaces that: Arcade sends
 * the browser to a route you own, you decide who the person is by whatever means
 * you like, and you post that identity back to Arcade server-side. This is that
 * route, wired to an OIDC login against `apps/idp`, run locally behind `ngrok`.
 *
 * Nothing here is deployed and nothing here belongs in `apps/`. It exists to
 * answer #75: does setting a custom verifier move the gateway login off
 * `account.arcade.dev` and onto our own IdP?
 *
 *   Arcade  ──303──▶  GET /verify?flow_id=…
 *                       │  start an authorization-code + PKCE login at the IdP
 *                       ▼
 *                     IdP /oauth2/authorize ─▶ /login ─▶ /consent
 *                       │
 *                       ▼
 *                     GET /callback?code&state
 *                       │  exchange the code, read `email` off /oauth2/userinfo
 *                       ▼
 *                     POST cloud.arcade.dev/api/v1/oauth/confirm_user
 *                       │  {flow_id, user_id: <email, lowercase>}
 *                       ▼
 *                     303 to the `next_uri` Arcade answers with
 *
 * ## Running it
 *
 *   IDP_CLIENT_ID=… IDP_CLIENT_SECRET=… \
 *   bun docs/spikes/evidence/05-verifier.ts
 *
 * It binds port **0** and reads the port back — never a guessed port, because
 * every worktree owns a different block — then spawns `ngrok` and prints the
 * public URL. Two values go to the human, both printed at startup:
 *
 *   1. `<public>/verify`   → Arcade dashboard, Auth → Settings → custom verifier
 *   2. `<public>/callback` → `IDP_OAUTH_REDIRECT_URIS` on the IdP
 *
 * ## The one manual step, and why
 *
 * `confirm_user` is authenticated with the Arcade **project API key**, which the
 * implementer of this spike does not hold and must not. So:
 *
 *   - with `ARCADE_API_KEY` set, the verifier calls `confirm_user` itself and the
 *     flow completes with no human in it. That is the production shape, and it is
 *     the code path a real deployment runs.
 *   - without it, the verifier prints the exact `curl` — real `flow_id`, real
 *     `user_id` — parks the browser on a waiting page, and resumes the moment
 *     someone posts the response back to `POST /confirm`. One human action per
 *     flow, and the human never has to read anything but the curl.
 *
 * Both paths run the same code after the response arrives, so the manual path is
 * not a different design; it is the same design with one call made by hand.
 */
import { b64url, pkce, redact } from "./05-drive.ts";

const ARCADE_CONFIRM_URL = process.env.ARCADE_CONFIRM_URL ?? "https://cloud.arcade.dev/api/v1/oauth/confirm_user";
const IDP_ISSUER = (process.env.IDP_ISSUER ?? "https://cg-idp-or5b.onrender.com").replace(/\/+$/, "");
const IDP_SCOPES = process.env.IDP_SCOPES ?? "openid email";
/** How long a browser parked on the waiting page will hold before giving up. */
const CONFIRM_TIMEOUT_MS = Number(process.env.CONFIRM_TIMEOUT_MS ?? 900_000);

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(
      `${name} is required.\n` +
        `  The IdP registers exactly one OAuth client, confidential, client_secret_post, and\n` +
        `  stores the secret hashed (#70) — so it cannot be read back, only rotated. Get the\n` +
        `  pair from whoever holds it and pass them in the environment; they are never printed\n` +
        `  by this process and never written to a file.`,
    );
    process.exit(2);
  }
  return value;
}

const CLIENT_ID = requireEnv("IDP_CLIENT_ID");
const CLIENT_SECRET = requireEnv("IDP_CLIENT_SECRET");
const ARCADE_API_KEY = process.env.ARCADE_API_KEY?.trim();

interface Flow {
  /** Everything Arcade put on the query string, so the transcript records the real contract. */
  arcadeQuery: Record<string, string>;
  flowId: string;
  verifier: string;
  startedAt: string;
  email?: string;
  confirm?: { auth_id?: string; next_uri?: string; [k: string]: unknown };
  resolve?: (response: Record<string, unknown>) => void;
}

/** state → flow. `state` is this verifier's CSRF token for the IdP leg, and its flow key. */
const flows = new Map<string, Flow>();
/** Every request Arcade or the IdP made, in order, for the transcript. */
const log: { at: string; line: string; detail?: unknown }[] = [];

function note(line: string, detail?: unknown) {
  const at = new Date().toISOString();
  log.push({ at, line, detail });
  console.log(`[verifier] ${line}${detail === undefined ? "" : ` ${redact(JSON.stringify(detail))}`}`);
}

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font:16px/1.5 system-ui;margin:4rem auto;max-width:34rem"><h1>${title}</h1>${body}</body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

let publicUrl = "";
const redirectUri = () => `${publicUrl}/callback`;

/**
 * Arcade's entry point. The query string is recorded whole rather than picking
 * `flow_id` out of it: what Arcade actually sends a verifier is one of the things
 * this spike is measuring, and a script that reads only the field it expected
 * would not notice the rest.
 */
async function verify(url: URL): Promise<Response> {
  const arcadeQuery = Object.fromEntries(url.searchParams);
  const flowId = url.searchParams.get("flow_id") ?? "";
  note(`GET /verify — Arcade sent ${Object.keys(arcadeQuery).length} parameter(s)`, arcadeQuery);
  if (!flowId) {
    note("no flow_id on the query string — refusing to start a login for a flow that does not exist");
    return page("No flow_id", "<p>Arcade calls this route with <code>?flow_id=…</code>.</p>", 400);
  }

  const { verifier, challenge } = await pkce();
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  flows.set(state, { arcadeQuery, flowId, verifier, startedAt: new Date().toISOString() });

  const authorize = `${IDP_ISSUER}/oauth2/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    scope: IDP_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })}`;
  note(`303 to the IdP for flow ${flowId}`, { issuer: IDP_ISSUER, redirect_uri: redirectUri(), scope: IDP_SCOPES });
  return new Response(null, { status: 303, headers: { Location: authorize } });
}

/** The IdP's return leg: code → token → `email`, then Arcade's `confirm_user`. */
async function callback(url: URL): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const flow = flows.get(state);
  if (!flow) {
    note("GET /callback with a state this verifier did not issue — dropping it");
    return page("Unknown state", "<p>This login did not start here.</p>", 400);
  }
  const error = url.searchParams.get("error");
  if (error) {
    note("the IdP returned an error", { error, error_description: url.searchParams.get("error_description") });
    return page("The IdP refused", `<pre>${error}: ${url.searchParams.get("error_description") ?? ""}</pre>`, 400);
  }
  const code = url.searchParams.get("code");
  if (!code) return page("No code", "<p>No authorization code on the callback.</p>", 400);

  const tokenRes = await fetch(`${IDP_ISSUER}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code_verifier: flow.verifier,
    }).toString(),
  });
  const tokenText = await tokenRes.text();
  note(`IdP token exchange -> ${tokenRes.status}`, redact(tokenText).slice(0, 400));
  if (!tokenRes.ok) return page("Token exchange failed", `<pre>${redact(tokenText)}</pre>`, 502);
  const token = JSON.parse(tokenText) as { access_token: string; id_token?: string };

  const userinfoRes = await fetch(`${IDP_ISSUER}/oauth2/userinfo`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  const userinfo = (await userinfoRes.json()) as { email?: string; sub?: string };
  note(`IdP /oauth2/userinfo -> ${userinfoRes.status}`, { sub: userinfo.sub, email: userinfo.email });
  if (!userinfo.email) return page("No email", "<p>The IdP returned no <code>email</code> claim.</p>", 502);

  // DESIGN.md rule 3: the Arcade user_id, the OAuth subject and the loan book's
  // actor are one string. Lowercase here as well as at the IdP, because this is
  // the value Arcade ends up holding.
  const userId = userinfo.email.toLowerCase();
  flow.email = userId;

  const confirmed = await confirmUser(flow, userId);
  if ("failed" in confirmed) return page("confirm_user failed", `<pre>${redact(confirmed.failed)}</pre>`, 502);

  flow.confirm = confirmed.response;
  const next = typeof confirmed.response.next_uri === "string" ? confirmed.response.next_uri : undefined;
  note("confirm_user answered", { auth_id: confirmed.response.auth_id, next_uri: next });
  if (!next) {
    return page("Verified", `<p>Confirmed <code>${userId}</code>. Arcade returned no <code>next_uri</code>.</p>`);
  }
  return new Response(null, { status: 303, headers: { Location: next } });
}

/**
 * The `confirm_user` call, made by whoever holds the API key.
 *
 * With a key in the environment this is one `fetch`. Without one it prints the
 * exact curl and waits for `POST /confirm` to hand the answer back. The caller
 * cannot tell the two apart, which is the point: the manual path is not a
 * different protocol.
 */
async function confirmUser(
  flow: Flow,
  userId: string,
): Promise<{ response: Record<string, unknown> } | { failed: string }> {
  const body = JSON.stringify({ flow_id: flow.flowId, user_id: userId });
  if (ARCADE_API_KEY) {
    const res = await fetch(ARCADE_CONFIRM_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${ARCADE_API_KEY}`, "content-type": "application/json" },
      body,
    });
    const text = await res.text();
    note(`POST confirm_user -> ${res.status}`, text.slice(0, 400));
    if (!res.ok) return { failed: `${res.status} ${text}` };
    return { response: JSON.parse(text) as Record<string, unknown> };
  }

  console.log(
    [
      "",
      "══════════════════════════════════════════════════════════════════════",
      "  ARCADE_API_KEY is not set. Run this, then paste the response back:",
      "",
      `  curl -sS -X POST ${ARCADE_CONFIRM_URL} \\`,
      '    -H "Authorization: Bearer $ARCADE_API_KEY" \\',
      '    -H "Content-Type: application/json" \\',
      `    -d '${body}'`,
      "",
      "  Then, from this machine:",
      "",
      `  curl -sS -X POST ${publicUrl || "http://localhost:<port>"}/confirm \\`,
      '    -H "Content-Type: application/json" \\',
      `    -d '{"flow_id":"${flow.flowId}","response":<the JSON body above>}'`,
      "══════════════════════════════════════════════════════════════════════",
      "",
    ].join("\n"),
  );
  note("parked, waiting for POST /confirm", { flow_id: flow.flowId, user_id: userId });

  const response = await new Promise<Record<string, unknown> | null>((resolve) => {
    flow.resolve = resolve as (r: Record<string, unknown>) => void;
    setTimeout(() => resolve(null), CONFIRM_TIMEOUT_MS);
  });
  if (!response) return { failed: `no POST /confirm within ${CONFIRM_TIMEOUT_MS}ms` };
  return { response };
}

/** Where the human's `confirm_user` response comes back in. Local use only. */
async function confirm(req: Request): Promise<Response> {
  const payload = (await req.json().catch(() => null)) as { flow_id?: string; response?: unknown } | null;
  if (!payload?.flow_id || typeof payload.response !== "object" || payload.response === null) {
    return Response.json({ error: "expected {flow_id, response}" }, { status: 400 });
  }
  const flow = [...flows.values()].find((f) => f.flowId === payload.flow_id);
  if (!flow?.resolve) return Response.json({ error: `no flow ${payload.flow_id} is waiting` }, { status: 404 });
  flow.resolve(payload.response as Record<string, unknown>);
  flow.resolve = undefined;
  note("POST /confirm resumed a parked flow", { flow_id: payload.flow_id });
  return Response.json({ resumed: payload.flow_id });
}

const server = Bun.serve({
  port: 0, // never claim a port another worktree owns
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/verify") return verify(url);
    if (url.pathname === "/callback") return callback(url);
    if (url.pathname === "/confirm" && req.method === "POST") return confirm(req);
    if (url.pathname === "/state") {
      return Response.json({
        public_url: publicUrl,
        issuer: IDP_ISSUER,
        arcade_api_key_present: Boolean(ARCADE_API_KEY),
        flows: [...flows.values()].map((f) => ({
          flow_id: f.flowId,
          started_at: f.startedAt,
          arcade_query: f.arcadeQuery,
          email: f.email,
          confirm: f.confirm,
          waiting: Boolean(f.resolve),
        })),
        log,
      });
    }
    if (url.pathname === "/health") return Response.json({ status: "ok", public_url: publicUrl });
    note(`${req.method} ${url.pathname} — no route`);
    return page("Not found", `<p>This verifier serves <code>/verify</code> and <code>/callback</code>.</p>`, 404);
  },
});

/**
 * Put the local port on the public internet.
 *
 * Arcade has to reach `/verify` and the IdP has to reach `/callback`, so a
 * loopback port is not enough — spike #2 used `ngrok` for the same reason. The
 * URL is read out of ngrok's own JSON log rather than guessed or scraped from
 * its inspector, which binds a fixed port this worktree does not own.
 */
async function startNgrok(port: number): Promise<string> {
  const proc = Bun.spawn(["ngrok", "http", String(port), "--log", "stdout", "--log-format", "json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 30_000;
  let buffer = "";
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      let entry: Record<string, string>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.lvl === "eror" || entry.err) console.error(`[ngrok] ${line}`);
      const url = entry.url ?? entry.addr;
      if (entry.msg === "started tunnel" && url?.startsWith("https://")) {
        // Drain the rest in the background so ngrok's pipe never fills and blocks it.
        void (async () => {
          try {
            while (true) {
              const { done } = await reader.read();
              if (done) break;
            }
          } catch {
            /* the process went away */
          }
        })();
        return url;
      }
    }
  }
  throw new Error("ngrok did not report a tunnel within 30s");
}

publicUrl = process.env.VERIFIER_PUBLIC_URL?.replace(/\/+$/, "") ?? (await startNgrok(server.port));

console.log(
  [
    "",
    `spike 05 verifier — local :${server.port}, public ${publicUrl}`,
    `  IdP issuer         ${IDP_ISSUER}`,
    `  IdP client         ${CLIENT_ID}`,
    `  confirm_user       ${ARCADE_API_KEY ? "automatic (ARCADE_API_KEY is set)" : "manual — the curl is printed per flow"}`,
    "",
    "  Two values for the human:",
    `    Arcade dashboard, Auth → Settings → custom verifier :  ${publicUrl}/verify`,
    `    IdP IDP_OAUTH_REDIRECT_URIS, one more entry         :  ${publicUrl}/callback`,
    "",
    `  What it has seen so far:  curl -s ${publicUrl}/state | jq`,
    "",
  ].join("\n"),
);
