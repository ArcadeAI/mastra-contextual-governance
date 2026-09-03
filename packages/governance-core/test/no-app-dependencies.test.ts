/**
 * The forkability boundary, enforced rather than documented.
 *
 * `packages/governance-core` must never reach into an app. If it does, a forker
 * cannot replace `apps/loan-mcp` with their own business system without
 * rewriting the governance layer — which is the whole promise of the template.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Package names declared by everything under `apps/`. */
function appPackageNames(): string[] {
  const appsDir = join(REPO_ROOT, "apps");
  return readdirSync(appsDir)
    .filter((entry) => statSync(join(appsDir, entry)).isDirectory())
    .map((entry) => readJson(join(appsDir, entry, "package.json")).name)
    .filter((name): name is string => typeof name === "string");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mts|cts)$/.test(entry.name) ? [path] : [];
  });
}

describe("governance-core is independent of every app", () => {
  const apps = appPackageNames();

  it("finds the apps it is supposed to stay away from", () => {
    // Guards the two checks below: if the glob silently found nothing they
    // would pass vacuously.
    expect(apps.length).toBeGreaterThan(0);
  });

  it("declares no dependency on an app package", () => {
    const manifest = readJson(join(PACKAGE_ROOT, "package.json"));
    const declared = new Set(
      (
        [
          "dependencies",
          "devDependencies",
          "peerDependencies",
          "optionalDependencies",
        ] as const
      ).flatMap((field) => Object.keys((manifest[field] ?? {}) as object)),
    );

    expect(apps.filter((app) => declared.has(app))).toEqual([]);
  });

  it("imports nothing from an app, by package name or by relative path", () => {
    const offenders = sourceFiles(join(PACKAGE_ROOT, "src")).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
        (match) => match[1] as string,
      );
      return specifiers
        .filter(
          (specifier) =>
            apps.some(
              (app) => specifier === app || specifier.startsWith(`${app}/`),
            ) || specifier.includes("apps/"),
        )
        .map((specifier) => `${file}: ${specifier}`);
    });

    expect(offenders).toEqual([]);
  });
});
