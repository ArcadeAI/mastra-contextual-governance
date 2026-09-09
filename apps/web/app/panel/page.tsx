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
import { governanceStreamSource, withFixtureParams } from "../../lib/governance/stream-url.ts";

export const metadata: Metadata = { title: "Control plane — Contextual Governance" };

// The stream address comes from the environment at request time; a statically
// rendered page would bake in whatever the build machine had.
export const dynamic = "force-dynamic";

export default async function PanelPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // In fixture mode the page's own query string tunes the replay, so
  // `/panel?repeat=2000&delayMs=0` is ten thousand events as fast as the socket
  // will carry them — the shape of a whole-project `/access` call, and the way
  // to watch the panel absorb one rather than take a test's word for it.
  const { url, mode } = withFixtureParams(governanceStreamSource(process.env), await searchParams);

  return (
    <main className="cg-page">
      <ControlPlanePanel streamUrl={url} mode={mode} />
    </main>
  );
}
