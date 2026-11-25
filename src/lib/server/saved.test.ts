import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/client";
import { CAN_WRITE_DB } from "@/lib/db/guards";

import { applyReadState } from "./read-state.db";
import { ArticleNotReachable, applySaved } from "./saved.db";

/*
 * What this suite is for: the saved shelf's three quiet failures.
 *
 *   SOMEBODY ELSE'S ARTICLE. Articles are global rows (Appendix B), so an id is
 *   a number and the subscription filter is the only thing between two readers.
 *   RLS is bypassed by the owning role; there is nothing behind it.
 *
 *   THE MOMENT IT WAS FILED. `saved_at` is what the shelf orders by, so
 *   overwriting it on a second press silently reshuffles the list.
 *
 *   UNSAVING THE READ MARK. `read_at` lives on the same row, so expressing
 *   "not saved" by deleting it marks the article unread — invisible until
 *   somebody notices their unread count went up.
 *
 * It builds its own reader, feed and articles: the seeded corpus is
 * `service-parity`'s fixture, not scratch space.
 */

const describeDb = CAN_WRITE_DB ? describe : describe.skip;

const sha = (v: string) => new Uint8Array(createHash("sha256").update(v).digest());
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const READER = `user_test_saved_${RUN}`;

describeDb("the saved shelf", () => {
  let mine: bigint;
  let theirs: bigint;
  const feeds: bigint[] = [];

  async function makeFeedWithArticle(label: string) {
    const feed = await prisma.feed.create({
      data: {
        feedUrl: `https://saved-${label}-${RUN}.example/feed`,
        urlHash: sha(`feed-${label}-${RUN}`),
        title: label,
        format: "rss2",
      },
    });
    feeds.push(feed.id);
    const article = await prisma.article.create({
      data: {
        feedId: feed.id,
        url: `https://saved-${label}-${RUN}.example/a`,
        urlHash: sha(`article-${label}-${RUN}`),
        contentHash: sha(`content-${label}-${RUN}`),
        title: `${label} article`,
        publishedAt: new Date(),
        normVersion: 1,
        arrivals: { create: [{ feedId: feed.id }] },
      },
    });
    return { feedId: feed.id, articleId: article.id };
  }

  const rowFor = (articleId: bigint) =>
    prisma.userArticle.findUnique({
      where: { userId_articleId: { userId: READER, articleId } },
    });

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: READER, email: `${READER}@example.invalid`, name: "Saved reader" },
    });
    const followed = await makeFeedWithArticle("followed");
    mine = followed.articleId;
    await prisma.subscription.create({ data: { userId: READER, feedId: followed.feedId } });

    const unfollowed = await makeFeedWithArticle("unfollowed");
    theirs = unfollowed.articleId;
  }, 20_000);

  afterAll(async () => {
    await prisma.userArticle.deleteMany({ where: { userId: READER } });
    await prisma.subscription.deleteMany({ where: { userId: READER } });
    for (const id of feeds) await prisma.feed.delete({ where: { id } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: READER } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("REFUSES an article the reader cannot reach, and writes nothing", async () => {
    await expect(applySaved(READER, Number(theirs), true)).rejects.toBeInstanceOf(
      ArticleNotReachable,
    );

    // On the table, not the thrown error: a refusal means nothing if a row
    // appeared on the way out.
    expect(await rowFor(theirs)).toBeNull();
  });

  it("KEEPS the moment it was first filed when saved again", async () => {
    /*
     * `saved_at` is what the shelf orders by, so `ON CONFLICT DO UPDATE SET
     * saved_at = now()` would pass any "is it saved" check and quietly move the
     * article to the top of the list every time it was pressed.
     */
    await applySaved(READER, Number(mine), true);
    const first = await rowFor(mine);
    expect(first, "no row was written, so there is no timestamp to keep").not.toBeNull();
    expect(first!.savedAt).not.toBeNull();

    await applySaved(READER, Number(mine), true);
    const second = await rowFor(mine);

    expect(second!.savedAt!.getTime()).toBe(first!.savedAt!.getTime());
  });

  it("unsaving CLEARS saved_at and leaves the read mark alone", async () => {
    // The two columns share a row and nothing else. Deleting it to express
    // "not saved" marks the article unread.
    await applySaved(READER, Number(mine), true);
    await applyReadState(READER, [Number(mine)], true);

    await applySaved(READER, Number(mine), false);

    const row = await rowFor(mine);
    expect(row).not.toBeNull();
    expect(row!.savedAt).toBeNull();
    expect(row!.readAt, "unsaving must not un-read").not.toBeNull();
  });

  it("writes NO row for unsaving something that was never saved", async () => {
    // Laziness, as read state relies on: an absent row already means "not
    // saved", so recording that would grow the table for nothing.
    const fresh = await makeFeedWithArticle("lazy");
    await prisma.subscription.create({ data: { userId: READER, feedId: fresh.feedId } });

    await applySaved(READER, Number(fresh.articleId), false);

    expect(await rowFor(fresh.articleId)).toBeNull();
  }, 20_000);

  it("refuses an id that is not an id, rather than reaching BigInt()", async () => {
    // These arrive from a client. `BigInt(1.5)` throws a RangeError, which
    // surfaces as a 500 on a button press.
    for (const bad of [0, -1, 1.5]) {
      await expect(applySaved(READER, bad, true)).rejects.toBeInstanceOf(ArticleNotReachable);
    }
  });
});
