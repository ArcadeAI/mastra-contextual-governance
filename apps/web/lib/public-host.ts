/**
 * The address of a dependency, checked where the environment is read rather
 * than when the browser fails to open a stream.
 *
 * `render.yaml` used to derive every cross-service address with
 * `fromService … property: host`. Measured on 2026-09-10 (#59): Render emits
 * the **bare service name**, never the FQDN — `IDP_PUBLIC_HOST` arrived on
 * `cg-loan-app` as `cg-idp-or5b`. Consumers prepend a scheme and nothing else,
 * so the request went to `https://cg-idp-or5b/oauth2/userinfo`, DNS failed, and
 * the caller reported a network error that read as "the dependency is down"
 * when the dependency was healthy and the URL was malformed.
 *
 * This service holds `HOOKS_PUBLIC_HOST`, and it is the worst of the three to
 * get wrong: the panel opens `GET /events` from the *browser*, so a bare name
 * fails in somebody else's DevTools console rather than in a server log.
 *
 * The three cross-service keys are `sync: false` now and typed in by hand per
 * environment, which means a human can type a bare name too.
 *
 * `apps/loan-app/src/public-host.ts` and `apps/hooks/src/public-host.ts` carry the same
 * check, written out rather than shared: `apps/loan-app` depends on nothing
 * outside itself on purpose — it is the part a forker throws away. All three
 * test files run the same table of cases, so a copy that drifts fails its own
 * suite.
 */

/** A `*_PUBLIC_HOST` that cannot resolve. Its own class, so a caller can tell it apart. */
export class PublicHostError extends Error {}

/** `host` or `host:port` → the host part, with any IPv6 brackets taken off. */
function hostnameOf(value: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) return bracketed[1] as string;

  const withPort = /^(.+):(\d+)$/.exec(value);
  return withPort ? (withPort[1] as string) : value;
}

/**
 * Refuse a bare name: no dot, and not a loopback address. That is exactly the
 * shape `fromService` produced, and exactly what a hand-typed `cg-idp` would
 * produce again.
 *
 * Unset is not an error. Every consumer carries a localhost default, and a
 * local run configures nothing.
 */
export function assertPublicHost(name: string, value: string | undefined): void {
  const host = value?.trim();
  if (!host) return;

  const hostname = hostnameOf(host);
  if (hostname.includes(".") || hostname.includes(":") || hostname === "localhost") return;

  throw new PublicHostError(
    `${name}=${host} is a bare service name, not a hostname — nothing addressed through it ` +
      "can resolve, and the failure would surface later as a network error against a healthy " +
      "dependency. Read the value off that service's page in the Render dashboard (the host " +
      "part of the URL shown there) and set it by hand; the key is `sync: false` for this " +
      "reason. Never derive or guess it: onrender.com subdomains are global, so Render " +
      "silently suffixes a name that is taken — cg-web is cg-web-sa31 and cg-idp is " +
      "cg-idp-or5b.",
  );
}

/** `value`, or `fallback` when unset. Throws `PublicHostError` on a bare name. */
export function publicHost(name: string, value: string | undefined, fallback: string): string {
  assertPublicHost(name, value);
  return value?.trim() || fallback;
}
