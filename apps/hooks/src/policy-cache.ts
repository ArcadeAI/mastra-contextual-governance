/**
 * The policy, in memory — and why it has to be.
 *
 * Spike #2 measured `/access` being called with the entire project catalogue,
 * ~1.6 MB, against a 5s fail-closed timeout. Reading `governance.db` on each of
 * those calls does not survive that, and a timeout there does not look like a
 * policy problem: every tool in the project fails with "tool access policy
 * service could not be reached". So the compiled policy and the subject roster
 * live here, and a hook call touches the database only to append its audit row.
 *
 * But the database carries live edits. A presenter raises Dana's clearance in
 * act 1 and expects act 3 to honour it; a rule the cache never picks up is the
 * same failure as losing the edit to a restart. So the cache is not
 * time-based. Every write to `subjects`, `catalogue` or `policy_rules` bumps
 * `policy_revision` (triggers, see `policy-store.ts`), and `current()` reads
 * that one integer on every call — one indexed row, microseconds — and reloads
 * when it has moved. An edit from any connection is live on the next hook call,
 * and the reload is logged and visible on `/health` as `revision` and
 * `loaded_at`, so "did my edit take?" has an answer that is not "rerun the
 * prompt and see".
 *
 * A reload that fails — a hand-edited row that no longer parses, a rule that
 * no longer compiles because it names a tool the catalogue lost — puts the
 * cache in the `failed` state, and every hook fails closed until the next
 * successful reload. Not "keep serving the last good policy": that would be a
 * policy edit silently not taking effect, which is exactly the failure this
 * design exists to avoid. The error is on `/health` and in the log, and the
 * fix is another edit, which triggers another reload attempt.
 */
import type { Database } from "bun:sqlite";

import { compilePolicy, type CompiledPolicy, type ToolCatalogue } from "@cg/governance-core";
import type { Subject } from "@cg/policy-schema";

import { readPolicy, readRevision } from "./policy-store.ts";

export type CacheState =
  | {
      status: "ready";
      revision: number;
      loaded_at: string;
      policy: CompiledPolicy;
      catalogue: ToolCatalogue;
      /** Keyed by lower-cased `user_id`; see `findSubject`. */
      subjects: ReadonlyMap<string, Subject>;
    }
  | {
      status: "failed";
      /** The revision that failed to load, so `/health` can say which edit broke it. */
      revision: number | null;
      failed_at: string;
      error: string;
    };

export interface PolicyCache {
  /** The policy as of the database's current revision, reloading if it moved. */
  current(): CacheState;
  /** Unconditional reload. Boot calls it so a cold cache is never served. */
  reload(): CacheState;
}

export function createPolicyCache(
  db: Database,
  log: (line: string) => void = () => {},
): PolicyCache {
  let state: CacheState | null = null;

  const reload = (): CacheState => {
    let revision: number | null = null;
    try {
      const snapshot = readPolicy(db);
      revision = snapshot.revision;
      const policy = compilePolicy({ catalogue: snapshot.catalogue, rules: snapshot.rules });
      const subjects = new Map(snapshot.subjects.map((s) => [subjectKey(s.user_id), s] as const));
      state = {
        status: "ready",
        revision,
        loaded_at: new Date().toISOString(),
        policy,
        catalogue: snapshot.catalogue,
        subjects,
      };
      log(
        `policy loaded: revision ${revision}, ${subjects.size} subjects, ` +
          `${snapshot.rules.length} rules, ${Object.keys(snapshot.catalogue).length} toolkits`,
      );
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      state = { status: "failed", revision, failed_at: new Date().toISOString(), error };
      log(`policy FAILED to load at revision ${revision ?? "?"} — failing closed: ${error}`);
    }
    return state;
  };

  const current = (): CacheState => {
    if (state === null) return reload();
    let revision: number;
    try {
      revision = readRevision(db);
    } catch (cause) {
      // The one read the hot path makes. If it fails, the store is unusable
      // and the honest state is failed, not "whatever we loaded last".
      const error = cause instanceof Error ? cause.message : String(cause);
      state = { status: "failed", revision: null, failed_at: new Date().toISOString(), error };
      log(`policy revision unreadable — failing closed: ${error}`);
      return state;
    }
    // A failed state is retried on every call until an edit fixes it: the
    // revision it failed at is recorded, so an unchanged database is not
    // re-parsed on each hook call for the same error.
    if (revision !== state.revision) return reload();
    return state;
  };

  return { current, reload };
}

/**
 * `user_id` is an email, and the three systems joined on it — Arcade, the OAuth
 * provider, the loan book — do not all promise the same casing. Comparing
 * case-insensitively is a strict superset of the exact join and cannot make
 * two different people the same one.
 */
export function subjectKey(userId: string): string {
  return userId.trim().toLowerCase();
}

export function findSubject(state: CacheState, userId: string | undefined): Subject | null {
  if (state.status !== "ready" || userId === undefined) return null;
  return state.subjects.get(subjectKey(userId)) ?? null;
}
