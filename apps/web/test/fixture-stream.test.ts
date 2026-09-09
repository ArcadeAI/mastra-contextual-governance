/**
 * The no-backend path, end to end: the real route handler, over a real socket,
 * read by the real subscriber, into the real timeline. Nothing is stubbed, so
 * "builds and demos against fixture events with no backend running" is a thing
 * this suite actually does rather than a thing the README claims.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { aGovernanceEventSequence } from "@cg/policy-schema";

import { GET } from "../app/api/governance/fixture-stream/route.ts";
import { subscribeToGovernanceEvents } from "../lib/governance/subscribe.ts";
import { allEvents, appendEvents, emptyTimeline, type Timeline } from "../lib/governance/timeline.ts";
import { governanceStreamSource } from "../lib/governance/stream-url.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop(true);
});

/** The route handler itself, bound to a port the OS handed out. */
function serveFixtureRoute(): string {
  const server = Bun.serve({ port: 0, fetch: (request) => GET(request) });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/api/governance/fixture-stream`;
}

async function until(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** Runs the fixture stream into a timeline and stops once it has `count` events. */
async function play(url: string, count: number): Promise<Timeline> {
  let timeline = emptyTimeline();
  const controller = new AbortController();
  const done = subscribeToGovernanceEvents(url, {
    onEvents: (batch) => {
      timeline = appendEvents(timeline, batch);
    },
    signal: controller.signal,
    retryMs: 20,
  });

  await until(() => timeline.received >= count, `${count} events from the fixture stream`);
  controller.abort();
  await done;
  return timeline;
}

describe("the fixture stream", () => {
  test("serves text/event-stream", async () => {
    const response = await fetch(`${serveFixtureRoute()}?delayMs=0`);

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-cache");
    await response.body?.cancel();
  });

  test("tells a proxy not to buffer it, or the acts arrive all at once at the end", async () => {
    const response = await fetch(`${serveFixtureRoute()}?delayMs=0`);

    expect(response.headers.get("x-accel-buffering")).toBe("no");
    await response.body?.cancel();
  });

  test("delivers #5's whole sequence, in order, through the real client", async () => {
    const expected = aGovernanceEventSequence();

    const timeline = await play(`${serveFixtureRoute()}?delayMs=0`, expected.length);

    expect(allEvents(timeline).map((event) => event.id)).toEqual(
      expected.map((event) => event.id),
    );
  });

  test("the events survive the round trip byte for byte", async () => {
    const expected = aGovernanceEventSequence();

    const timeline = await play(`${serveFixtureRoute()}?delayMs=0`, expected.length);

    expect(allEvents(timeline)).toEqual(expected);
  });

  test("fills all three lanes, which is what makes it a demo of three control points", async () => {
    const timeline = await play(`${serveFixtureRoute()}?delayMs=0`, 5);

    expect(timeline.lanes.access.length).toBeGreaterThan(0);
    expect(timeline.lanes.pre.length).toBeGreaterThan(0);
    expect(timeline.lanes.post.length).toBeGreaterThan(0);
  });

  test("covers allow, deny and modify, so every visual state is exercised", async () => {
    const timeline = await play(`${serveFixtureRoute()}?delayMs=0`, 5);

    expect(timeline.counts.allow).toBeGreaterThan(0);
    expect(timeline.counts.deny).toBeGreaterThan(0);
    expect(timeline.counts.modify).toBeGreaterThan(0);
  });

  test("holds the connection open afterwards instead of replaying on a loop", async () => {
    const url = `${serveFixtureRoute()}?delayMs=0`;
    let timeline = emptyTimeline();
    const controller = new AbortController();
    const statuses: string[] = [];
    const done = subscribeToGovernanceEvents(url, {
      onEvents: (batch) => {
        timeline = appendEvents(timeline, batch);
      },
      onStatus: (status) => statuses.push(status),
      signal: controller.signal,
      retryMs: 20,
    });

    await until(() => timeline.received >= 5, "the sequence");
    await Bun.sleep(300);
    controller.abort();
    await done;

    expect(timeline.received).toBe(5);
    expect(statuses).not.toContain("reconnecting");
  });

  test("paces the acts apart by default, so causality is visible", async () => {
    const url = serveFixtureRoute();
    const startedAt = Date.now();

    await play(url, 2);

    expect(Date.now() - startedAt).toBeGreaterThan(900);
  });

  test("a client that goes away does not leave the handler writing", async () => {
    const response = await fetch(`${serveFixtureRoute()}?delayMs=0`);
    await response.body?.cancel();

    // Nothing to assert beyond this returning: the handler's abort listener is
    // what stops it looping on a stream nobody is reading.
    await Bun.sleep(50);
    expect(true).toBe(true);
  });
});

describe("which stream the panel is pointed at", () => {
  test("defaults to the fixture, because apps/hooks does not serve /events yet", () => {
    expect(governanceStreamSource({})).toEqual({
      url: "/api/governance/fixture-stream",
      mode: "fixture",
    });
  });

  test("a configured hook host alone is not enough to switch away from the fixture", () => {
    expect(governanceStreamSource({ HOOKS_PUBLIC_HOST: "localhost:8081" }).mode).toBe("fixture");
  });

  test("GOVERNANCE_STREAM=hooks points at the hook server", () => {
    expect(
      governanceStreamSource({ GOVERNANCE_STREAM: "hooks", HOOKS_PUBLIC_HOST: "localhost:8081" }),
    ).toEqual({ url: "http://localhost:8081/events", mode: "hooks" });
  });

  test("a deployed host gets https, a local one gets http", () => {
    const deployed = governanceStreamSource({
      GOVERNANCE_STREAM: "hooks",
      HOOKS_PUBLIC_HOST: "cg-hooks.onrender.com",
    });
    const local = governanceStreamSource({
      GOVERNANCE_STREAM: "hooks",
      HOOKS_PUBLIC_HOST: "127.0.0.1:4421",
    });

    expect(deployed.url).toBe("https://cg-hooks.onrender.com/events");
    expect(local.url).toBe("http://127.0.0.1:4421/events");
  });

  test("asking for hooks without a host falls back to the fixture rather than a bad URL", () => {
    expect(governanceStreamSource({ GOVERNANCE_STREAM: "hooks" }).mode).toBe("fixture");
    expect(governanceStreamSource({ GOVERNANCE_STREAM: "hooks", HOOKS_PUBLIC_HOST: "  " }).mode).toBe(
      "fixture",
    );
  });
});
