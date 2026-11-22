import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/client";
import { CAN_WRITE_DB } from "@/lib/db/guards";
import type { RawItem } from "@/lib/types";

import { type FeedTrust } from "./dedupe";
import { runPoll } from "./poll";

/*
 * What this suite is for: the bug that destroys trust.
 *
 * §6.2: an edit is NOT a re-publication. A publisher fixing a typo must not
 * re-notify every subscriber, and a CMS that re-renders bodies on every deploy
 * would otherwise make a feed PERMANENTLY and falsely unread — an unread count
 * that cannot be cleared, which §6.1 names as the failure that actually loses
 * readers.
 *
 * So a revision must produce exactly ONE row, with `revised_at` set,
 * `revision_count` incremented, and **`read_at` untouched**. The hedge is a
 * per-subscription `resurface_on_revision`, off by default, and that is
 * Appendix G question 3 settled — see `revise.ts` for the reasoning.
 */

const describeDb = CAN_WRITE_DB ? describe : describe.skip;

let seq = 0;
const unique = () => `${Date.now()}-${seq++}`;

const TRANSPORT = { statusCode: 200, durationMs: 120, bytes: 2048 };

const item = (o: Partial<RawItem> = {}): RawItem => ({
  guid: null,
  url: null,
  title: "An article that will be edited",
  author: null,
  publishedAt: "2026-11-12T09:12:00.000Z",
  contentHtml: "<p>The body as first published.</p>",
  summaryHtml: null,
  xmlBase: null,
  ...o,
});

const made: { feeds: bigint[]; users: string[] } = { feeds: [], users: [] };

async function makeFeed(): Promise<FeedTrust> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    INSERT INTO cadence.feeds (feed_url, url_hash, title, clean_polls, status)
    VALUES (${`https://revision-${unique()}.example/feed`},
            decode(md5(random()::text), 'hex'), 'Revision probe', 3, 'active')
    RETURNING id`;
  made.feeds.push(rows[0].id);
  return { id: rows[0].id, guidUnstable: false, cleanPolls: 3, guidTrustOverride: "auto" };
}

/** A reader subscribed to the feed, with resurfacing on or off. */
async function makeReader(feedId: bigint, resurface: boolean): Promise<string> {
  const id = `rev-user-${unique()}`;
  await prisma.$executeRaw`
    INSERT INTO cadence.users (id, email, name)
    VALUES (${id}, ${`${id}@probe.example`}, 'Revision probe')`;
  await prisma.$executeRaw`
    INSERT INTO cadence.subscriptions (user_id, feed_id, resurface_on_revision, created_at)
    VALUES (${id}, ${feedId}, ${resurface}, now())`;
  made.users.push(id);
  return id;
}

async function markRead(userId: string, articleId: bigint, at: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO cadence.user_articles (user_id, article_id, read_at)
    VALUES (${userId}, ${articleId}, ${new Date(at)})`;
}

async function readState(userId: string, articleId: bigint) {
  const rows = await prisma.$queryRaw<{ read_at: Date | null; was_read_at: Date | null }[]>`
    SELECT read_at, was_read_at FROM cadence.user_articles
    WHERE user_id = ${userId} AND article_id = ${articleId}`;
  return rows[0] ?? null;
}

async function articleState(articleId: bigint) {
  const rows = await prisma.$queryRaw<
    { revised_at: Date | null; revision_count: number; content_html: string | null }[]
  >`
    SELECT revised_at, revision_count, content_html FROM cadence.articles
    WHERE id = ${articleId}`;
  return rows[0];
}

describeDb("an edited article", { timeout: 180_000 }, () => {
  afterAll(async () => {
    if (made.feeds.length > 0) {
      await prisma.$executeRaw`DELETE FROM cadence.feeds WHERE id = ANY(${made.feeds}::bigint[])`;
    }
    for (const id of made.users) {
      await prisma.$executeRaw`DELETE FROM cadence.users WHERE id = ${id}`;
    }
    await prisma.$disconnect();
  });

  it("yields ONE row with revised_at set, the count incremented, and read_at UNTOUCHED", async () => {
    // The plan's acceptance criterion, verbatim.
    const feed = await makeFeed();
    const userId = await makeReader(feed.id, false);
    const guid = `edited-${unique()}`;
    const url = `https://revision-${unique()}.example/post`;

    const first = await runPoll(feed, [item({ guid, url })], TRANSPORT);
    expect(first.counters.itemsNew).toBe(1);
    const articleId = await onlyArticle(feed.id);
    await markRead(userId, articleId, "2026-11-13T08:00:00.000Z");

    const edited = await runPoll(
      feed,
      [item({ guid, url, contentHtml: "<p>The body, corrected after publication.</p>" })],
      TRANSPORT,
    );

    expect(edited.counters.itemsNew).toBe(0);
    expect(edited.counters.revised).toBe(1);
    expect(await countArticles(feed.id)).toBe(1);

    const article = await articleState(articleId);
    expect(article.revised_at).not.toBeNull();
    expect(article.revision_count).toBe(1);
    expect(article.content_html).toBe("<p>The body, corrected after publication.</p>");

    // THE ASSERTION. An edit is not a re-publication.
    const state = await readState(userId, articleId);
    expect(state?.read_at?.toISOString()).toBe("2026-11-13T08:00:00.000Z");
    expect(state?.was_read_at).toBeNull();
  });

  it("does not count an UNCHANGED re-poll as a revision", async () => {
    // The negative case, and the one a CMS re-rendering identical bodies hits
    // every tick. Without it, `revision_count` climbs forever and the badge is
    // permanently on.
    const feed = await makeFeed();
    const guid = `unchanged-${unique()}`;
    const url = `https://revision-${unique()}.example/same`;

    await runPoll(feed, [item({ guid, url })], TRANSPORT);
    const articleId = await onlyArticle(feed.id);

    const again = await runPoll(feed, [item({ guid, url })], TRANSPORT);
    expect(again.counters.revised).toBe(0);

    const article = await articleState(articleId);
    expect(article.revised_at).toBeNull();
    expect(article.revision_count).toBe(0);
  });

  it("RESURFACES for a reader who opted in, recording what the read state had been", async () => {
    /*
     * The hedge. For changelogs and status pages the edit IS the news, so
     * `resurface_on_revision` exists — per subscription, because two readers
     * can want different answers about the same feed.
     *
     * `was_read_at` is why this is not simply "clear read_at": the UI can say
     * "you read this on the 13th, it changed on the 14th" rather than
     * presenting a previously-read article as though it were new.
     */
    const feed = await makeFeed();
    const userId = await makeReader(feed.id, true);
    const guid = `resurface-${unique()}`;
    const url = `https://revision-${unique()}.example/changelog`;

    await runPoll(feed, [item({ guid, url })], TRANSPORT);
    const articleId = await onlyArticle(feed.id);
    await markRead(userId, articleId, "2026-11-13T08:00:00.000Z");

    const edited = await runPoll(
      feed,
      [item({ guid, url, contentHtml: "<p>Status changed to resolved.</p>" })],
      TRANSPORT,
    );
    expect(edited.resurfaced).toHaveLength(1);
    expect(edited.resurfaced[0].userId).toBe(userId);

    const state = await readState(userId, articleId);
    expect(state?.read_at).toBeNull();
    expect(state?.was_read_at?.toISOString()).toBe("2026-11-13T08:00:00.000Z");
  });

  it("keeps the ORIGINAL read time across a second revision", async () => {
    // A second edit before the reader catches up must not overwrite
    // `was_read_at` with the null `read_at` the first resurface left behind —
    // that would erase the answer to "when did you read it".
    const feed = await makeFeed();
    const userId = await makeReader(feed.id, true);
    const guid = `twice-${unique()}`;
    const url = `https://revision-${unique()}.example/twice`;

    await runPoll(feed, [item({ guid, url })], TRANSPORT);
    const articleId = await onlyArticle(feed.id);
    await markRead(userId, articleId, "2026-11-13T08:00:00.000Z");

    await runPoll(feed, [item({ guid, url, contentHtml: "<p>Edit one.</p>" })], TRANSPORT);
    await runPoll(feed, [item({ guid, url, contentHtml: "<p>Edit two.</p>" })], TRANSPORT);

    const state = await readState(userId, articleId);
    expect(state?.read_at).toBeNull();
    expect(state?.was_read_at?.toISOString()).toBe("2026-11-13T08:00:00.000Z");

    const article = await articleState(articleId);
    expect(article.revision_count).toBe(2);
  });

  it("does NOT resurface a reader who never read it", async () => {
    // §6.2: a missing `user_articles` row means unread. Writing one here would
    // defeat the mechanism, and `was_read_at` would claim a read that never
    // happened.
    const feed = await makeFeed();
    const userId = await makeReader(feed.id, true);
    const guid = `unread-${unique()}`;
    const url = `https://revision-${unique()}.example/unread`;

    await runPoll(feed, [item({ guid, url })], TRANSPORT);
    const articleId = await onlyArticle(feed.id);

    const edited = await runPoll(
      feed,
      [item({ guid, url, contentHtml: "<p>Edited.</p>" })],
      TRANSPORT,
    );
    expect(edited.resurfaced).toHaveLength(0);
    expect(await readState(userId, articleId)).toBeNull();
  });

  it("resurfaces only the readers who OPTED IN, on the same article", async () => {
    // Per-subscription, not per-feed. Two readers of one feed, one of whom
    // asked for resurfacing — the other's read must survive untouched.
    const feed = await makeFeed();
    const optedIn = await makeReader(feed.id, true);
    const optedOut = await makeReader(feed.id, false);
    const guid = `mixed-${unique()}`;
    const url = `https://revision-${unique()}.example/mixed`;

    await runPoll(feed, [item({ guid, url })], TRANSPORT);
    const articleId = await onlyArticle(feed.id);
    await markRead(optedIn, articleId, "2026-11-13T08:00:00.000Z");
    await markRead(optedOut, articleId, "2026-11-13T09:00:00.000Z");

    const edited = await runPoll(
      feed,
      [item({ guid, url, contentHtml: "<p>Edited once.</p>" })],
      TRANSPORT,
    );

    expect(edited.resurfaced.map((r) => r.userId)).toEqual([optedIn]);
    expect((await readState(optedIn, articleId))?.read_at).toBeNull();
    expect((await readState(optedOut, articleId))?.read_at?.toISOString()).toBe(
      "2026-11-13T09:00:00.000Z",
    );
  });

  it("does NOT resurface via an opted-in subscription to a DIFFERENT feed", async () => {
    /*
     * `subscriptions` and `user_articles` share only `user_id`, so an
     * `UPDATE … FROM subscriptions` without a feed join would resurface every
     * article a reader has ever read the moment they opt in anywhere.
     */
    const carrier = await makeFeed();
    const other = await makeFeed();
    const userId = await makeReader(other.id, true);
    // Subscribed to the carrier too, but WITHOUT resurfacing.
    await prisma.$executeRaw`
      INSERT INTO cadence.subscriptions (user_id, feed_id, resurface_on_revision, created_at)
      VALUES (${userId}, ${carrier.id}, false, now())`;

    const guid = `wrongfeed-${unique()}`;
    const url = `https://revision-${unique()}.example/wrongfeed`;
    await runPoll(carrier, [item({ guid, url })], TRANSPORT);
    const articleId = await onlyArticle(carrier.id);
    await markRead(userId, articleId, "2026-11-13T08:00:00.000Z");

    const edited = await runPoll(
      carrier,
      [item({ guid, url, contentHtml: "<p>Edited.</p>" })],
      TRANSPORT,
    );

    expect(edited.resurfaced).toHaveLength(0);
    expect((await readState(userId, articleId))?.read_at?.toISOString()).toBe(
      "2026-11-13T08:00:00.000Z",
    );
  });
});

async function onlyArticle(feedId: bigint): Promise<bigint> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT id FROM cadence.articles WHERE feed_id = ${feedId} ORDER BY id LIMIT 1`;
  return rows[0].id;
}

async function countArticles(feedId: bigint): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM cadence.articles WHERE feed_id = ${feedId}`;
  return Number(rows[0].n);
}
