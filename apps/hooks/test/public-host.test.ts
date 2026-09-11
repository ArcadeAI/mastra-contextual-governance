/**
 * A cross-service address this service cannot possibly reach is a startup
 * failure.
 *
 * The measurement behind it is #59: `render.yaml` derived every cross-service
 * host with `fromService … property: host`, and Render emitted the bare service
 * name — `IDP_PUBLIC_HOST` on `cg-loan-app` was `cg-idp-or5b`, not
 * `cg-idp-or5b.onrender.com`. Consumers prepend a scheme and nothing else, so
 * the request went somewhere DNS cannot resolve and surfaced as "the dependency
 * could not be reached" against a dependency that was up.
 *
 * `LOAN_APP_PUBLIC_HOST` is this service's copy of that defect. Nothing here
 * reads it yet — #16's redaction work is the first consumer — which is exactly
 * why boot is the right place to say so: the value is wrong from the moment it
 * is set, and the alternative is finding out during the first pass that needs
 * the loan book.
 *
 * The table below is shared, verbatim, with
 * `apps/loan-app/test/public-host.test.ts` and `apps/web/test/public-host.test.ts`
 * — the three copies of the check are written out rather than imported, so each
 * one is pinned by its own suite.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readConfig } from "../src/config.ts";
import { assertPublicHost, PublicHostError } from "../src/public-host.ts";

/** Values a consumer can actually reach, or is free to leave unset. */
const ACCEPTED = [
  "localhost",
  "localhost:8082",
  "  localhost:8082  ",
  "127.0.0.1:4412",
  "[::1]:4412",
  "cg-loan-app.onrender.com",
  "cg-web-sa31.onrender.com",
  "example.test",
];

/** Bare service names: what `fromService` produced, and what a hand-typed key produces. */
const REFUSED = ["cg-idp", "cg-idp-or5b", "cg-loan-app", "cg-web-sa31", "cg-loan-app:8080"];

test.each(ACCEPTED)("%p is a host something can resolve", (value) => {
  expect(() => assertPublicHost("LOAN_APP_PUBLIC_HOST", value)).not.toThrow();
});

test.each([undefined, "", "   "])("%p is not an error; consumers have defaults", (value) => {
  expect(() => assertPublicHost("LOAN_APP_PUBLIC_HOST", value)).not.toThrow();
});

test.each(REFUSED)("%p is refused: it is a service name, not a hostname", (value) => {
  expect(() => assertPublicHost("LOAN_APP_PUBLIC_HOST", value)).toThrow(PublicHostError);
});

test("the refusal names the variable, its value, and where the real one comes from", () => {
  // The whole worth of this check is the message: whoever reads it is about to
  // go and find the right string, and the right string is on one specific page.
  try {
    assertPublicHost("LOAN_APP_PUBLIC_HOST", "cg-loan-app");
    throw new Error("expected a refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(PublicHostError);
    const { message } = cause as Error;
    expect(message).toContain("LOAN_APP_PUBLIC_HOST=cg-loan-app");
    expect(message).toContain("Render dashboard");
    expect(message).toContain("cg-web-sa31");
  }
});

/**
 * Through `readConfig`, which is this service's one environment read. A check
 * living anywhere else could be bypassed by the next caller that reads the
 * variable directly.
 */
test("readConfig refuses a bare service name, and passes a hostname through", () => {
  expect(() => readConfig({ LOAN_APP_PUBLIC_HOST: "cg-loan-app" })).toThrow(PublicHostError);
  expect(() => readConfig({ LOAN_APP_PUBLIC_HOST: "cg-loan-app.onrender.com" })).not.toThrow();
  expect(() => readConfig({})).not.toThrow();
});

/**
 * Through the service's real entry point, because the check is only worth
 * anything if it runs before the port opens. Exit status, not just stderr: a
 * boot that printed this and then served anyway would pass a message-only
 * assertion, and would be the #59 failure with a warning attached.
 */
test("the control plane refuses to start on a bare service name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-public-host-"));

  try {
    const child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "index.ts")], {
      env: {
        ...process.env,
        PORT: "0",
        GOVERNANCE_DB_PATH: join(dir, "governance.db"),
        LOAN_APP_PUBLIC_HOST: "cg-loan-app",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const status = await child.exited;
    const stderr = await new Response(child.stderr as ReadableStream).text();

    // 78 is sysexits' EX_CONFIG, the same status `apps/loan-app/scripts/dev-idp.ts` uses.
    expect(status).toBe(78);
    expect(stderr).toContain("LOAN_APP_PUBLIC_HOST=cg-loan-app");
    expect(stderr).toContain("Render dashboard");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

/**
 * The other half. Every configuration error that was fatal before this slice is
 * still fatal, and still fails the way it did — `orExitConfig` narrows on
 * `PublicHostError` and re-throws anything else.
 */
test("an unrelated configuration error still fails, and not as EX_CONFIG", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-public-host-"));

  try {
    const child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "index.ts")], {
      env: {
        ...process.env,
        PORT: "0",
        NODE_ENV: "production",
        GOVERNANCE_DB_PATH: join(dir, "governance.db"),
        ARCADE_HOOK_SIGNING_SECRET: "",
        LOAN_APP_PUBLIC_HOST: "cg-loan-app.onrender.com",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const status = await child.exited;
    const stderr = await new Response(child.stderr as ReadableStream).text();

    expect(status).not.toBe(0);
    expect(status).not.toBe(78);
    expect(stderr).toContain("ARCADE_HOOK_SIGNING_SECRET is required in production");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
