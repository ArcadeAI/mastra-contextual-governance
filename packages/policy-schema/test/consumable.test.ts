/**
 * The package is only "the frozen contract every other slice builds against"
 * if every other slice can actually import it. Four things have to hold, and
 * all four are the kind that break silently in a monorepo.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { version as zodVersion } from "zod/package.json";

const PACKAGE_ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
const PACKAGE_NAME = "@cg/policy-schema";

interface Manifest {
  name?: string;
  exports?: Record<string, string>;
  dependencies?: Record<string, string>;
  overrides?: Record<string, string>;
}

function readJson(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/** Every workspace manifest in the repo, keyed by directory. */
function workspaces(): Array<{ dir: string; manifest: Manifest }> {
  return ["apps", "packages"].flatMap((group) =>
    readdirSync(join(REPO_ROOT, group))
      .map((entry) => join(REPO_ROOT, group, entry))
      .filter((dir) => statSync(dir).isDirectory())
      .filter((dir) => existsSync(join(dir, "package.json")))
      .map((dir) => ({ dir, manifest: readJson(join(dir, "package.json")) })),
  );
}

describe("resolvable by package name", () => {
  it("exposes every schema the contract promises", async () => {
    // By name, not by relative path: this is how every consumer imports it, and
    // it is what exercises the workspace link and the `exports` map.
    const contract = (await import(PACKAGE_NAME)) as Record<string, { parse?: unknown }>;

    for (const name of [
      "Subject",
      "PolicyRule",
      "OutputRule",
      "Decision",
      "Grant",
      "ApprovalRequest",
      "GovernanceEvent",
      "PreHookRequest",
      "PreHookResult",
      "PostHookRequest",
      "PostHookResult",
      "AccessHookRequest",
      "AccessHookResult",
    ]) {
      expect(typeof contract[name]?.parse).toBe("function");
    }
  });

  it("exposes the fixture builders the UI lane and the pure modules need", async () => {
    const contract = (await import(PACKAGE_NAME)) as Record<string, unknown>;
    for (const name of [
      "aSubject",
      "aPolicyRule",
      "anOutputRule",
      "aDecision",
      "aGrant",
      "anApprovalRequest",
      "aGovernanceEvent",
      "aGovernanceEventSequence",
      "aHookExchange",
    ]) {
      expect(typeof contract[name]).toBe("function");
    }
  });
});

describe("consumable without a build step", () => {
  it("points its export map at source that exists", () => {
    const manifest = readJson(join(PACKAGE_ROOT, "package.json"));
    const entry = manifest.exports?.["."];
    expect(entry).toBeDefined();
    expect(existsSync(join(PACKAGE_ROOT, entry as string))).toBe(true);
  });

  it("is declared by every other workspace, with the workspace protocol", () => {
    // "Consumable from every workspace" is the acceptance criterion, and a
    // workspace that does not declare the dependency cannot import it —
    // `bun -e 'import ... from "@cg/policy-schema"'` exits 1 there. Checking
    // only the workspaces that already declare it would make this vacuous.
    //
    // A version range rather than `workspace:*` would resolve against the
    // registry, where this private package does not exist, and would fail only
    // at install time in CI.
    for (const { dir, manifest } of workspaces()) {
      if (manifest.name === PACKAGE_NAME) continue;
      expect(`${dir}: ${manifest.dependencies?.[PACKAGE_NAME]}`).toBe(
        `${dir}: workspace:*`,
      );
    }
  });
});

describe("Zod 3", () => {
  it("resolves zod 3, not 4", () => {
    // Zod 4 changes internals the Arcade/Mastra path does not support yet, so
    // the root manifest overrides every transitive copy to one 3.x version.
    expect(zodVersion.startsWith("3.")).toBe(true);
  });

  it("pins the same zod version the rest of the repo pins", () => {
    const pinned = readJson(join(REPO_ROOT, "package.json")).overrides?.zod;
    expect(pinned).toMatch(/^3\./);
    expect(readJson(join(PACKAGE_ROOT, "package.json")).dependencies?.zod).toBe(pinned);
  });
});
