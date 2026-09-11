/**
 * A dependency address this service cannot possibly reach is a startup failure.
 *
 * The measurement behind it is #59: `render.yaml` derived `IDP_PUBLIC_HOST`
 * with `fromService … property: host`, and Render emitted the bare service name
 * `cg-idp-or5b` rather than `cg-idp-or5b.onrender.com`. `actor.ts` prepends a
 * scheme and nothing else, so every userinfo call went to a name DNS cannot
 * resolve and the API answered 503 "the identity provider could not be
 * reached" — true of the URL, false of the provider, and the reason step 7.1 of
 * the #13 sitting went looking at a healthy service.
 *
 * The three keys are `sync: false` now, which moves the value from a wrong
 * derivation to a human's hands. This is what stops the same string arriving
 * that way again.
 *
 * The table below is shared, verbatim, with `apps/hooks/test/public-host.test.ts`
 * and `apps/web/test/public-host.test.ts` — the three copies of the check are
 * written out rather than imported, so each one is pinned by its own suite.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertPublicHost, publicHost, PublicHostError } from "../src/public-host.ts";

/** Values a consumer can actually reach, or is free to leave unset. */
const ACCEPTED = [
  "localhost",
  "localhost:8083",
  "  localhost:8083  ",
  "127.0.0.1:4413",
  "[::1]:4413",
  "cg-idp-or5b.onrender.com",
  "cg-web-sa31.onrender.com",
  "example.test",
];

/** Bare service names: what `fromService` produced, and what a hand-typed key produces. */
const REFUSED = ["cg-idp", "cg-idp-or5b", "cg-loan-app", "cg-web-sa31", "cg-loan-app:8080"];

test.each(ACCEPTED)("%p is a host something can resolve", (value) => {
  expect(() => assertPublicHost("IDP_PUBLIC_HOST", value)).not.toThrow();
});

test.each([undefined, "", "   "])("%p is not an error; consumers have defaults", (value) => {
  expect(() => assertPublicHost("IDP_PUBLIC_HOST", value)).not.toThrow();
  expect(publicHost("IDP_PUBLIC_HOST", value, "localhost:8083")).toBe("localhost:8083");
});

test.each(REFUSED)("%p is refused: it is a service name, not a hostname", (value) => {
  expect(() => assertPublicHost("IDP_PUBLIC_HOST", value)).toThrow(PublicHostError);
});

test("the refusal names the variable, its value, and where the real one comes from", () => {
  // The whole worth of this check is the message: whoever reads it is about to
  // go and find the right string, and the right string is on one specific page.
  try {
    assertPublicHost("IDP_PUBLIC_HOST", "cg-idp-or5b");
    throw new Error("expected a refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(PublicHostError);
    const { message } = cause as Error;
    expect(message).toContain("IDP_PUBLIC_HOST=cg-idp-or5b");
    expect(message).toContain("Render dashboard");
    expect(message).toContain("cg-web-sa31");
  }
});

test("a good value wins over the default, and is trimmed", () => {
  expect(publicHost("IDP_PUBLIC_HOST", "  cg-idp-or5b.onrender.com ", "localhost:8083")).toBe(
    "cg-idp-or5b.onrender.com",
  );
});

/**
 * Through the service's real entry point, because the check is only worth
 * anything if it runs before the port opens. Exit status, not just stderr: a
 * boot that printed this and then served anyway would pass a message-only
 * assertion, and would be the #59 failure with a warning attached.
 */
test("the loan API refuses to start on a bare service name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-public-host-"));

  try {
    const child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "index.ts")], {
      env: {
        ...process.env,
        PORT: "0",
        LOANS_DB_PATH: join(dir, "loans.db"),
        IDP_PUBLIC_HOST: "cg-idp-or5b",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const status = await child.exited;
    const stderr = await new Response(child.stderr as ReadableStream).text();

    // 78 is sysexits' EX_CONFIG, the same status `scripts/dev-idp.ts` uses.
    expect(status).toBe(78);
    expect(stderr).toContain("IDP_PUBLIC_HOST=cg-idp-or5b");
    expect(stderr).toContain("Render dashboard");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("the loan API starts on a hostname that could resolve", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-public-host-"));
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  const port = probe.port as number;
  probe.stop(true);

  const child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "index.ts")], {
    env: {
      ...process.env,
      PORT: String(port),
      LOANS_DB_PATH: join(dir, "loans.db"),
      // Never called in this test: booting is the whole assertion. It matters
      // that it is a hostname rather than a localhost address, so that what
      // passes is the shape, not an exemption.
      IDP_PUBLIC_HOST: "cg-idp-or5b.onrender.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`exited ${child.exitCode} instead of serving`);
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) throw new Error("loan-app did not come up");
      await Bun.sleep(50);
    }
  } finally {
    child.kill();
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
