import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db/client";
import { CAN_WRITE_DB } from "@/lib/db/guards";

import { UNCHANGED_BEFORE_WIDENING } from "./interval";

/*
 * What this suite is for: the conflation that makes the adaptive interval
 * dishonest.
 *
 * §6.4 distinguishes THREE outcomes, and the whole scheduler rests on the
 * distinction:
 *
 *   304 / soft 304   a SUCCESS. Resets `consecutive_failures`, increments
 *                    `unchanged_polls`.
 *   200 + changes    a success that resets BOTH.
 *   anything else    a failure.
 *
 * Collapse the first two and a healthy quiet feed looks identical to a healthy
 * busy one, so the widening never fires. Treat a 304 as a failure instead —
 * easy, because it is not a `200` — and the commonest outcome there is drives
 * the backoff curve: every feed in the reader marches to `dead` in twenty
 * polls while answering perfectly.
 *
 * Neither mistake produces an error. The first wastes other people's bandwidth
 * quietly; the second empties the reader and looks like the feeds broke.
 */

const describeDb = CAN_WRITE_DB ? describe : describe.skip;

const fetchFeed = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ingest/fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ingest/fetch")>();
  return { ...actual, fetchFeed };
});

let seq = 0;
const unique = () => `${Date.now()}-${seq++}`;
const made: bigint[] = [];

const FEED_BODY = (n: number) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>` +
  Array.from(
    { length: n },
    (_, i) =>
      `<item><guid>g-${unique()}-${i}</guid>` +
      `<link>https://s-${unique()}.example/p-${i}</link>` +
      `<title>Post ${i}</title>` +
      `<pubDate>${new Date(Date.parse("2026-11-20T12:00:00Z") - i * 6 * 3600_000).toUTCString()}</pubDate>` +
      `</item>`,
  ).join("") +
  `</channel></rss>`;

function respond304(soft = false) {
  fetchFeed.mockResolvedValue({ kind: "unchanged", status: soft ? 200 : 304, soft, durationMs: 5 });
}

function respondChanged(items = 4) {
  const body = FEED_BODY(items);
  fetchFeed.mockResolvedValue({
    kind: "changed",
    status: 200,
    body: new TextEncoder().encode(body),
    contentType: "application/rss+xml",
    etag: 'W/"x"',
    lastModified: null,
    bodyHash: new Uint8Array(32),
    finalUrl: null,
    durationMs: 9,
    bytes: body.length,
  });
}

function respondFailure() {
  fetchFeed.mockResolvedValue({
    kind: "failed",
    status: 500,
    code: "http_error",
    detail: null,
    durationMs: 7,
    retryAfterS: null,
  });
}

async function makeFeed(over: Partial<{ failures: number; unchanged: number }> = {}) {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    INSERT INTO cadence.feeds
      (feed_url, url_hash, title, status, next_fetch_at, fetch_interval_s, clean_polls,
       consecutive_failures, unchanged_polls, last_success_at)
    VALUES (${`https://threeohfour-${unique()}.example/feed`},
            decode(md5(random()::text), 'hex'), '304 probe', 'active',
            now() - interval '1 minute', 3600, 3,
            ${over.failures ?? 0}, ${over.unchanged ?? 0}, now())
    RETURNING id`;
  made.push(rows[0].id);
  return rows[0].id;
}

async function stateOf(id: bigint) {
  const rows = await prisma.$queryRaw<
    {
      status: string;
      consecutive_failures: number;
      unchanged_polls: number;
      next_fetch_at: Date;
      last_success_at: Date | null;
      first_failure_at: Date | null;
      fetch_interval_s: number;
    }[]
  >`
    SELECT status::text, consecutive_failures, unchanged_polls, next_fetch_at,
           last_success_at, first_failure_at, fetch_interval_s
    FROM cadence.feeds WHERE id = ${id}`;
  return rows[0];
}

describeDb("a 304 is a success", { timeout: 180_000 }, () => {
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

  it("RESETS consecutive_failures and does not reset unchanged_polls", async () => {
    /*
     * The plan's acceptance criterion, verbatim, and both halves matter:
     * resetting the failures is what stops a quiet feed marching to `dead`,
     * and NOT resetting `unchanged_polls` is what lets the widening ever fire.
     */
    const id = await makeFeed({ failures: 4, unchanged: 2 });
    respond304();

    await runSweep({ batch: 1, onlyFeedIds: [id] });

    const after = await stateOf(id);
    expect(after.consecutive_failures).toBe(0);
    expect(after.unchanged_polls).toBe(3);
    expect(after.status).toBe("active");
    expect(after.last_success_at).not.toBeNull();
  });

  it("counts a SOFT 304 the same way", async () => {
    // A byte-identical body from a server that sent no validator. It arrives as
    // a `200`, so a check on the status code would miss it entirely and the
    // feed would look busy forever.
    const id = await makeFeed({ unchanged: 1 });
    respond304(true);

    await runSweep({ batch: 1, onlyFeedIds: [id] });

    const after = await stateOf(id);
    expect(after.unchanged_polls).toBe(2);
    expect(after.consecutive_failures).toBe(0);
  });

  it("a CHANGED body resets BOTH counters", async () => {
    // §6.4's third outcome. A feed that starts posting again must drop its
    // widening immediately rather than staying on a doubled interval.
    const id = await makeFeed({ failures: 3, unchanged: 12 });
    respondChanged();

    await runSweep({ batch: 1, onlyFeedIds: [id] });

    const after = await stateOf(id);
    expect(after.consecutive_failures).toBe(0);
    expect(after.unchanged_polls).toBe(0);
  });

  it("a FAILURE increments failures and backs the feed off", async () => {
    const id = await makeFeed();
    respondFailure();

    await runSweep({ batch: 1, onlyFeedIds: [id] });

    const after = await stateOf(id);
    expect(after.consecutive_failures).toBe(1);
    expect(after.status).toBe("backoff");
    // Five minutes out, give or take the ±10 % jitter.
    const seconds = (after.next_fetch_at.getTime() - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(250);
    expect(seconds).toBeLessThan(400);
  });

  it("does NOT drive the backoff curve from 304s, however many arrive", async () => {
    /*
     * The failure mode this suite exists for. Twenty-five 304s is a perfectly
     * healthy feed that has not published in a while. If a 304 counted as a
     * failure it would now be `dead` — and so would every other quiet feed in
     * the reader, all at once, looking exactly like the feeds broke.
     */
    const id = await makeFeed();
    respond304();

    for (let poll = 0; poll < 25; poll++) {
      await prisma.$executeRaw`
        UPDATE cadence.feeds SET next_fetch_at = now() - interval '1 minute' WHERE id = ${id}`;
      await runSweep({ batch: 1, onlyFeedIds: [id] });
    }

    const after = await stateOf(id);
    expect(after.consecutive_failures).toBe(0);
    expect(after.status).toBe("active");
    expect(after.unchanged_polls).toBe(25);
  });

  it("CLEARS first_failure_at, so it means the current run and not the first ever", async () => {
    /*
     * `backoff.ts` marks a feed `dead` after 14 days of FAILING, measured from
     * `first_failure_at` — and `dead` is terminal.
     *
     * The column was only ever set, never cleared, so it recorded the first
     * failure the feed had ever had. A feed that failed once months ago and has
     * been healthy since would therefore, on its very next single failure,
     * measure a months-long run and be killed outright. The 14-day rule is only
     * correct if a success resets this.
     */
    const id = await makeFeed({ failures: 2 });
    await prisma.$executeRaw`
      UPDATE cadence.feeds SET first_failure_at = now() - interval '200 days' WHERE id = ${id}`;

    respond304();
    await runSweep({ batch: 1, onlyFeedIds: [id] });

    expect((await stateOf(id)).first_failure_at).toBeNull();

    // And a changed body clears it too.
    await prisma.$executeRaw`
      UPDATE cadence.feeds
      SET first_failure_at = now() - interval '200 days',
          next_fetch_at = now() - interval '1 minute'
      WHERE id = ${id}`;
    respondChanged();
    await runSweep({ batch: 1, onlyFeedIds: [id] });

    expect((await stateOf(id)).first_failure_at).toBeNull();
  });

  it("PERSISTS the interval on the 304 path, which is the only path it changes on", async () => {
    /*
     * The widening is driven by `unchanged_polls`, which only a 304
     * increments — so the 304 branch is the one place the interval actually
     * moves. It computed the new value and did not store it, so
     * `fetch_interval_s` kept its old number and the health screen's
     * "Checked every …" reported a cadence the scheduler was not using.
     */
    const id = await makeFeed({ unchanged: UNCHANGED_BEFORE_WIDENING + 5 });
    const before = (await stateOf(id)).fetch_interval_s;
    respond304();

    await runSweep({ batch: 1, onlyFeedIds: [id] });

    const after = await stateOf(id);
    expect(after.fetch_interval_s).not.toBe(before);
    // And it matches where the feed was actually scheduled, give or take jitter.
    const scheduled = (after.next_fetch_at.getTime() - Date.now()) / 1000;
    expect(Math.abs(scheduled - after.fetch_interval_s)).toBeLessThan(400);
  });

  it("WIDENS the interval once a feed has been unchanged for a while", async () => {
    /*
     * The payoff for keeping `unchanged_polls`. A feed past the threshold is
     * asked half as often — which is only observable because a 304 does not
     * reset the counter.
     */
    const id = await makeFeed({ unchanged: UNCHANGED_BEFORE_WIDENING + 5 });
    respond304();

    await runSweep({ batch: 1, onlyFeedIds: [id] });
    const widened = (await stateOf(id)).next_fetch_at.getTime() - Date.now();

    // And the same feed, not yet past the threshold.
    const fresh = await makeFeed({ unchanged: 0 });
    await runSweep({ batch: 1, onlyFeedIds: [fresh] });
    const normal = (await stateOf(fresh)).next_fetch_at.getTime() - Date.now();

    expect(widened).toBeGreaterThan(normal * 1.5);
  });
});
