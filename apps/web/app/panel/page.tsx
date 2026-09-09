/**
 * The control-plane panel on its own page.
 *
 * The panel's home is the right half of the split screen, which is #22's to
 * build. This page exists so the surface can be opened, rehearsed and reviewed
 * before that lands, and so a presenter can throw it onto a second screen on
 * its own — which is how it gets used at a booth.
 *
 * A **server** component, and that is the point: it reads the environment here
 * and hands the stream's address down as a prop. `.env.example` explains at
 * length why the alternative is a trap — `next build` inlines `NEXT_PUBLIC_*`
 * into the client bundle while Render supplies service variables at runtime, so
 * a public variable would be `undefined` in the browser on Render and perfectly
 * fine under `next dev`.
 */
import type { Metadata } from "next";

import { ControlPlanePanel } from "../../components/governance/ControlPlanePanel.tsx";
import { governanceStreamSource } from "../../lib/governance/stream-url.ts";

export const metadata: Metadata = { title: "Control plane — Contextual Governance" };

// The stream address comes from the environment at request time; a statically
// rendered page would bake in whatever the build machine had.
export const dynamic = "force-dynamic";

export default function PanelPage() {
  const { url, mode } = governanceStreamSource(process.env);

  return (
    <main className="cg-page">
      <ControlPlanePanel streamUrl={url} mode={mode} />
    </main>
  );
}
