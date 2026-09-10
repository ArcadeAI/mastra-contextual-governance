/**
 * The environment this service reads, and the one literal it duplicates.
 *
 * `apps/web` does not depend on `apps/hooks` in the package graph — one is the
 * governed UI, the other is the thing governing it, and an import edge between
 * them would be the wrong shape whatever it carried. So the development
 * fallback for `APPROVALS_STORE_TOKEN` is written out in both places, and this
 * test is what keeps the copies honest: it reads the control plane's source and
 * fails if the two ever disagree.
 *
 * Without the fallback a clean checkout renders the approval page as "nothing
 * to decide" — the store answers `401`, and nothing on screen says the cause is
 * an unset variable. With it and a drift that nobody noticed, the same thing
 * happens and the test that should have caught it does not exist.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { baseUrl, readWebConfig } from "../lib/config.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("the approvals store token", () => {
  test("falls back to the same development value apps/hooks falls back to", () => {
    const token = readWebConfig({}).approvalsStoreToken;
    const hooksConfig = readFileSync(
      join(REPO_ROOT, "apps", "hooks", "src", "config.ts"),
      "utf8",
    );

    expect(token).not.toBe("");
    expect(hooksConfig).toContain(`const DEV_STORE_TOKEN = "${token}"`);
  });

  test("a value in the environment wins, and is trimmed", () => {
    expect(readWebConfig({ APPROVALS_STORE_TOKEN: "  real-token " }).approvalsStoreToken).toBe(
      "real-token",
    );
  });

  test("apps/hooks refuses to boot in production without a real one", () => {
    // The fallback above is a local convenience and must never be a production
    // one. The control plane's own check is the thing that guarantees that, and
    // CI boots the image under NODE_ENV=production to prove the check fires.
    const hooksConfig = readFileSync(
      join(REPO_ROOT, "apps", "hooks", "src", "config.ts"),
      "utf8",
    );
    expect(hooksConfig).toContain("APPROVALS_STORE_TOKEN is required in production");

    const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
    // ...which means the image smoke has to supply one, or the container exits
    // before /health and the job fails. It did, on round 2 of #52.
    expect(workflow).toContain("-e APPROVALS_STORE_TOKEN=");
  });
});

describe("addresses", () => {
  test("are host-form, and the consumer adds the scheme", () => {
    // Render's `fromService` can only emit a bare host and blueprints have no
    // string interpolation, so every cross-service address in this repo is
    // host-form and this function is the one place that picks http or https.
    expect(baseUrl("localhost:4400")).toBe("http://localhost:4400");
    expect(baseUrl("127.0.0.1:4400")).toBe("http://127.0.0.1:4400");
    expect(baseUrl("cg-hooks-sa31.onrender.com")).toBe("https://cg-hooks-sa31.onrender.com");
  });

  test("a trailing slash on the Arcade URL does not become a double slash", () => {
    expect(readWebConfig({ ARCADE_API_URL: "https://api.arcade.dev/" }).arcadeApiUrl).toBe(
      "https://api.arcade.dev",
    );
  });
});
