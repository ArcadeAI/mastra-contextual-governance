/**
 * A cross-service address this service cannot possibly reach is refused where
 * the environment is read, not when the browser fails to open a stream.
 *
 * The measurement behind it is #59: `render.yaml` derived every cross-service
 * host with `fromService … property: host`, and Render emitted the bare service
 * name — `IDP_PUBLIC_HOST` on `cg-loan-app` was `cg-idp-or5b`, not
 * `cg-idp-or5b.onrender.com`. Consumers prepend a scheme and nothing else, so
 * the request went somewhere DNS cannot resolve.
 *
 * `HOOKS_PUBLIC_HOST` is the worst of the three to get wrong, because the panel
 * opens `GET /events` from the browser: the failure would land in a visitor's
 * DevTools console, where nobody running the demo is looking.
 *
 * The table below is shared, verbatim, with
 * `apps/loan-app/test/public-host.test.ts` and `apps/hooks/test/public-host.test.ts`
 * — the three copies of the check are written out rather than imported, so each
 * one is pinned by its own suite.
 */
import { expect, test } from "bun:test";

import { readWebConfig } from "../lib/config.ts";
import { governanceStreamSource } from "../lib/governance/stream-url.ts";
import { assertPublicHost, publicHost, PublicHostError } from "../lib/public-host.ts";

/** Values a consumer can actually reach, or is free to leave unset. */
const ACCEPTED = [
  "localhost",
  "localhost:8081",
  "  localhost:8081  ",
  "127.0.0.1:4421",
  "[::1]:4421",
  "cg-hooks.onrender.com",
  "cg-web-sa31.onrender.com",
  "example.test",
];

/** Bare service names: what `fromService` produced, and what a hand-typed key produces. */
const REFUSED = ["cg-idp", "cg-idp-or5b", "cg-loan-app", "cg-web-sa31", "cg-loan-app:8080"];

test.each(ACCEPTED)("%p is a host something can resolve", (value) => {
  expect(() => assertPublicHost("HOOKS_PUBLIC_HOST", value)).not.toThrow();
});

test.each([undefined, "", "   "])("%p is not an error; consumers have defaults", (value) => {
  expect(() => assertPublicHost("HOOKS_PUBLIC_HOST", value)).not.toThrow();
  expect(publicHost("HOOKS_PUBLIC_HOST", value, "localhost:8081")).toBe("localhost:8081");
});

test.each(REFUSED)("%p is refused: it is a service name, not a hostname", (value) => {
  expect(() => assertPublicHost("HOOKS_PUBLIC_HOST", value)).toThrow(PublicHostError);
});

test("the refusal names the variable, its value, and where the real one comes from", () => {
  // The whole worth of this check is the message: whoever reads it is about to
  // go and find the right string, and the right string is on one specific page.
  try {
    assertPublicHost("HOOKS_PUBLIC_HOST", "cg-hooks");
    throw new Error("expected a refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(PublicHostError);
    const { message } = cause as Error;
    expect(message).toContain("HOOKS_PUBLIC_HOST=cg-hooks");
    expect(message).toContain("Render dashboard");
    expect(message).toContain("cg-web-sa31");
  }
});

test("readWebConfig refuses a bare service name, and passes a hostname through", () => {
  expect(() => readWebConfig({ HOOKS_PUBLIC_HOST: "cg-hooks" })).toThrow(PublicHostError);
  expect(readWebConfig({ HOOKS_PUBLIC_HOST: "cg-hooks.onrender.com" }).hooksHost).toBe(
    "cg-hooks.onrender.com",
  );
  expect(readWebConfig({}).hooksHost).toBe("localhost:8081");
});

/**
 * The stream address is worked out in `stream-url.ts`, which reads the variable
 * itself rather than going through `readWebConfig` — so it needs its own check,
 * or the one path that hands this host to a browser is the one path with no
 * check on it.
 *
 * Refused in *either* mode, deliberately. A bare name is wrong the moment it is
 * set, and letting the fixture default swallow it would leave the panel looking
 * fine on a deployment that cannot reach the control plane at all.
 */
test("the panel's stream source refuses a bare service name in either mode", () => {
  expect(() => governanceStreamSource({ HOOKS_PUBLIC_HOST: "cg-hooks" })).toThrow(PublicHostError);
  expect(() =>
    governanceStreamSource({ GOVERNANCE_STREAM: "hooks", HOOKS_PUBLIC_HOST: "cg-hooks" }),
  ).toThrow(PublicHostError);

  const live = governanceStreamSource({
    GOVERNANCE_STREAM: "hooks",
    HOOKS_PUBLIC_HOST: "cg-hooks.onrender.com",
  });
  expect(live.url).toBe("https://cg-hooks.onrender.com/events");
  expect(governanceStreamSource({}).mode).toBe("fixture");
});
