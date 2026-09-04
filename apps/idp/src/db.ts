/**
 * `idp.db` — the people. Better Auth's own tables (`user`, `session`,
 * `account`, `verification`) plus the OAuth provider plugin's (`oauthClient`,
 * tokens, consents).
 *
 * This service knows who someone is and nothing else: no titles, no limits, no
 * loans. Authority lives in `apps/hooks`; the loan book lives in the business
 * system. Everything here is identity.
 */
import { Database } from "bun:sqlite";
import { hashPassword } from "better-auth/crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import fixture from "./fixtures/people.json" with { type: "json" };
// Generated from the installed Better Auth by `scripts/generate-schema.ts`;
// `test/schema.test.ts` fails when it is stale. Checked in rather than built
// at boot because the seed has to create the schema itself, inside the seed
// transaction — see `seed`.
import SCHEMA from "./schema.sql" with { type: "text" };

const personSchema = z.object({
  persona: z.enum(["dana", "sam", "riley", "morgan"]),
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

// Hand-edited, so parsed rather than trusted: a typo fails at boot with a
// field path instead of surfacing as a persona who quietly cannot log in.
const fixtureSchema = z.object({ people: z.array(personSchema).min(1) });

/** One person as they appear in the fixture. */
export type PersonSeed = z.infer<typeof personSchema>;

/** What the service tells about a person. Name and email — that is the whole record. */
export interface Person {
  id: string;
  name: string;
  email: string;
}

/**
 * The fixture, with each persona's email replaced by `PERSONA_<NAME>_EMAIL`
 * when that variable is set.
 *
 * The email is the join key across the whole system — Arcade `user_id`, OAuth
 * subject, loan-book actor — and the Arcade accounts are created by hand on
 * #13 under whatever addresses are available. `.env.example` already carries
 * these four variables for the persona switcher; reading them here is what
 * keeps `idp.db` and the Arcade accounts on the same string without a second
 * place to edit. The fixture's own addresses are the fallback for a local run.
 */
export function loadPeople(env: Record<string, string | undefined> = process.env): PersonSeed[] {
  return fixtureSchema.parse(fixture).people.map((person) => {
    const override = env[`PERSONA_${person.persona.toUpperCase()}_EMAIL`]?.trim();
    return override ? { ...person, email: override } : person;
  });
}

/**
 * Tables that hold *people and their state*, in an order that respects the
 * foreign keys. `resetPeople` clears exactly these. Not on the list, on
 * purpose: `oauthClient` — the credentials Arcade holds. Rotating them breaks
 * OAuth right after a reset, at the authorize step, where no hook fires and
 * nothing on screen says why.
 */
const PEOPLE_TABLES = [
  "oauthAccessToken",
  "oauthRefreshToken",
  "oauthConsent",
  "verification",
  "session",
  "account",
  "user",
] as const;

/**
 * Opens the people database, bootstrapping it from the fixture only when it
 * has no schema.
 *
 * Seed-if-empty rather than seed-on-boot: `idp.db` lives on a Render disk, so
 * a consent granted on stage is still there after a restart. Getting back to a
 * clean state is `scripts/reset.ts`, never a side effect of deploying — and
 * that reset leaves the OAuth client alone, see `resetPeople`.
 */
export async function openPeople(path: string, people: PersonSeed[] = loadPeople()): Promise<Database> {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  if (!hasSchema(db)) await seed(db, people);

  return db;
}

function hasSchema(db: Database): boolean {
  const row = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'",
    )
    .get();

  return row !== null;
}

/** A person with the password already hashed — the only form that goes into a transaction. */
interface HashedPerson {
  name: string;
  email: string;
  passwordHash: string;
}

/**
 * Hashing is async (scrypt), and `bun:sqlite` transactions are synchronous, so
 * every password is hashed before the transaction opens rather than inside it.
 */
async function hashAll(people: PersonSeed[]): Promise<HashedPerson[]> {
  return Promise.all(
    people.map(async ({ name, email, password }) => ({
      name,
      email,
      passwordHash: await hashPassword(password),
    })),
  );
}

/**
 * Creates the schema and inserts the seed rows in **one** transaction.
 *
 * The schema has to be inside the transaction, not just the inserts. SQLite
 * DDL is transactional, so a seed that throws halfway leaves no tables at all
 * and the next boot tries again with a clear error. Creating the tables first
 * and wrapping only the inserts produces the one failure that cannot recover
 * on its own: a database holding a schema and no rows, which `hasSchema` reads
 * as already seeded. The service then comes up green and nobody can log in —
 * and on a disk that persists, it stays that way. A forker who gives two
 * personas the same email is one boot away from that.
 *
 * Same shape as the loan book's seed (#29), copied rather than reinvented.
 * Exported for the test that holds this line.
 */
export async function seed(db: Database, people: PersonSeed[]): Promise<void> {
  const hashed = await hashAll(people);

  db.transaction(() => {
    db.exec(SCHEMA);
    insertPeople(db, hashed);
  })();
}

/**
 * Clears everything about people — users, credentials, sessions, tokens,
 * consents — and seeds the personas again, in one transaction. **The OAuth
 * client is untouched**, so the `client_id` and `client_secret` registered in
 * the Arcade dashboard keep working across a reset.
 *
 * Deleting the people also deletes their consents, so the first authorize
 * after a reset shows the login page and the consent page again. That is what
 * a rehearsal from clean should look like.
 *
 * Exported for `scripts/reset.ts` and the test that asserts the client survives.
 */
export async function resetPeople(db: Database, people: PersonSeed[] = loadPeople()): Promise<void> {
  const hashed = await hashAll(people);

  db.transaction(() => {
    for (const table of PEOPLE_TABLES) db.exec(`DELETE FROM "${table}"`);
    insertPeople(db, hashed);
  })();
}

/**
 * Better Auth's Kysely adapter stores every `date` column as an ISO-8601
 * string on SQLite, and every row id as a random string, so rows written here
 * are indistinguishable from rows Better Auth writes itself. The credential
 * account is what `emailAndPassword` sign-in looks up: `providerId` is the
 * literal `"credential"`, `issuer` is `"local:credential"` (1.7 added it, and
 * sign-in silently fails without it), and `accountId` is the user's own id.
 * All three read off a row Better Auth's own sign-up wrote.
 */
function insertPeople(db: Database, people: HashedPerson[]): void {
  // Prepared after the DDL (the tables have to exist to compile against) and
  // finalized before the transaction commits, so a rollback is not fighting
  // open statements over tables it is about to drop.
  const insertUser = db.prepare<unknown, Record<string, string | number>>(`
    INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
    VALUES ($id, $name, $email, 1, $now, $now)
  `);
  const insertAccount = db.prepare<unknown, Record<string, string | number>>(`
    INSERT INTO "account" ("id", "issuer", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
    VALUES ($id, 'local:credential', $userId, 'credential', $userId, $password, $now, $now)
  `);

  try {
    const now = new Date().toISOString();
    for (const person of people) {
      const userId = crypto.randomUUID();
      insertUser.run({ $id: userId, $name: person.name, $email: person.email, $now: now });
      insertAccount.run({
        $id: crypto.randomUUID(),
        $userId: userId,
        $password: person.passwordHash,
        $now: now,
      });
    }
  } finally {
    insertUser.finalize();
    insertAccount.finalize();
  }
}

export function listPeople(db: Database): Person[] {
  return db
    .query<Person, []>('SELECT "id", "name", "email" FROM "user" ORDER BY "email" ASC')
    .all();
}

export function countPeople(db: Database): number {
  const row = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM "user"').get();
  return row?.n ?? 0;
}
