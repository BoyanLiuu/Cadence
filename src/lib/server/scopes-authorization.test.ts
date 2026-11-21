import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/client";
import { CAN_WRITE_DB } from "@/lib/db/guards";
import type { Viewer } from "@/lib/types";

import { countUnread, getArticle, listArticles } from "./article-service.db";

/*
 * What this suite is for: the filter IS the authorization model (§3).
 *
 * RLS is enabled policy-less as defence in depth, and the role Prisma connects
 * as owns the tables and therefore BYPASSES it. So nothing stops one reader
 * seeing another's articles except the `where` clause in each query — which
 * makes a missing or overwritten filter a data leak rather than a bug.
 *
 * This file was referenced in a comment in `article-service.db.ts` as the test
 * that catches a subscription filter going missing. It did not exist. The
 * fixtures cannot stand in for it: all twelve fixture feeds belong to the one
 * fixture user, so no fixture case distinguishes "subscribed" from "exists".
 *
 * The second subject is AGREEMENT. Lists match on arrivals and `getArticle`
 * must match the same way, or the reader gets a row that opens to nothing.
 */

const describeDb = CAN_WRITE_DB ? describe : describe.skip;

let seq = 0;
const unique = () => `${Date.now()}-${seq++}`;

const viewerFor = (id: string): Viewer => ({
  kind: "user",
  user: {
    id,
    email: `${id}@probe.example`,
    name: "Scope probe",
    initials: "SP",
    tz: "UTC",
    aiEnabled: false,
  },
});

const cleanup: { users: string[]; feeds: bigint[] } = { users: [], feeds: [] };

async function makeUser(): Promise<string> {
  const id = `scope-user-${unique()}`;
  await prisma.$executeRaw`
    INSERT INTO cadence.users (id, email, name)
    VALUES (${id}, ${`${id}@probe.example`}, 'Scope probe')`;
  cleanup.users.push(id);
  return id;
}

async function makeFeed(title: string): Promise<bigint> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    INSERT INTO cadence.feeds (feed_url, url_hash, title, clean_polls, status)
    VALUES (${`https://scope-${unique()}.example/feed`},
            decode(md5(random()::text), 'hex'), ${title}, 3, 'active')
    RETURNING id`;
  cleanup.feeds.push(rows[0].id);
  return rows[0].id;
}

async function subscribe(userId: string, feedId: bigint): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO cadence.subscriptions (user_id, feed_id, created_at)
    VALUES (${userId}, ${feedId}, now())`;
}

/**
 * An article owned by `ownerFeed`, with arrivals through every feed given.
 *
 * `articles.feed_id` is the owner; `article_feeds` is who delivered it. Those
 * differ exactly when rung 2 collapses a story across feeds, which is the
 * situation every case here is about.
 */
async function makeArticle(
  ownerFeed: bigint,
  arrivalFeeds: bigint[],
  title: string,
): Promise<number> {
  const url = `https://scope-${unique()}.example/post`;
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    INSERT INTO cadence.articles
      (feed_id, url, url_hash, content_hash, title, published_at, norm_version)
    VALUES (${ownerFeed}, ${url},
            decode(md5(${url}), 'hex'), decode(md5(${title}), 'hex'),
            ${title}, now(), 1)
    RETURNING id`;
  const id = rows[0].id;
  for (const feedId of arrivalFeeds) {
    await prisma.$executeRaw`
      INSERT INTO cadence.article_feeds (article_id, feed_id, url, first_seen_at)
      VALUES (${id}, ${feedId}, ${url}, now())`;
  }
  return Number(id);
}

describeDb("scopes are authorized by the filter, not by RLS", { timeout: 120_000 }, () => {
  afterEach(async () => {
    if (cleanup.feeds.length > 0) {
      await prisma.$executeRaw`DELETE FROM cadence.feeds WHERE id = ANY(${cleanup.feeds}::bigint[])`;
    }
    for (const id of cleanup.users) {
      await prisma.$executeRaw`DELETE FROM cadence.users WHERE id = ${id}`;
    }
    cleanup.feeds.length = 0;
    cleanup.users.length = 0;
  });

  it("does NOT list a feed the reader has not subscribed to", async () => {
    /*
     * The leak. `/feed/<id>` takes an id from the URL, so this is reachable by
     * typing a number — and the `feed` scope once spread a `base` containing
     * nothing but `feedId` and then set `feedId` on the next line, which
     * overwrote the spread and removed the subscription filter entirely.
     */
    const mine = await makeUser();
    const theirs = await makeUser();
    const myFeed = await makeFeed("Mine");
    const theirFeed = await makeFeed("Theirs");
    await subscribe(mine, myFeed);
    await subscribe(theirs, theirFeed);
    await makeArticle(theirFeed, [theirFeed], `Not mine ${unique()}`);

    const page = await listArticles(viewerFor(mine), {
      kind: "feed",
      feedId: Number(theirFeed),
      unreadOnly: false,
    });
    expect(page.items).toEqual([]);
  });

  it("lists an article delivered by a subscribed feed but OWNED by another", async () => {
    /*
     * The other direction, and the reason the filter moved to arrivals.
     *
     * Rung 2 is global, so one story through two feeds is one row owned by
     * whichever polled first. Filtering on `articles.feed_id` hid the article
     * from the second feed's own list — dedup reading as an article going
     * missing, which is the cost Appendix G question 2 warns about.
     */
    const reader = await makeUser();
    const ownerFeed = await makeFeed("Got there first");
    const myFeed = await makeFeed("The one I follow");
    await subscribe(reader, myFeed);
    const title = `Carried by mine ${unique()}`;
    await makeArticle(ownerFeed, [ownerFeed, myFeed], title);

    const page = await listArticles(viewerFor(reader), {
      kind: "feed",
      feedId: Number(myFeed),
      unreadOnly: false,
    });
    expect(page.items.map((a) => a.title)).toContain(title);
  });

  it("OPENS every article it lists, so no row opens to nothing", async () => {
    /*
     * Agreement between two queries, which is its own class of bug.
     *
     * The lists moved to arrivals and `getArticle` kept matching the OWNING
     * feed's subscription — so this exact article appeared in the list and
     * returned null when clicked. Nothing in either function looks wrong on
     * its own; only the pair is wrong.
     */
    const reader = await makeUser();
    const ownerFeed = await makeFeed("Got there first");
    const myFeed = await makeFeed("The one I follow");
    await subscribe(reader, myFeed);
    await makeArticle(ownerFeed, [ownerFeed, myFeed], `Openable ${unique()}`);

    const viewer = viewerFor(reader);
    const page = await listArticles(viewer, { kind: "all" });
    expect(page.items.length).toBeGreaterThan(0);

    for (const item of page.items) {
      const opened = await getArticle(viewer, item.id);
      expect(opened, `article ${item.id} is listed but does not open`).not.toBeNull();
    }
  });

  it("does NOT open an article reachable through no subscribed feed", async () => {
    // The negative half. An authorization check that passed everything would
    // satisfy the case above.
    const reader = await makeUser();
    const theirs = await makeUser();
    const myFeed = await makeFeed("Mine");
    const theirFeed = await makeFeed("Theirs");
    await subscribe(reader, myFeed);
    await subscribe(theirs, theirFeed);
    const id = await makeArticle(theirFeed, [theirFeed], `Theirs ${unique()}`);

    expect(await getArticle(viewerFor(reader), id)).toBeNull();
  });

  it("counts a two-feed story ONCE, not once per arrival", async () => {
    /*
     * The header's number. Summing the sidebar's per-feed badges was correct
     * only while an article belonged to exactly one feed: each badge counts a
     * collapsed story correctly, and the sum counts it twice — so the header
     * read "2 unread" above a list holding one row.
     *
     * §6.1 puts the product's credibility on this count, so it gets its own
     * query rather than an addition at the call site.
     */
    const reader = await makeUser();
    const feedA = await makeFeed("Outlet A");
    const feedB = await makeFeed("Outlet B");
    await subscribe(reader, feedA);
    await subscribe(reader, feedB);
    // ONE article, delivered by BOTH feeds — exactly what rung 2 produces.
    await makeArticle(feedA, [feedA, feedB], `Syndicated ${unique()}`);

    const viewer = viewerFor(reader);
    expect(await countUnread(viewer, { kind: "unread" })).toBe(1);

    // And the per-feed badges still say 1 each, which is also correct: each
    // feed does carry it. That disagreement is why the sum was wrong and why
    // the header cannot be built from it.
    expect(await countUnread(viewer, { kind: "feed", feedId: Number(feedA) })).toBe(1);
    expect(await countUnread(viewer, { kind: "feed", feedId: Number(feedB) })).toBe(1);
  });

  it("counts nothing for a reader with no subscriptions", async () => {
    const reader = await makeUser();
    expect(await countUnread(viewerFor(reader), { kind: "unread" })).toBe(0);
  });
});
