import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/client";
import { CAN_WRITE_DB } from "@/lib/db/guards";

import { createHash } from "node:crypto";

import { canonicalUrl } from "@/lib/ingest/canonical-url";

import { claimDueFeeds, releaseFeed, storeValidators, LEASE_SECONDS } from "./claim";

/*
 * What this suite is for: the double fetch that overlapping ticks cause, and
 * the feed stuck forever by a tick that died.
 *
 * §6.4 uses TWO mechanisms and they do different jobs. Being precise about
 * which does which matters, because an earlier version of this comment had it
 * backwards and the test below proved it by passing with `SKIP LOCKED` removed:
 *
 *   lease_until              CORRECTNESS. A column, so it outlives the process,
 *                            and its predicate is what makes a second claim of
 *                            the same feed return nothing. A killed function
 *                            drops its connection — which releases every lock
 *                            instantly — while its work may still be in flight.
 *   FOR UPDATE SKIP LOCKED   THROUGHPUT. Without it a second tick blocks on the
 *                            first's row locks and only then finds it has
 *                            nothing to claim. Same answer, but it spent its
 *                            budget waiting.
 *
 * So the lease is what these tests mostly pin, and `SKIP LOCKED` gets its own
 * case measuring the thing it actually changes: whether a contended claim
 * WAITS.
 */

const describeDb = CAN_WRITE_DB ? describe : describe.skip;

let seq = 0;
const unique = () => `${Date.now()}-${seq++}`;

const made: bigint[] = [];

/** A feed due `dueSecondsAgo` seconds ago, with no lease. */
async function makeDueFeed(dueSecondsAgo = 60): Promise<bigint> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    INSERT INTO cadence.feeds
      (feed_url, url_hash, title, status, next_fetch_at, fetch_interval_s, clean_polls)
    VALUES (${`https://claim-${unique()}.example/feed`},
            decode(md5(random()::text), 'hex'), 'Claim probe', 'active',
            now() - make_interval(secs => ${dueSecondsAgo}), 3600, 3)
    RETURNING id`;
  made.push(rows[0].id);
  return rows[0].id;
}

async function leaseOf(feedId: bigint): Promise<Date | null> {
  const rows = await prisma.$queryRaw<{ lease_until: Date | null }[]>`
    SELECT lease_until FROM cadence.feeds WHERE id = ${feedId}`;
  return rows[0].lease_until;
}

describeDb("claiming due feeds under a lease", { timeout: 120_000 }, () => {
  afterEach(async () => {
    if (made.length > 0) {
      await prisma.$executeRaw`DELETE FROM cadence.feeds WHERE id = ANY(${made}::bigint[])`;
      made.length = 0;
    }
  });

  it("claims a due feed and stamps a lease on it", async () => {
    const id = await makeDueFeed();
    const claimed = await claimDueFeeds(25, made);

    expect(claimed.map((f) => f.id)).toContain(id);
    const lease = await leaseOf(id);
    expect(lease).not.toBeNull();
    // Roughly `LEASE_SECONDS` out. Generous bounds: the point is that a lease
    // was written, not that the clocks agree to the millisecond.
    const ahead = (lease!.getTime() - Date.now()) / 1000;
    expect(ahead).toBeGreaterThan(LEASE_SECONDS - 30);
    expect(ahead).toBeLessThanOrEqual(LEASE_SECONDS + 5);
  });

  it("TWO CONCURRENT CLAIMS over one due feed yield exactly ONE fetch", async () => {
    /*
     * The plan's acceptance criterion, and the failure it prevents is a double
     * fetch of every feed every minute — which is both rude to publishers and
     * the thing that makes a reader's poller get blocked.
     *
     * Run genuinely in parallel, because that is the case: the pinger fires
     * every few minutes and a slow tick overlaps the next one.
     */
    const id = await makeDueFeed();

    const [a, b] = await Promise.all([claimDueFeeds(25, made), claimDueFeeds(25, made)]);
    const claims = [...a, ...b].filter((f) => f.id === id);

    expect(claims).toHaveLength(1);
  });

  it("does not WAIT on a feed another transaction has locked", async () => {
    /*
     * What `SKIP LOCKED` is actually for.
     *
     * Correctness comes from the lease predicate — a second claim finds
     * `lease_until > now()` and returns nothing either way. What `SKIP LOCKED`
     * changes is whether the second tick BLOCKS while discovering that. With
     * plain `FOR UPDATE` it waits for the holding transaction to commit, which
     * against a 240-second budget means a tick that spends it doing nothing.
     *
     * Simulated by holding a real lock open in a transaction, which is exactly
     * the state a tick mid-claim is in.
     */
    const locked = await makeDueFeed();
    const other = await makeDueFeed();

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Lock `locked`'s row and keep the transaction open.
    const holding = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM cadence.feeds WHERE id = ${locked} FOR UPDATE`;
      await held;
    });
    // Give the lock time to be taken before claiming.
    await new Promise((r) => setTimeout(r, 150));

    const started = Date.now();
    const claimed = await claimDueFeeds(25, made);
    const waited = Date.now() - started;

    release();
    await holding;

    // Stepped over the locked row and got on with the other feed...
    expect(claimed.map((f) => f.id)).not.toContain(locked);
    expect(claimed.map((f) => f.id)).toContain(other);
    // ...promptly, rather than waiting for the holding transaction.
    expect(waited).toBeLessThan(1000);
  });

  it("does not re-claim a feed whose lease is still live", async () => {
    // The lease doing its job within one process, which is also what makes a
    // long-running tick safe to overlap with the next one.
    const id = await makeDueFeed();
    const first = await claimDueFeeds(25, made);
    expect(first.map((f) => f.id)).toContain(id);

    const second = await claimDueFeeds(25, made);
    expect(second.map((f) => f.id)).not.toContain(id);
  });

  it("does not claim a feed that is not due yet", async () => {
    const rows = await prisma.$queryRaw<{ id: bigint }[]>`
      INSERT INTO cadence.feeds
        (feed_url, url_hash, title, status, next_fetch_at, fetch_interval_s)
      VALUES (${`https://future-${unique()}.example/feed`},
              decode(md5(random()::text), 'hex'), 'Not due', 'active',
              now() + interval '1 hour', 3600)
      RETURNING id`;
    made.push(rows[0].id);

    const claimed = await claimDueFeeds(25, made);
    expect(claimed.map((f) => f.id)).not.toContain(rows[0].id);
  });

  it("does not claim a DEAD feed, which is why retrying forever costs nothing", async () => {
    /*
     * §6.4: a dead feed drops out of the due index entirely. The `feeds_due`
     * partial index is `WHERE status IN ('active','backoff')`, so this is not a
     * filter applied to a scan — the rows are not in the index at all.
     */
    for (const status of ["dead", "not_a_feed"] as const) {
      const rows = await prisma.$queryRaw<{ id: bigint }[]>`
        INSERT INTO cadence.feeds
          (feed_url, url_hash, title, status, next_fetch_at, fetch_interval_s)
        VALUES (${`https://${status}-${unique()}.example/feed`},
                decode(md5(random()::text), 'hex'), ${status}, ${status}::cadence.feed_status,
                now() - interval '1 hour', 3600)
        RETURNING id`;
      made.push(rows[0].id);
      const claimed = await claimDueFeeds(25, made);
      expect(
        claimed.map((f) => f.id),
        status,
      ).not.toContain(rows[0].id);
    }
  });

  it("DOES claim a backoff feed, because a retry is the point of backoff", async () => {
    const rows = await prisma.$queryRaw<{ id: bigint }[]>`
      INSERT INTO cadence.feeds
        (feed_url, url_hash, title, status, next_fetch_at, fetch_interval_s, consecutive_failures)
      VALUES (${`https://backoff-${unique()}.example/feed`},
              decode(md5(random()::text), 'hex'), 'Retrying', 'backoff',
              now() - interval '1 minute', 3600, 3)
      RETURNING id`;
    made.push(rows[0].id);

    const claimed = await claimDueFeeds(25, made);
    expect(claimed.map((f) => f.id)).toContain(rows[0].id);
  });

  it("respects the batch limit, oldest-due first", async () => {
    // §6.4 claims 25 at a time so one tick works through a backlog in batches
    // rather than holding 200 leases while it gets through the first six.
    const older = await makeDueFeed(3600);
    const newer = await makeDueFeed(60);

    const claimed = await claimDueFeeds(1, made);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(older);
    expect(claimed[0].id).not.toBe(newer);
  });

  it("releases the lease and sets the next due time", async () => {
    const id = await makeDueFeed();
    await claimDueFeeds(25, made);
    expect(await leaseOf(id)).not.toBeNull();

    await releaseFeed(id, 1800);

    expect(await leaseOf(id)).toBeNull();
    const rows = await prisma.$queryRaw<{ next_fetch_at: Date }[]>`
      SELECT next_fetch_at FROM cadence.feeds WHERE id = ${id}`;
    const ahead = (rows[0].next_fetch_at.getTime() - Date.now()) / 1000;
    expect(ahead).toBeGreaterThan(1700);
    expect(ahead).toBeLessThan(1900);
  });

  it("moves url_hash WITH feed_url on a permanent redirect", async () => {
    /*
     * `feeds.url_hash` is UNIQUE and is the canonical key for the feed's own
     * address — it is what makes two readers pasting different spellings of one
     * feed share a row.
     *
     * Rewriting `feed_url` and leaving the hash behind breaks that: the row
     * answers to a key nobody will ever compute again, so the next reader who
     * subscribes to the NEW address matches nothing and gets a SECOND feeds row
     * for the same feed — two rows, two polls, two sets of articles racing each
     * other through rung 2. Precisely the duplicate this project is organised
     * against, arriving by the back door.
     */
    const id = await makeDueFeed();
    const before = await prisma.$queryRaw<{ url_hash: Uint8Array }[]>`
      SELECT url_hash FROM cadence.feeds WHERE id = ${id}`;

    const moved = `https://moved-${unique()}.example/new-feed.xml`;
    await storeValidators(
      id,
      { etag: null, lastModified: null, bodyHash: new Uint8Array(32) },
      moved,
    );

    const after = await prisma.$queryRaw<{ feed_url: string; url_hash: Uint8Array }[]>`
      SELECT feed_url, url_hash FROM cadence.feeds WHERE id = ${id}`;
    expect(after[0].feed_url).toBe(moved);
    // The hash moved too.
    expect(Buffer.from(after[0].url_hash).toString("hex")).not.toBe(
      Buffer.from(before[0].url_hash).toString("hex"),
    );
    // And it is the hash a fresh subscribe to that address would compute.
    const expected = createHash("sha256")
      .update(canonicalUrl(moved) ?? moved, "utf8")
      .digest("hex");
    expect(Buffer.from(after[0].url_hash).toString("hex")).toBe(expected);
  });

  it("leaves url_hash alone when there was no redirect", async () => {
    // So an ordinary poll does not rewrite the key on every tick.
    const id = await makeDueFeed();
    const before = await prisma.$queryRaw<{ url_hash: Uint8Array }[]>`
      SELECT url_hash FROM cadence.feeds WHERE id = ${id}`;

    await storeValidators(
      id,
      { etag: 'W/"x"', lastModified: null, bodyHash: new Uint8Array(32) },
      null,
    );

    const after = await prisma.$queryRaw<{ url_hash: Uint8Array }[]>`
      SELECT url_hash FROM cadence.feeds WHERE id = ${id}`;
    expect(Buffer.from(after[0].url_hash).toString("hex")).toBe(
      Buffer.from(before[0].url_hash).toString("hex"),
    );
  });

  it("carries everything the fetch needs, so the claim is one round trip", async () => {
    // A claim that returned only ids would mean a second query per feed before
    // anything could be fetched — 25 extra round trips per batch, against
    // §6.4's 240-second budget for the whole tick.
    const id = await makeDueFeed();
    await prisma.$executeRaw`
      UPDATE cadence.feeds
      SET etag = 'W/"stored"', last_modified = 'Wed, 12 Nov 2026 09:12:00 GMT',
          body_hash = decode(md5('body'), 'hex'), declared_ttl_s = 900
      WHERE id = ${id}`;

    const claimed = (await claimDueFeeds(25, made)).find((f) => f.id === id);
    expect(claimed?.etag).toBe('W/"stored"');
    expect(claimed?.lastModified).toBe("Wed, 12 Nov 2026 09:12:00 GMT");
    expect(claimed?.bodyHash).not.toBeNull();
    expect(claimed?.declaredTtlS).toBe(900);
    // And the trust state, so the ladder does not need its own lookup.
    expect(claimed?.cleanPolls).toBe(3);
    expect(claimed?.guidUnstable).toBe(false);
    expect(claimed?.guidTrustOverride).toBe("auto");
  });
});
