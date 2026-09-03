/**
 * `src/schema.sql` is generated from the installed Better Auth; the seed runs
 * it verbatim. A stale file is how the seed and the library end up disagreeing
 * about a column — which surfaces, if at all, as "Invalid email or password".
 */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

import { compileSchema } from "../src/schema.ts";

test("src/schema.sql matches what the installed Better Auth generates", async () => {
  const checkedIn = await Bun.file(join(import.meta.dir, "..", "src", "schema.sql")).text();
  const fresh = await compileSchema(new Database(":memory:"));

  expect(checkedIn).toBe(fresh);
});
