import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/client";
import { CAN_WRITE_DB } from "@/lib/db/guards";

import { applyMergePlan, type MergePlan } from "./merge";

/*
 * What this suite is for: a migration that half-works.
 *
 * `planMerges` is pure and well covered. `applyMergePlan` is a hundred-odd
 * lines of hand-written SQL that ran with NO test at all — the one test it had
 * asserted it threw `NotImplementedInStaticPhase`, and implementing it deleted
 * that.
 *
 * Which is the worst possible coverage shape for this particular function. It
 * runs ONCE per `NORM_VERSION` bump, against a table that already holds
 * articles people have read, and a mistake is not re-runnable: the rows are
 * gone. "It typechecks" is not evidence that a five-step ordered transaction
 * moved read state correctly.
 *
 * Every case here uses a group with TWO losers, because one loser hides the
 * bugs: an `UPDATE ... FROM user_articles` with a single match looks right and
 * silently picks one row arbitrarily with two.
 */

const describeDb = CAN_WRITE_DB ? describe : describe.skip;

let seq = 0;
const unique = () => `${Date.now()}-${seq++}`;

type Made = { feedId: bigint; userId: string };
const made: Made[] = [];

async function makeFeed(): Promise<bigint> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    INSERT INTO cadence.feeds (feed_url, url_hash, title, clean_polls, status)
    VALUES (${`https://merge-${unique()}.example/feed`},
            decode(md5(random()::text), 'hex'), 'Merge probe', 3, 'active')
    RETURNING id`;
  return rows[0].id;
}

async function makeUser(): Promise<string> {
  const id = `merge-user-${unique()}`;
  await prisma.$executeRaw`
    INSERT INTO cadence.users (id, email, name)
    VALUES (${id}, ${`${id}@probe.example`}, 'Merge probe')`;
  return id;
}

/** An article with a given address, and an `article_urls` row for it. */
async function makeArticle(feedId: bigint, url: string, title: string): Promise<bigint> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    INSERT INTO cadence.articles
      (feed_id, url, url_hash, content_hash, title, published_at, norm_version)
    VALUES (${feedId}, ${url},
            decode(md5(${url}), 'hex'), decode(md5(${title}), 'hex'),
            ${title}, now(), 1)
    RETURNING id`;
  const id = rows[0].id;
  await prisma.$executeRaw`
    INSERT INTO cadence.article_urls (url_hash, article_id, url, first_seen_at)
    VALUES (decode(md5(${url}), 'hex'), ${id}, ${url}, now())`;
  await prisma.$executeRaw`
    INSERT INTO cadence.article_feeds (article_id, feed_id, url, first_seen_at)
    VALUES (${id}, ${feedId}, ${url}, now())`;
  return id;
}

async function setState(
  userId: string,
  articleId: bigint,
  state: { readAt?: string; savedAt?: string; progress?: number; wasReadAt?: string },
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO cadence.user_articles
      (user_id, article_id, read_at, saved_at, progress, was_read_at)
    VALUES (${userId}, ${articleId},
            ${state.readAt ? new Date(state.readAt) : null},
            ${state.savedAt ? new Date(state.savedAt) : null},
            ${state.progress ?? null},
            ${state.wasReadAt ? new Date(state.wasReadAt) : null})`;
}

/**
 * A hex digest for a hash the test wants to name.
 *
 * md5, matching `makeArticle`'s `decode(md5(url), 'hex')`. These are not
 * canonical-url hashes and do not need to be — the executor is given hashes
 * and never computes one, so what matters is that the test and the fixture
 * rows agree.
 */
const hex = (s: string) => createHash("md5").update(s).digest("hex");

describeDb("applying a merge plan", { timeout: 120_000 }, () => {
  afterEach(async () => {
    for (const { feedId, userId } of made) {
      await prisma.$executeRaw`DELETE FROM cadence.feeds WHERE id = ${feedId}`;
      await prisma.$executeRaw`DELETE FROM cadence.users WHERE id = ${userId}`;
    }
    made.length = 0;
  });

  it("keeps the EARLIEST read across THREE rows, not one of them", async () => {
    /*
     * The guarantee: a merge may only ever ADD read state (§6.1). Losing a
     * read is what makes the unread count lie, and the count is what the
     * product's credibility rests on.
     *
     * Three rows because two hide the bug. The winner is unread, one loser was
     * read in January, the other in March. Anything other than January means
     * a read moved FORWARD in time.
     */
    const feedId = await makeFeed();
    const userId = await makeUser();
    made.push({ feedId, userId });

    const keep = await makeArticle(feedId, "https://m.example/a", "A");
    const dropA = await makeArticle(feedId, "https://m.example/a?si=1", "A");
    const dropB = await makeArticle(feedId, "https://m.example/a?si=2", "A");

    await setState(userId, dropB, { readAt: "2026-03-01T00:00:00.000Z", progress: 20 });
    await setState(userId, dropA, { readAt: "2026-01-01T00:00:00.000Z", progress: 80 });

    await applyMergePlan(planFor(keep, [dropA, dropB], "https://m.example/a"));

    const rows = await prisma.$queryRaw<{ read_at: Date | null; progress: number | null }[]>`
      SELECT read_at, progress FROM cadence.user_articles
      WHERE user_id = ${userId} AND article_id = ${keep}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].read_at?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    // And the FURTHEST position, from the other loser. `UPDATE ... FROM` with
    // two losers joins twice and takes one unpredictably — so this was 20 or
    // 80 depending on the plan the planner chose.
    expect(rows[0].progress).toBe(80);
  });

  it("carries was_read_at, which the losers take with them when deleted", async () => {
    // M8's resurface state. It was dropped entirely, because the union was
    // built from `MergePlanGroup.userState` — a type with no such field — so
    // the column was never written and the only rows holding it were deleted.
    const feedId = await makeFeed();
    const userId = await makeUser();
    made.push({ feedId, userId });

    const keep = await makeArticle(feedId, "https://m.example/b", "B");
    const drop = await makeArticle(feedId, "https://m.example/b?si=1", "B");
    await setState(userId, drop, { wasReadAt: "2026-02-02T00:00:00.000Z" });

    await applyMergePlan(planFor(keep, [drop], "https://m.example/b"));

    const rows = await prisma.$queryRaw<{ was_read_at: Date | null }[]>`
      SELECT was_read_at FROM cadence.user_articles
      WHERE user_id = ${userId} AND article_id = ${keep}`;
    expect(rows[0]?.was_read_at?.toISOString()).toBe("2026-02-02T00:00:00.000Z");
  });

  it("leaves every loser address resolving to the winner", async () => {
    // Step 1, and the reason it is step 1. An address that stops resolving is
    // re-inserted as a new article by the next poll — a migration meant to
    // REMOVE duplicates manufacturing them.
    const feedId = await makeFeed();
    const userId = await makeUser();
    made.push({ feedId, userId });

    const keep = await makeArticle(feedId, "https://m.example/c", "C");
    const dropA = await makeArticle(feedId, "https://m.example/c?si=1", "C");
    const dropB = await makeArticle(feedId, "https://m.example/c?si=2", "C");

    await applyMergePlan(planFor(keep, [dropA, dropB], "https://m.example/c"));

    const rows = await prisma.$queryRaw<{ article_id: bigint; url: string }[]>`
      SELECT article_id, url FROM cadence.article_urls
      WHERE url_hash = ANY(ARRAY[
        decode(md5('https://m.example/c'), 'hex'),
        decode(md5('https://m.example/c?si=1'), 'hex'),
        decode(md5('https://m.example/c?si=2'), 'hex')
      ]::bytea[])`;
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.article_id).toBe(keep);
  });

  it("moves the losers' ARRIVALS, so 'also in N feeds' does not undercount", async () => {
    const feedA = await makeFeed();
    const feedB = await makeFeed();
    const userId = await makeUser();
    made.push({ feedId: feedA, userId });
    made.push({ feedId: feedB, userId: await makeUser() });

    const keep = await makeArticle(feedA, "https://m.example/d", "D");
    const drop = await makeArticle(feedB, "https://m.example/d?si=1", "D");

    await applyMergePlan(planFor(keep, [drop], "https://m.example/d"));

    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(DISTINCT feed_id) AS n FROM cadence.article_feeds
      WHERE article_id = ${keep}`;
    expect(Number(rows[0].n)).toBe(2);
  });

  it("deletes the losers and writes the winner's new key", async () => {
    const feedId = await makeFeed();
    const userId = await makeUser();
    made.push({ feedId, userId });

    const keep = await makeArticle(feedId, "https://m.example/e", "E");
    const drop = await makeArticle(feedId, "https://m.example/e?si=1", "E");

    const applied = await applyMergePlan(planFor(keep, [drop], "https://m.example/e"));

    expect(applied.groupsMerged).toBe(1);
    expect(applied.rowsDeleted).toBe(1);

    const left = await prisma.$queryRaw<{ id: bigint; url_hash: Uint8Array }[]>`
      SELECT id, url_hash FROM cadence.articles WHERE feed_id = ${feedId}`;
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe(keep);
    expect(Buffer.from(left[0].url_hash).toString("hex")).toBe(hex("https://m.example/e"));
  });

  it("REHASHES A CHAIN, where one row's new key is another's current key", async () => {
    /*
     * The ordering failure that has no correct order.
     *
     *     row 1   url_hash H1  ->  H2
     *     row 2   url_hash H2  ->  H3     <- still holding H2
     *
     * Neither shares a new hash with anyone, so both are `rehashOnly` rather
     * than a group. But `url_hash` is uniquely indexed and checked per row as
     * the statement walks them, in an order nothing specifies — so row 1 can
     * be updated while row 2 still holds H2 and the write is REFUSED
     * mid-migration. A straight swap cannot be ordered correctly at all.
     *
     * Vacating every row first is what makes the order irrelevant.
     */
    const feedId = await makeFeed();
    const userId = await makeUser();
    made.push({ feedId, userId });

    const one = await makeArticle(feedId, "https://m.example/h1", "H1");
    const two = await makeArticle(feedId, "https://m.example/h2", "H2");

    const applied = await applyMergePlan({
      groups: [],
      rehashOnly: [
        // 1 claims the hash 2 currently holds...
        { id: Number(one), urlHash: hex("https://m.example/h2") },
        // ...and 2 moves on to a free one.
        { id: Number(two), urlHash: hex("https://m.example/h3") },
      ],
      unchanged: 0,
    });

    expect(applied.rehashed).toBe(2);

    const rows = await prisma.$queryRaw<{ id: bigint; url_hash: Uint8Array }[]>`
      SELECT id, url_hash FROM cadence.articles WHERE feed_id = ${feedId} ORDER BY id`;
    const byId = new Map(rows.map((r) => [r.id, Buffer.from(r.url_hash).toString("hex")]));
    expect(byId.get(one)).toBe(hex("https://m.example/h2"));
    expect(byId.get(two)).toBe(hex("https://m.example/h3"));
  });

  it("REHASHES A SWAP, which no ordering can satisfy", async () => {
    // The cycle. Two rows exchanging keys cannot be done one at a time in any
    // order, so a fix that only sorted the updates would still fail here.
    const feedId = await makeFeed();
    const userId = await makeUser();
    made.push({ feedId, userId });

    const one = await makeArticle(feedId, "https://m.example/s1", "S1");
    const two = await makeArticle(feedId, "https://m.example/s2", "S2");

    await applyMergePlan({
      groups: [],
      rehashOnly: [
        { id: Number(one), urlHash: hex("https://m.example/s2") },
        { id: Number(two), urlHash: hex("https://m.example/s1") },
      ],
      unchanged: 0,
    });

    const rows = await prisma.$queryRaw<{ id: bigint; url_hash: Uint8Array }[]>`
      SELECT id, url_hash FROM cadence.articles WHERE feed_id = ${feedId}`;
    const byId = new Map(rows.map((r) => [r.id, Buffer.from(r.url_hash).toString("hex")]));
    expect(byId.get(one)).toBe(hex("https://m.example/s2"));
    expect(byId.get(two)).toBe(hex("https://m.example/s1"));
  });

  it("does nothing, successfully, for an empty plan", async () => {
    const applied = await applyMergePlan({ groups: [], rehashOnly: [], unchanged: 12 });
    expect(applied).toEqual({
      groupsMerged: 0,
      rowsDeleted: 0,
      addressesMoved: 0,
      rehashed: 0,
    });
  });
});

/** A one-group plan, with the addresses the executor needs to insert. */
function planFor(keep: bigint, drops: bigint[], winningUrl: string): MergePlan {
  return {
    groups: [
      {
        urlHash: hex(winningUrl),
        keepId: Number(keep),
        dropIds: drops.map((d) => Number(d)),
        // Ignored by the executor, which unions the ROWS — a plan may be
        // applied long after it was made, and replaying its snapshot would
        // discard every read since. Present because the planner produces it as
        // the dry-run preview.
        userState: [],
        addresses: [{ urlHash: hex(winningUrl), url: winningUrl }],
      },
    ],
    rehashOnly: [],
    unchanged: 0,
  };
}
