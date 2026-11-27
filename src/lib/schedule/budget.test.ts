import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db/client";
import { CAN_WRITE_DB } from "@/lib/db/guards";

import { BUDGET_MS, HTTP_CONCURRENCY, PER_HOST_CONCURRENCY, SETTLE_MS } from "./sweep";

/*
 * What this suite is for: a tick that runs past the function cap and gets
 * killed mid-write.
 *
 * §6.4 gives the sweep a 240-second budget inside a 300-second function cap,
 * and the 60-second margin is the whole point: it turns "killed while writing"
 * into "stopped claiming, let the rest settle, returned a summary". A sweep
 * with no budget hits the cap on its first busy day, which is also the first
 * day it matters.
 *
 * `fetchFeed` is stubbed throughout. The budget is about WALL CLOCK and
 * concurrency, and letting this suite make real requests would make it both
 * slow and dependent on other people's servers.
 */

const describeDb = CAN_WRITE_DB ? describe : describe.skip;

/** The stub, hoisted so `vi.mock` can see it. */
const fetchFeed = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ingest/fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ingest/fetch")>();
  return { ...actual, fetchFeed };
});

let seq = 0;
const unique = () => `${Date.now()}-${seq++}`;
const made: bigint[] = [];

/** Every stubbed fetch reports a 304, the cheapest possible outcome. */
function respondUnchanged(afterMs = 0) {
  fetchFeed.mockImplementation(async () => {
    if (afterMs > 0) await new Promise((r) => setTimeout(r, afterMs));
    return { kind: "unchanged", status: 304, soft: false };
  });
}

/*
 * Every `runSweep` below is scoped to the feeds its own test created.
 *
 * The database is shared and `due` is a global condition, so suites running in
 * parallel claim each other's feeds — "polls everything due" saw 1 of its 8,
 * and only in the full run. Scoping is the fix; see `claimDueFeeds`.
 */
async function makeDueFeeds(count: number, host?: string): Promise<bigint[]> {
  const ids: bigint[] = [];
  for (let i = 0; i < count; i++) {
    const url = host
      ? `https://${host}/feed-${unique()}.xml`
      : `https://budget-${unique()}.example/feed.xml`;
    const rows = await prisma.$queryRaw<{ id: bigint }[]>`
      INSERT INTO cadence.feeds
        (feed_url, url_hash, title, status, next_fetch_at, fetch_interval_s, clean_polls)
      VALUES (${url}, decode(md5(random()::text), 'hex'), 'Budget probe', 'active',
              now() - interval '1 minute', 3600, 3)
      RETURNING id`;
    ids.push(rows[0].id);
    made.push(rows[0].id);
  }
  return ids;
}

describe("the numbers §6.4 specifies", () => {
  it("budgets 240 s inside the 300 s function cap", () => {
    // Pinned because the margin IS the mechanism. Raising this to 300 would
    // mean the sweep is killed exactly when it would otherwise have returned.
    expect(BUDGET_MS).toBe(240_000);
  });

  it("leaves half the cap's margin for work that has started", () => {
    // 240 s budget + 30 s settle = 270 s, inside the 300 s cap with 30 s spare.
    expect(BUDGET_MS + SETTLE_MS).toBeLessThan(300_000);
  });

  it("runs HTTP work at 6, and one request per host", () => {
    expect(HTTP_CONCURRENCY).toBe(6);
    /*
     * The politeness rule that matters most. Six concurrent fetches across six
     * hosts is unremarkable; six at one host is a burst that looks like exactly
     * what gets a poller blocked — and a reader following six feeds from one
     * publisher is ordinary.
     */
    expect(PER_HOST_CONCURRENCY).toBe(1);
  });
});

describeDb("a tick under a budget", { timeout: 180_000 }, () => {
  let runSweep: typeof import("./sweep").runSweep;

  beforeEach(async () => {
    vi.resetModules();
    fetchFeed.mockReset();
    ({ runSweep } = await import("./sweep"));
  });

  afterEach(async () => {
    if (made.length > 0) {
      await prisma.$executeRaw`DELETE FROM cadence.feeds WHERE id = ANY(${made}::bigint[])`;
      made.length = 0;
    }
    vi.restoreAllMocks();
  });

  it("polls everything due when there is time", async () => {
    respondUnchanged();
    const ids = await makeDueFeeds(8);

    const out = await runSweep({ batch: 5, onlyFeedIds: ids });

    expect(out.claimed).toBe(8);
    expect(out.unchanged).toBe(8);
    expect(out.budgetSpent).toBe(false);
  });

  it("STOPS CLAIMING at the budget and says so, rather than running to the cap", async () => {
    /*
     * The plan's acceptance criterion, with the numbers scaled down: a budget
     * of 150 ms against feeds that take 80 ms each, so the second batch cannot
     * start. What is asserted is the BEHAVIOUR — it stopped early, it reported
     * it, and it did not claim everything.
     */
    respondUnchanged(80);
    const ids = await makeDueFeeds(40);

    const out = await runSweep({ batch: 4, budgetMs: 150, onlyFeedIds: ids });

    expect(out.budgetSpent).toBe(true);
    // Stopped well short of the 40 due feeds.
    expect(out.claimed).toBeLessThan(40);
    expect(out.claimed).toBeGreaterThan(0);
  });

  it("LETS IN-FLIGHT WORK SETTLE rather than abandoning it at the budget", async () => {
    /*
     * Abandoning mid-flight would leave exactly the half-written state the
     * lease exists to recover — for no gain, since the function still has 60
     * seconds of its cap left. So every feed claimed is accounted for in the
     * summary.
     */
    respondUnchanged(40);
    const ids = await makeDueFeeds(12);

    const out = await runSweep({ batch: 3, budgetMs: 120, onlyFeedIds: ids });

    expect(out.unchanged + out.changed + out.failed + out.skipped).toBe(out.claimed);
  });

  it("REPORTS itemsNew, which the ping log is the only reader of", async () => {
    /*
     * `pollOne` discarded `runPoll`'s counters, so every tick's summary said
     * `itemsNew: 0` however many articles it had written — and that summary is
     * the only place a human sees a tick's outcome until M10's health screen
     * reads `fetch_log`. A number that is always zero is worse than no number:
     * it reads as "the sweep is running and finding nothing".
     */
    const ids = await makeDueFeeds(1);
    const body = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
      <item><guid>a-${unique()}</guid><link>https://items-${unique()}.example/a</link>
      <title>First</title></item>
      <item><guid>b-${unique()}</guid><link>https://items-${unique()}.example/b</link>
      <title>Second</title></item>
      </channel></rss>`;

    fetchFeed.mockImplementation(async () => ({
      kind: "changed",
      status: 200,
      body: new TextEncoder().encode(body),
      contentType: "application/rss+xml",
      etag: null,
      lastModified: null,
      bodyHash: new Uint8Array(32),
      finalUrl: null,
      bytes: body.length,
    }));

    const out = await runSweep({ batch: 1, onlyFeedIds: ids });

    expect(out.changed).toBe(1);
    expect(out.itemsNew).toBe(2);
  });

  it("returns a summary rather than throwing when there is nothing due", async () => {
    // The commonest tick of all, once the intervals spread out: nothing due,
    // nothing claimed, no error.
    respondUnchanged();
    // Scoped to no feeds at all, which is the "nothing due" case precisely.
    const out = await runSweep({ batch: 25, onlyFeedIds: [] });
    expect(out.claimed).toBe(0);
    expect(out.budgetSpent).toBe(false);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("RELEASES every lease it took, so a budget stop does not strand feeds", async () => {
    /*
     * A tick that stopped at the budget with feeds still leased would make
     * them unavailable for 120 seconds for no reason — the sweep did not die,
     * it finished early on purpose.
     */
    respondUnchanged(10);
    const ids = await makeDueFeeds(6);

    await runSweep({ batch: 3, budgetMs: 5_000, onlyFeedIds: ids });

    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM cadence.feeds
      WHERE id = ANY(${ids}::bigint[]) AND lease_until IS NOT NULL`;
    expect(Number(rows[0].n)).toBe(0);
  });

  it("does not let ONE failing feed take the tick down", async () => {
    // A tick is a batch job over other people's servers. One of them throwing
    // something unexpected must cost that feed, not the other twenty-four.
    const ids = await makeDueFeeds(4);
    let call = 0;
    fetchFeed.mockImplementation(async () => {
      if (call++ === 0) throw new Error("something unexpected");
      return { kind: "unchanged", status: 304, soft: false };
    });

    const out = await runSweep({ batch: 4, onlyFeedIds: ids });

    expect(out.claimed).toBe(4);
    expect(out.failed).toBeGreaterThanOrEqual(1);
    // And the failing feed's lease is still released.
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM cadence.feeds
      WHERE id = ANY(${ids}::bigint[]) AND lease_until IS NOT NULL`;
    expect(Number(rows[0].n)).toBe(0);
  });

  it("does not let ONE busy host starve every other host", async () => {
    /*
     * The limiter NESTING, which was the wrong way round.
     *
     * Nested global-outside-host, a task takes one of the six global slots and
     * THEN queues on its host limiter — so six feeds from one publisher hold
     * all six global slots while five of them wait on a limiter of concurrency
     * 1, and every other host in the batch is starved behind them.
     *
     * Six slow feeds at one host plus one fast feed elsewhere: the fast one
     * must not wait for the slow host to drain.
     */
    const slow = await makeDueFeeds(6, "slow-host.example");
    const fast = await makeDueFeeds(1, "fast-host.example");

    const finished: string[] = [];
    fetchFeed.mockImplementation(async (url: string) => {
      const isSlow = String(url).includes("slow-host");
      await new Promise((r) => setTimeout(r, isSlow ? 120 : 5));
      finished.push(isSlow ? "slow" : "fast");
      return { kind: "unchanged", status: 304, soft: false };
    });

    await runSweep({ batch: 7, onlyFeedIds: [...slow, ...fast] });

    // The fast host's feed finished before the slow host had drained — it did
    // not have to wait behind six serial polls.
    expect(finished.indexOf("fast")).toBeLessThan(5);
  });

  it("SKIPS queued work past the deadline rather than running past the cap", async () => {
    /*
     * The per-host limiter serialises one publisher's feeds, so a reader
     * following many feeds from one site queues them behind each other. At up
     * to 25 s apiece that is well past the 300-second function cap — and
     * "let in-flight work settle" would then be the thing that gets the
     * function killed, which is what the budget exists to avoid.
     *
     * A queued poll reached after the deadline releases its lease and reports
     * `skipped`. The feed is still due; the next tick takes it.
     */
    const ids = await makeDueFeeds(8, "one-slow-host.example");
    respondUnchanged(60);

    const out = await runSweep({ batch: 8, budgetMs: 1, settleMs: 80, onlyFeedIds: ids });

    expect(out.claimed).toBe(8);
    expect(out.skipped).toBeGreaterThan(0);
    // Everything is accounted for, and nothing is left leased.
    expect(out.unchanged + out.changed + out.failed + out.skipped).toBe(out.claimed);
    const leased = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM cadence.feeds
      WHERE id = ANY(${ids}::bigint[]) AND lease_until IS NOT NULL`;
    expect(Number(leased[0].n)).toBe(0);
  });

  it("serialises requests to ONE host however many of its feeds are due", async () => {
    /*
     * The per-host limiter, observed rather than asserted on a constant.
     * Six feeds at one publisher: with a global limit of 6 and no per-host
     * limit these would all be in flight together, which is the burst that
     * gets a poller blocked.
     */
    const ids = await makeDueFeeds(6, "one-publisher.example");

    let concurrent = 0;
    let peak = 0;
    fetchFeed.mockImplementation(async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 25));
      concurrent -= 1;
      return { kind: "unchanged", status: 304, soft: false };
    });

    await runSweep({ batch: 6, onlyFeedIds: ids });

    expect(peak).toBe(1);
  });
});
