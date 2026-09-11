/**
 * Spike 05 shared plumbing: a browserless user agent, and the bits of OAuth
 * both 05 scripts need.
 *
 * This is spike 04's `04-oauth-drive.ts` carried forward with one bug fixed and
 * one capability added. It is a separate file rather than an import because #65
 * and #75 are two unmerged branches and a spike script that only runs once its
 * sibling PR lands is a script nobody re-runs. Fold the two into one helper when
 * both are on `main`.
 *
 * **The fix.** `parseForm` read `value="…"` straight out of the HTML without
 * undoing entity escaping. Spike 04 never noticed: its chain stopped at
 * `account.arcade.dev` and never submitted a form to `apps/idp` at all. Every
 * `apps/idp` login page carries a hidden `oauth_query` field holding the signed
 * authorize query, ampersands and all, HTML-escaped as `&amp;`. Post it back
 * unescaped and Better Auth's before-hook rejects the signature and the page
 * says *"That email and password did not match."* — the password was right. Two
 * hours of this spike went into that sentence, so: `unescapeHtml` on every form
 * value and on the action.
 *
 * **The addition.** `driveAuthorize` now takes a set of hosts it is allowed to
 * type a password into, not a single expected host, because a flow that runs
 * through a custom verifier legitimately renders pages on two: the verifier's
 * own tunnel and the IdP behind it.
 */

/** Anything that looks like a secret, gone before it reaches a transcript. */
export function redact(text: string): string {
  return text
    .replace(
      /("(?:access_token|refresh_token|id_token|code|client_secret|password|code_verifier|api_key)"\s*:\s*")([^"]{8,})"/g,
      '$1<redacted>"',
    )
    .replace(/\b(code|client_secret|password|access_token|id_token|refresh_token)=([^&\s"]{8,})/g, "$1=<redacted>");
}

export class Transcript {
  private step = 0;
  hop(title: string, detail?: unknown) {
    this.step += 1;
    console.log(`\n─── ${String(this.step).padStart(2, "0")} ${title}`);
    if (detail !== undefined) {
      console.log(redact(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)));
    }
  }
}

/**
 * A browser's cookie jar, scoped the way a browser scopes them.
 *
 * Spike 04's jar was one flat map for every host. That is wrong in a way that
 * matters here: this spike needs to be able to say whether the IdP session from
 * the verifier's login was **reused** by the tool's own OAuth (#75 question 3),
 * and a jar that hands every cookie to every host cannot tell the difference.
 *
 * It is also wrong in the other direction if you scope by host alone. Ory sets
 * `Domain=.arcade.dev`, so `auth.arcade.dev` and `account.arcade.dev` share a
 * session; a host-keyed jar sends nothing between them and Arcade's own login
 * spins in a redirect loop forever, creating a new flow id every hop. Measured.
 * So: honour the `Domain` attribute, exactly as a browser does.
 */
export class Jar {
  /** One entry per (domain, name). `domain` has no leading dot; `hostOnly` means exact match. */
  private cookies = new Map<string, { domain: string; hostOnly: boolean; name: string; value: string }>();

  store(requestHost: string, res: Response) {
    for (const raw of res.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const domainAttr = attrs
        .map((a) => a.trim())
        .find((a) => a.toLowerCase().startsWith("domain="))
        ?.slice("domain=".length)
        .trim()
        .replace(/^\./, "")
        .toLowerCase();
      const domain = domainAttr || requestHost.split(":")[0].toLowerCase();
      this.cookies.set(`${domain}|${name}`, { domain, hostOnly: !domainAttr, name, value });
    }
  }

  /** A browser's domain match: exact, or a dot-suffix of a cookie that named a domain. */
  private matching(host: string) {
    const hostname = host.split(":")[0].toLowerCase();
    return [...this.cookies.values()].filter((c) =>
      c.hostOnly ? c.domain === hostname : hostname === c.domain || hostname.endsWith(`.${c.domain}`),
    );
  }

  header(host: string): string {
    return this.matching(host)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  /** Which domains this jar holds a cookie for — question 3 is "was the IdP session reused?". */
  hosts(): string[] {
    return [...new Set([...this.cookies.values()].map((c) => (c.hostOnly ? c.domain : `.${c.domain}`)))].sort();
  }

  /** One request, no automatic redirect following, cookies in and out. */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const host = new URL(url).host;
    const headers = new Headers(init.headers);
    const cookie = this.header(host);
    if (cookie) headers.set("cookie", cookie);
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    this.store(host, res);
    return res;
  }
}

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

export function stripQuery(url: string): string {
  return url.split("?")[0];
}

export function redactQuery(url: string): string {
  return url.replace(/(code|id_token|access_token|login_challenge|consent_challenge|sig)=[^&]+/g, "$1=<redacted>");
}

/** Undo the escaping a server-rendered HTML attribute went through. See the header note. */
export function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export interface ParsedForm {
  action: string;
  fields: Record<string, string>;
}

/** The IdP's pages are server-rendered HTML with one form; a regex parse is enough. */
export function parseForm(html: string): ParsedForm | null {
  const form = /<form\b[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!form) return null;
  const action = unescapeHtml(/\baction\s*=\s*["']([^"']*)["']/i.exec(form[0])?.[1] ?? "");
  const fields: Record<string, string> = {};
  for (const match of form[1].matchAll(/<(?:input|button|textarea)\b[^>]*>/gi)) {
    const tag = match[0];
    const name = /\bname\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (!name) continue;
    fields[name] = unescapeHtml(/\bvalue\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "");
  }
  return { action, fields };
}

export interface DriveResult {
  /** Every hop, in order, as `status METHOD url`. */
  visited: string[];
  /** Pages a human would have had to look at — the round-trip count question 3 asks for. */
  pagesShown: number;
  /** Hosts that rendered a page, in order: which IdP actually authenticated the user. */
  pageHosts: string[];
  /** The URL the chain ended on, if it never reached the redirect URI. */
  stoppedAt?: string;
  /** Why it stopped, when it stopped early. */
  stoppedBecause?: string;
}

export interface Persona {
  email: string;
  password: string;
}

/**
 * Walk an authorization chain to completion, filling in whatever forms appear.
 *
 * Stops the moment the chain reaches `redirectUri` — the caller's loopback server
 * has the code by then.
 *
 * `trustedPageHosts` is the guard spike 04 wrote and this one keeps: **it will
 * not type a persona's password into a host that is not on the list.** It stops,
 * names the host that served the page, and the caller reports it. A spike that
 * quietly submits credentials to whatever rendered a form measures nothing and
 * risks something.
 */
export async function driveAuthorize(
  authorizeUrl: string,
  redirectUri: string,
  persona: Persona,
  transcript: Transcript,
  options: { trustedPageHosts?: string[]; jar?: Jar; onPage?: (host: string, url: string, html: string) => void } = {},
): Promise<DriveResult> {
  const jar = options.jar ?? new Jar();
  let url = authorizeUrl;
  const visited: string[] = [];
  const pageHosts: string[] = [];
  let pagesShown = 0;

  for (let i = 0; i < 30; i += 1) {
    if (url.startsWith(redirectUri)) {
      transcript.hop("the chain lands back on the redirect URI", redactQuery(url));
      return { visited, pagesShown, pageHosts };
    }

    const res = await jar.fetch(url, { headers: { accept: "text/html" } });
    visited.push(`${res.status} GET ${stripQuery(url)}`);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`${res.status} with no Location at ${stripQuery(url)}`);
      const next = new URL(location, url).toString();
      transcript.hop(`${res.status} ${stripQuery(url)} -> ${stripQuery(next)}`, redactQuery(next));
      url = next;
      continue;
    }

    const html = await res.text();
    const host = new URL(url).host;
    options.onPage?.(host, url, html);
    const form = parseForm(html);
    if (!form) {
      transcript.hop(`${res.status} ${stripQuery(url)} — a page with no form, the chain stops here`, html.slice(0, 800));
      return { visited, pagesShown, pageHosts, stoppedAt: url, stoppedBecause: "a page with no form" };
    }

    pagesShown += 1;
    pageHosts.push(host);
    if (options.trustedPageHosts && !options.trustedPageHosts.includes(host)) {
      transcript.hop(
        `page ${pagesShown}: ${host} rendered a form, and it is not one of ${options.trustedPageHosts.join(", ")} — stopping`,
        { action: new URL(form.action || url, url).toString(), fields: Object.keys(form.fields) },
      );
      return {
        visited,
        pagesShown,
        pageHosts,
        stoppedAt: url,
        stoppedBecause: `${host} is not a host this spike will type a password into`,
      };
    }

    const action = new URL(form.action || url, url).toString();
    const body = new URLSearchParams(form.fields);
    const identifier = "email" in form.fields ? "email" : "username" in form.fields ? "username" : undefined;
    if (identifier) {
      body.set(identifier, persona.email);
      body.set("password", persona.password);
      transcript.hop(`page ${pagesShown}: login at ${stripQuery(url)}`, { action, fields: Object.keys(form.fields) });
    } else {
      transcript.hop(`page ${pagesShown}: consent at ${stripQuery(url)}`, { action, fields: Object.keys(form.fields) });
    }

    const post = await jar.fetch(action, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: body.toString(),
    });
    visited.push(`${post.status} POST ${stripQuery(action)}`);
    const location = post.headers.get("location");
    if (!location) {
      const text = await post.text();
      transcript.hop(`POST ${stripQuery(action)} answered ${post.status} with no Location`, text.slice(0, 800));
      return { visited, pagesShown, pageHosts, stoppedAt: action, stoppedBecause: `${post.status} with no Location` };
    }
    url = new URL(location, action).toString();
  }
  throw new Error("the authorization chain did not terminate in 30 hops");
}

/** A loopback listener for the authorization code. Binds port 0 and reads the port back. */
export function startCallbackServer() {
  let resolve!: (params: URLSearchParams) => void;
  const captured = new Promise<URLSearchParams>((r) => {
    resolve = r;
  });
  const server = Bun.serve({
    port: 0, // never claim a port another worktree owns
    fetch(req) {
      const url = new URL(req.url);
      resolve(url.searchParams);
      return new Response("spike 05: authorization code captured.", { headers: { "content-type": "text/plain" } });
    },
  });
  return { server, captured, redirectUri: `http://localhost:${server.port}/callback` };
}

/** Minimal MCP-over-streamable-HTTP client: enough for initialize, tools/list, tools/call. */
export class McpProbe {
  sessionId?: string;
  constructor(private url: string) {}

  async send(token: string | undefined, body: unknown) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(body) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    const text = await res.text();
    // Streamable HTTP may answer with an SSE frame rather than bare JSON.
    const payload = /^(event|data|id|:):?/m.test(text)
      ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
      : text;
    let json: any;
    try {
      json = JSON.parse(payload);
    } catch {
      /* not JSON; the caller prints the raw text */
    }
    return { status: res.status, text, json, wwwAuthenticate: res.headers.get("www-authenticate") };
  }
}

/**
 * Replay the hook server's log and return the frames produced since `startedAt`.
 *
 * `last-event-id: 0` replays from the beginning (#62), which is a lot of rows, so
 * this filters by timestamp and gives up once a `/pre` frame arrives.
 */
export async function framesSince(hooksUrl: string, startedAt: number, timeoutMs = 60_000): Promise<any[]> {
  const res = await fetch(`${hooksUrl}/events`, { headers: { "last-event-id": "0" } });
  if (!res.ok || !res.body) throw new Error(`GET ${hooksUrl}/events -> ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames: any[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          const frame = JSON.parse(line.slice(5).trim());
          if (Date.parse(frame.ts) >= startedAt) frames.push(frame);
        } catch {
          /* a comment or keep-alive */
        }
      }
      if (frames.some((f) => f.hook === "pre")) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return frames;
}

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required. Persona addresses live in Render env vars, never in git.`);
    process.exit(2);
  }
  return value;
}
