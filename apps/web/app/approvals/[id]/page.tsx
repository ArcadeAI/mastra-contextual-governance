/**
 * `/approvals/{id}` — the page the Slack link opens.
 *
 * Built on one read, `GET /approvals/{id}`, because the link carries an opaque
 * id and nothing else: no token, no signature, no query string. Whether the
 * person looking may act is not asked here and could not be answered here — it
 * is settled when a button is pressed, by a `/pre` decision on
 * `Approvals.Decide`.
 *
 * Dynamic, and not by accident: the record changes when somebody decides, and
 * a cached page would show a stale status to the next person to open the link.
 */
import { cookies } from "next/headers";

import { fetchApproval, fetchRoster } from "../../../lib/approvals-store.ts";
import { readWebConfig } from "../../../lib/config.ts";
import { choosePersona, PERSONA_COOKIE } from "../../../lib/persona.ts";
import { decide, switchPersona } from "./actions.ts";
import { DecideControls } from "./controls.tsx";
import { ApprovalPage, UnknownRequest } from "./view.tsx";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const config = readWebConfig();

  const lookup = await fetchApproval(id, config);
  if (!lookup.found) return <UnknownRequest id={id} reason={lookup.reason} />;

  const request = lookup.request;
  const roster = await fetchRoster(config);
  const store = await cookies();
  const actingAs = choosePersona(store.get(PERSONA_COOKIE)?.value, roster, request.approver_id);

  return (
    <ApprovalPage
      request={request}
      actingAs={actingAs}
      personas={roster}
      controls={
        <DecideControls
          personas={roster}
          actingAs={actingAs}
          settled={request.status !== "pending"}
          switchPersona={switchPersona.bind(null, id)}
          decide={decide.bind(null, id, request.approver_id)}
        />
      }
    />
  );
}
