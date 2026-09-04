/**
 * The people database: seeding, the one-transaction rule, and the reset that
 * leaves the OAuth client alone.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createAuth } from "../src/auth.ts";
import { ensureOAuthClient } from "../src/client.ts";
import type { PersonSeed } from "../src/db.ts";
import { countPeople, listPeople, loadPeople, openPeople, resetPeople, seed } from "../src/db.ts";

const SECRET = "test-secret-".padEnd(48, "x");
const fixture = loadPeople({});

const ONE_PERSON: PersonSeed = {
  persona: "dana",
  name: "Placeholder Person",
  email: "placeholder@bank.example",
  password: "placeholder-2026",
};

const tempDirs: string[] = [];
function tempDb(): string {
  const path = join(tmpdir(), `cg-idp-${crypto.randomUUID()}`, "idp.db");
  tempDirs.push(dirname(path));
  return path;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the fixture", () => {
  test("holds the four personas from DESIGN.md's Cast table", () => {
    expect(fixture.map((p) => p.persona).sort()).toEqual(["dana", "morgan", "riley", "sam"]);
    expect(fixture.map((p) => p.name).sort()).toEqual([
      "Dana Okafor",
      "Morgan Ellis",
      "Riley Chen",
      "Sam Reyes",
    ]);
  });

  test("PERSONA_<NAME>_EMAIL overrides one persona's address and nothing else", () => {
    const people = loadPeople({ PERSONA_DANA_EMAIL: "  dana@example.com " });

    expect(people.find((p) => p.persona === "dana")?.email).toBe("dana@example.com");
    expect(people.find((p) => p.persona === "sam")?.email).toBe(
      fixture.find((p) => p.persona === "sam")?.email,
    );
  });

  test("an empty override is ignored — .env.example ships these blank", () => {
    const people = loadPeople({ PERSONA_RILEY_EMAIL: "" });
    expect(people.find((p) => p.persona === "riley")?.email).toBe(
      fixture.find((p) => p.persona === "riley")?.email,
    );
  });
});

describe("seeding", () => {
  test("bootstraps the fixture into an empty database", async () => {
    const db = await openPeople(":memory:");

    expect(countPeople(db)).toBe(4);
    expect(listPeople(db).map((p) => p.email).sort()).toEqual(fixture.map((p) => p.email).sort());
  });

  test("a seed that fails leaves no schema, so the next boot retries", async () => {
    // Two personas with the same email pass the zod schema and violate the
    // unique index. If the schema were created outside the seed transaction,
    // the tables would survive the failed inserts, `hasSchema` would report
    // the database as seeded, and every later boot would come up green with
    // nobody able to log in — permanently, on a disk that persists.
    const db = new Database(":memory:");

    await expect(seed(db, [ONE_PERSON, ONE_PERSON])).rejects.toThrow(/UNIQUE/);
    expect(() => countPeople(db)).toThrow(/no such table/);

    await seed(db, [ONE_PERSON]);
    expect(countPeople(db)).toBe(1);
  });

  test("leaves an existing database alone — later boots are not a reset", async () => {
    const path = tempDb();

    const first = await openPeople(path);
    const ids = listPeople(first).map((p) => p.id);
    first.close();

    // A different fixture on the second open changes nothing: the database
    // already has a schema, so it is left as it is.
    const second = await openPeople(path, [ONE_PERSON]);
    const again = listPeople(second).map((p) => p.id);
    second.close();

    expect(again).toEqual(ids);
  });
});

describe("resetPeople", () => {
  test("re-seeds the people and keeps the OAuth client, credentials included", async () => {
    const path = tempDb();
    const db = await openPeople(path);
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });
    const redirectUris = ["http://127.0.0.1:9/callback"];

    const before = await ensureOAuthClient(auth, { redirectUris, secret: SECRET });
    const peopleBefore = listPeople(db).map((p) => p.id);

    await resetPeople(db);

    const after = await ensureOAuthClient(auth, { redirectUris, secret: SECRET });

    expect(before.created).toBe(true);
    expect(after.created).toBe(false);
    expect(after.clientId).toBe(before.clientId);
    expect(after.clientSecret).toBe(before.clientSecret);

    // The people really were replaced, not left alone.
    expect(countPeople(db)).toBe(4);
    expect(listPeople(db).map((p) => p.id)).not.toEqual(peopleBefore);
    db.close();
  });

  test("clears sessions, tokens and consents along with the people", async () => {
    const db = await openPeople(":memory:");
    const person = listPeople(db)[0]!;
    const now = new Date().toISOString();

    db.query(
      `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId")
       VALUES ('s1', $now, 't1', $now, $now, $user)`,
    ).run({ $now: now, $user: person.id });

    await resetPeople(db);

    expect(db.query('SELECT COUNT(*) AS n FROM "session"').get()).toEqual({ n: 0 });
    expect(db.query('SELECT COUNT(*) AS n FROM "oauthConsent"').get()).toEqual({ n: 0 });
    expect(db.query('SELECT COUNT(*) AS n FROM "oauthAccessToken"').get()).toEqual({ n: 0 });
  });

  test("the client is unowned, so deleting every user cannot cascade into it", async () => {
    const db = await openPeople(":memory:");
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });
    await ensureOAuthClient(auth, { redirectUris: ["http://127.0.0.1:9/callback"], secret: SECRET });

    const row = db.query<{ userId: string | null }, []>('SELECT "userId" FROM "oauthClient"').get();
    expect(row?.userId).toBeNull();

    db.exec('DELETE FROM "user"');
    expect(db.query('SELECT COUNT(*) AS n FROM "oauthClient"').get()).toEqual({ n: 1 });
  });
});

describe("ensureOAuthClient never rotates", () => {
  const redirectUris = ["http://127.0.0.1:9/callback"];

  /** A client row as an earlier build wrote it: generated id, found by name. */
  function insertLegacyRow(db: Database, name: string, clientId: string): void {
    db.query(
      `INSERT INTO "oauthClient" ("id", "clientId", "clientSecret", "name", "redirectUris", "createdAt", "updatedAt")
       VALUES ($id, $clientId, 'ciphertext', $name, '["http://127.0.0.1:9/callback"]', $now, $now)`,
    ).run({ $id: crypto.randomUUID(), $clientId: clientId, $name: name, $now: new Date().toISOString() });
  }

  test("adopts a row written under a generated id instead of minting a second client", async () => {
    const db = await openPeople(":memory:");
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });
    // Written by a real bootstrap, then re-keyed to look like the earlier build's row.
    const original = await ensureOAuthClient(auth, { redirectUris, secret: SECRET });
    db.exec(`UPDATE "oauthClient" SET "id" = '${crypto.randomUUID()}'`);

    const adopted = await ensureOAuthClient(auth, { redirectUris, secret: SECRET });

    expect(adopted.created).toBe(false);
    expect(adopted.clientId).toBe(original.clientId);
    expect(adopted.clientSecret).toBe(original.clientSecret);
    expect(db.query('SELECT "id" FROM "oauthClient"').all()).toEqual([{ id: "arcade" }]);
  });

  test("refuses to boot when client rows exist that it cannot recognise", async () => {
    const db = await openPeople(":memory:");
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });
    insertLegacyRow(db, "Something Else", "client-arcade-may-hold");

    await expect(ensureOAuthClient(auth, { redirectUris, secret: SECRET })).rejects.toThrow(
      /Refusing to create another/,
    );
    expect(db.query('SELECT COUNT(*) AS n FROM "oauthClient"').get()).toEqual({ n: 1 });
  });

  test("refuses when two legacy rows share the name, rather than guess", async () => {
    const db = await openPeople(":memory:");
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });
    insertLegacyRow(db, "Arcade", "first");
    insertLegacyRow(db, "Arcade", "second");

    await expect(ensureOAuthClient(auth, { redirectUris, secret: SECRET })).rejects.toThrow(
      /2 named "Arcade"/,
    );
    expect(db.query('SELECT COUNT(*) AS n FROM "oauthClient"').get()).toEqual({ n: 2 });
  });
});

describe("ensureOAuthClient", () => {
  test("two bootstraps at once still leave exactly one client", async () => {
    // The service booting on a fresh disk while someone runs `oauth-client`
    // in a shell: both look, both find nothing, both insert. The row has a
    // fixed primary key, so one insert loses and takes the winner's client.
    const db = await openPeople(":memory:");
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });
    const redirectUris = ["http://127.0.0.1:9/callback"];

    const [a, b] = await Promise.all([
      ensureOAuthClient(auth, { redirectUris, secret: SECRET }),
      ensureOAuthClient(auth, { redirectUris, secret: SECRET }),
    ]);

    expect(a.clientId).toBe(b.clientId);
    expect(a.clientSecret).toBe(b.clientSecret);
    expect(db.query('SELECT COUNT(*) AS n FROM "oauthClient"').get()).toEqual({ n: 1 });
  });

  test("brings the redirect URIs in line without touching the credentials", async () => {
    const db = await openPeople(":memory:");
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });

    const first = await ensureOAuthClient(auth, { redirectUris: ["http://a/cb"], secret: SECRET });
    const second = await ensureOAuthClient(auth, {
      redirectUris: ["http://a/cb", "http://b/cb"],
      secret: SECRET,
    });

    expect(second.clientId).toBe(first.clientId);
    expect(second.clientSecret).toBe(first.clientSecret);
    expect(second.redirectUris).toEqual(["http://a/cb", "http://b/cb"]);

    const stored = db
      .query<{ redirectUris: string }, []>('SELECT "redirectUris" FROM "oauthClient"')
      .get();
    expect(JSON.parse(stored!.redirectUris)).toEqual(["http://a/cb", "http://b/cb"]);
  });
});
