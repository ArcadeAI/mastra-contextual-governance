/**
 * Back to a clean rehearsal state: every person, session, token and consent is
 * dropped and the four personas are seeded again. **The OAuth client is not
 * touched**, so the credentials registered in the Arcade dashboard keep
 * working. This is the piece of `scripts/reset` (#23) that belongs to idp.db.
 *
 *   bun run --cwd apps/idp reset
 */
import { createAuth } from "../src/auth.ts";
import { ensureOAuthClient } from "../src/client.ts";
import { readConfig } from "../src/config.ts";
import { countPeople, openPeople, resetPeople } from "../src/db.ts";

const config = readConfig();
const db = await openPeople(config.dbPath);
const auth = createAuth({ db, baseURL: config.baseURL, secret: config.secret });

const before = await ensureOAuthClient(auth, { redirectUris: config.redirectUris, secret: config.secret });
await resetPeople(db);
const after = await ensureOAuthClient(auth, { redirectUris: config.redirectUris, secret: config.secret });

if (before.clientId !== after.clientId) {
  // Should be unreachable — resetPeople never touches oauthClient — but if it
  // ever is, the Arcade registration is now stale and someone must know.
  console.error(`[idp] OAuth client ROTATED during reset: ${before.clientId} -> ${after.clientId}`);
  process.exit(1);
}

console.log(
  `[idp] reset ${config.dbPath}: ${countPeople(db)} people re-seeded, ` +
    `OAuth client ${after.clientId} unchanged`,
);
db.close();
