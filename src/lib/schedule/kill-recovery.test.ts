import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/client";
import { CAN_WRITE_DB } from "@/lib/db/guards";
import { emptyCounters } from "@/lib/ingest/dedupe";
import { recordPoll } from "@/lib/ingest/fetch-log";
import { ingestItems } from "@/lib/ingest/dedupe";
import type { RawItem } from "@/lib/types";

import { claimDueFeeds, LEASE_SECONDS } from "./claim";

/*
 * What this suite is for: the corrupted state a killed sweep would leave.
 *
 * This is the failure the whole of §6.4 is organised against. A Vercel function
 * can be killed at any instant, and when it is, it drops its database
 * connection — which releases every lock it held, immediately, while the work
 * it was doing may still be in flight. So a design that relies on the lock has
 * a window where the next tick re-polls a feed concurrently with a sweep that
 * is not quite dead.
 *
 * `lease_until` is a COLUMN, so it survives. The feed stays unavailable for 120
 * seconds and is then re-claimable — and the repeat costs one conditional GET
 * and inserts ZERO rows, which is the sentence the plan uses as the acceptance
 * criterion.
 *
 * "Killed" is simulated by claiming a feed and then simply not finishing — no
 * release, no write. That is exactly the state a `SIGKILL` leaves behind, and
 * it is the only way to test it without killing the test runner.
 */

const describeDb = CAN_WRITE_DB ? describe : describe.skip;

let seq = 0;
const unique = () => `${Date.now()}-${seq++}`;

const made: bigint[] = [];

const item = (o: Partial<RawItem> = {}): RawItem => ({
  guid: null,
  url: null,
  title: "An article",
  author: null,
  publishedAt: "2026-11-12T09:12:00.000Z",
  contentHtml: "<p>Body.</p>",
  summaryHtml: null,
  xmlBase: null,
  ...o,
});

async function makeDueFeed(): Promise<bigint> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    INSERT INTO cadence.feeds
      (feed_url, url_hash, title, status, next_fetch_at, fetch_interval_s, clean_polls)
    VALUES (${`https://kill-${unique()}.example/feed`},
            decode(md5(random()::text), 'hex'), 'Kill probe', 'active',
            now() - interval '1 minute', 3600, 3)
    RETURNING id`;
  made.push(rows[0].id);
  return rows[0].id;
}

/** Fast-forwards a lease into the past, standing in for 120 seconds elapsing. */
async function expireLease(feedId: bigint): Promise<void> {
  await prisma.$executeRaw`
    UPDATE cadence.feeds
    SET lease_until = now() - interval '1 second'
    WHERE id = ${feedId}`;
}

async function countArticles(feedId: bigint): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM cadence.articles WHERE feed_id = ${feedId}`;
  return Number(rows[0].n);
}

describeDb("a sweep that is killed mid-flight", { timeout: 180_000 }, () => {
  afterEach(async () => {
    if (made.length > 0) {
      await prisma.$executeRaw`DELETE FROM cadence.feeds WHERE id = ANY(${made}::bigint[])`;
      made.length = 0;
    }
  });

  it("leaves an abandoned feed LEASED, so the next tick does not double-poll it", async () => {
    /*
     * The first half of the guarantee, and the one a lock cannot give. The
     * "killed" sweep wrote nothing and released nothing — exactly what a
     * SIGKILL leaves — and the feed must still be unavailable.
     */
    const id = await makeDueFeed();
    const claimed = await claimDueFeeds(25, made);
    expect(claimed.map((f) => f.id)).toContain(id);

    // The function dies here. No release, no write.

    const nextTick = await claimDueFeeds(25, made);
    expect(nextTick.map((f) => f.id)).not.toContain(id);
  });

  it("makes it re-claimable once the lease expires", async () => {
    // The second half. A lease that never expired would strand the feed
    // forever on a single crash, which is worse than double-polling it.
    const id = await makeDueFeed();
    await claimDueFeeds(25, made);

    await expireLease(id);

    const recovered = await claimDueFeeds(25, made);
    expect(recovered.map((f) => f.id)).toContain(id);
  });

  it("the repeat poll inserts ZERO rows", async () => {
    /*
     * The plan's acceptance criterion: "abandoning a leased feed mid-poll
     * leaves it re-claimable after 120 s, and the repeat inserts 0 rows."
     *
     * This is where the lease and the ladder meet. The lease makes the repeat
     * SAFE to happen; the ladder makes it FREE. Neither alone is enough — a
     * re-poll with no ladder would duplicate every article, and a ladder with
     * no lease would run two concurrent ingests of the same feed.
     */
    const id = await makeDueFeed();
    const feed = {
      id,
      guidUnstable: false,
      cleanPolls: 3,
      guidTrustOverride: "auto" as const,
    };
    const items = Array.from({ length: 6 }, (_, i) =>
      item({
        guid: `k-${unique()}-${i}`,
        url: `https://kill-${unique()}.example/post-${i}`,
        title: `Post ${i} ${unique()}`,
        contentHtml: `<p>Body ${i}.</p>`,
      }),
    );

    // The sweep that gets killed: it ingested, then died before releasing.
    await claimDueFeeds(25, made);
    const first = await ingestItems(feed, items);
    expect(first.counters.itemsNew).toBe(6);
    expect(await countArticles(id)).toBe(6);

    // 120 seconds pass. The next tick re-claims and polls the same body.
    await expireLease(id);
    const recovered = await claimDueFeeds(25, made);
    expect(recovered.map((f) => f.id)).toContain(id);

    const second = await ingestItems(feed, items);
    expect(second.counters.itemsNew).toBe(0);
    expect(await countArticles(id)).toBe(6);
  });

  it("leaves the stored validators intact, so the repeat is ONE conditional request", async () => {
    /*
     * The other half of "costing one conditional GET". Validators are stored
     * BEFORE the ladder runs precisely so a killed ingest still leaves them
     * behind — the repeat then sends `If-None-Match`, gets a 304, and reads no
     * body at all.
     *
     * Storing them after the ladder would make a killed ingest re-download the
     * whole feed, which the ladder makes harmless but which costs the publisher
     * a request we promised not to make.
     */
    const id = await makeDueFeed();
    await prisma.$executeRaw`
      UPDATE cadence.feeds
      SET etag = 'W/"stored-before-the-kill"', body_hash = decode(md5('b'), 'hex')
      WHERE id = ${id}`;

    await claimDueFeeds(25, made);
    // Killed.
    await expireLease(id);

    const recovered = (await claimDueFeeds(25, made)).find((f) => f.id === id);
    expect(recovered?.etag).toBe('W/"stored-before-the-kill"');
    expect(recovered?.bodyHash).not.toBeNull();
  });

  it("writes a fetch_log row for the killed tick's own abandonment? No — and that is right", async () => {
    /*
     * Recorded as a test because the absence is deliberate and would otherwise
     * look like an oversight.
     *
     * A killed function cannot write its own epitaph: whatever it was going to
     * log dies with it. So `fetch_log` has no row for the abandoned attempt,
     * and the evidence that it happened is the LEASE — a feed leased with no
     * corresponding log row is exactly the signature of a tick that died.
     *
     * Trying to pre-write a row at claim time and update it later would mean a
     * row claiming an outcome that never happened, which is worse than a gap.
     */
    const id = await makeDueFeed();
    await claimDueFeeds(25, made);

    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM cadence.fetch_log WHERE feed_id = ${id}`;
    expect(Number(rows[0].n)).toBe(0);

    // And once a tick DOES complete, there is a row.
    await recordPoll(id, emptyCounters(), { statusCode: 304, durationMs: 42, bytes: null });
    const after = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM cadence.fetch_log WHERE feed_id = ${id}`;
    expect(Number(after[0].n)).toBe(1);
  });

  it("uses a lease long enough to outlast any single poll", async () => {
    // The fetch times out at 10 s, so 120 s is ~12x the worst case. A lease
    // shorter than a poll would let the next tick in while the first is still
    // fetching, which is the double fetch the lease exists to prevent.
    expect(LEASE_SECONDS).toBeGreaterThan(10 * 10);
  });
});
