/**
 * Back to a clean rehearsal state: every person, session, token and consent is
 * dropped and the four personas are seeded again. **The OAuth client is not
 * touched**, so the credentials registered in the Arcade dashboard keep
 * working. This is the piece of `scripts/reset` (#23) that belongs to idp.db.
 *
 *   bun run --cwd apps/idp reset
 */
import { createAuth } from "../src/auth.ts";
import { ensureOAuthClients } from "../src/client.ts";
import { readConfig } from "../src/config.ts";
import { countPeople, openPeople, resetPeople } from "../src/db.ts";

const config = readConfig();
const db = await openPeople(config.dbPath);
const auth = createAuth({ db, baseURL: config.baseURL, secret: config.secret });

const ensure = () => ensureOAuthClients(auth, { clients: config.clients, secret: config.secret });

const before = await ensure();
await resetPeople(db);
const after = await ensure();

// Every configured client, not just the first: a second registration is as
// stale as the first if its id moved, and it fails in the same invisible place.
for (const [index, was] of before.entries()) {
  const now = after[index]!;
  if (was.clientId === now.clientId) continue;
  // Should be unreachable — resetPeople never touches oauthClient — but if it
  // ever is, the Arcade registration is now stale and someone must know.
  console.error(
    `[idp] OAuth client "${was.key}" ROTATED during reset: ${was.clientId} -> ${now.clientId}`,
  );
  process.exit(1);
}

console.log(
  `[idp] reset ${config.dbPath}: ${countPeople(db)} people re-seeded, ` +
    `OAuth client${after.length > 1 ? "s" : ""} ${after.map((each) => each.clientId).join(", ")} unchanged`,
);
db.close();
