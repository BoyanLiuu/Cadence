import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/client";
import { CAN_WRITE_DB } from "@/lib/db/guards";

import { applyReadState } from "./read-state.db";

/*
 * What this suite is for: the two ways durable read state goes wrong silently.
 *
 *   THE ACCIDENTAL UN-READ. A flush retried after a dropped connection must not
 *   move `read_at`. Assigning `now()` on conflict looks correct, passes any test
 *   that only checks "is it read", and quietly makes "when did I read this"
 *   meaningless — which matters because §6.2 derives the unread count from this
 *   column rather than caching it.
 *
 *   SOMEONE ELSE'S ARTICLES. The articles table is GLOBAL (Appendix B), so an id
 *   is just a number and the only thing between two readers is the subscription
 *   filter. RLS is bypassed by the owning role, so if that filter is wrong,
 *   posting a guessed id marks a stranger's article.
 *
 * IT TOUCHES NOTHING SEEDED, and that is a correction rather than caution. The
 * first version marked a corpus article as the FIXTURE reader — which made
 * `service-parity.test.ts`'s exact unread and saved comparisons race it across
 * four workers on a shared database, and whose cleanup would have deleted a
 * seeded mark outright if the article it picked ever carried one. So this builds
 * its own reader, its own feeds and its own articles, and removes them.
 *
 * WRITES, so `CADENCE_DB_WRITE_TESTS=1`.
 */

const describeDb = CAN_WRITE_DB ? describe : describe.skip;

/** The hash columns are `Bytes`, not text — same helper `constraints.test.ts` uses. */
const sha = (v: string) => new Uint8Array(createHash("sha256").update(v).digest());

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const READER = `user_test_readstate_${RUN}`;

describeDb("durable read state", () => {
  /** An article arriving through a feed READER follows. */
  let mine: bigint;
  /** An article arriving through a feed nobody follows. */
  let theirs: bigint;
  const feeds: bigint[] = [];

  async function makeFeedWithArticle(
    label: string,
  ): Promise<{ feedId: bigint; articleId: bigint }> {
    const feed = await prisma.feed.create({
      data: {
        feedUrl: `https://${label}-${RUN}.example/feed`,
        urlHash: sha(`feed-${label}-${RUN}`),
        title: label,
        format: "rss2",
      },
    });
    feeds.push(feed.id);
    const article = await prisma.article.create({
      data: {
        feedId: feed.id,
        url: `https://${label}-${RUN}.example/article`,
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

  /** The row under test, or `null`. Read back rather than assumed. */
  const rowFor = (articleId: bigint) =>
    prisma.userArticle.findUnique({
      where: { userId_articleId: { userId: READER, articleId } },
    });

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: READER, email: `${READER}@example.invalid`, name: "Read-state reader" },
    });

    const followed = await makeFeedWithArticle("followed");
    mine = followed.articleId;
    await prisma.subscription.create({ data: { userId: READER, feedId: followed.feedId } });

    const unfollowed = await makeFeedWithArticle("unfollowed");
    theirs = unfollowed.articleId;
  });

  afterAll(async () => {
    await prisma.userArticle.deleteMany({ where: { userId: READER } });
    await prisma.subscription.deleteMany({ where: { userId: READER } });
    // Articles and arrivals cascade from the feed.
    for (const id of feeds) await prisma.feed.delete({ where: { id } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: READER } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("REFUSES an article the reader cannot reach, and says how many", async () => {
    const result = await applyReadState(READER, [Number(theirs)], true);

    expect(result).toEqual({ applied: 0, ignored: 1 });

    // The security property, asserted on the TABLE rather than the return
    // value: a report of "ignored" means nothing if a row was written anyway.
    expect(await rowFor(theirs)).toBeNull();
  });

  it("applies the reachable ids and ignores the rest in one batch", async () => {
    // The realistic shape: a flush carrying a mix, which must not be refused
    // wholesale because one id went stale mid-scroll.
    const result = await applyReadState(READER, [Number(mine), Number(theirs)], true);

    expect(result).toEqual({ applied: 1, ignored: 1 });
    expect(await rowFor(mine)).not.toBeNull();
  });

  it("KEEPS THE ORIGINAL read_at when the same batch is replayed", async () => {
    /*
     * The accidental un-read, stated exactly. `ON CONFLICT DO UPDATE SET
     * read_at = now()` passes every other assertion in this file and fails this
     * one.
     */
    await applyReadState(READER, [Number(mine)], true);
    const first = await rowFor(mine);

    // Asserted before comparing, because `expect(undefined).not.toBeNull()`
    // passes and `undefined === undefined` then compares nothing.
    expect(first, "no row was written, so there is no timestamp to preserve").not.toBeNull();
    expect(first!.readAt).not.toBeNull();

    await applyReadState(READER, [Number(mine)], true);
    const second = await rowFor(mine);

    expect(second!.readAt!.getTime()).toBe(first!.readAt!.getTime());
  });

  it("marking unread CLEARS read_at without deleting the row", async () => {
    /*
     * Deleting the row is the obvious way to express "unread" and it unsaves
     * the article, because `saved_at` lives on the same row. The saved shelf is
     * its own screen (§2), so the loss would be invisible until someone went
     * looking for something they had kept.
     */
    await applyReadState(READER, [Number(mine)], true);
    await prisma.userArticle.update({
      where: { userId_articleId: { userId: READER, articleId: mine } },
      data: { savedAt: new Date() },
    });

    await applyReadState(READER, [Number(mine)], false);

    const row = await rowFor(mine);
    expect(row).not.toBeNull();
    expect(row!.readAt).toBeNull();
    expect(row!.savedAt).not.toBeNull();
  });

  it("writes NO row for a reachable article that was never read", async () => {
    /*
     * Laziness, on an article this reader CAN reach — which is the only way to
     * test it. The first version used an article the reader could NOT reach, so
     * the call returned at the reachability check and never entered the branch
     * the test is named after: green, and proving nothing.
     *
     * Unread is the absence of a row (§6.2), so marking unread must not insert
     * one to record it. A row per article per reader is both pointless and the
     * growth curve that design avoids.
     */
    const fresh = await makeFeedWithArticle("lazy");
    await prisma.subscription.create({ data: { userId: READER, feedId: fresh.feedId } });

    const result = await applyReadState(READER, [Number(fresh.articleId)], false);

    expect(result).toEqual({ applied: 1, ignored: 0 });
    expect(await rowFor(fresh.articleId)).toBeNull();
  });

  it("deduplicates a batch rather than counting an id twice", async () => {
    const result = await applyReadState(READER, [Number(mine), Number(mine)], true);
    expect(result).toEqual({ applied: 1, ignored: 0 });
  });

  it("counts ids it cannot even parse as ignored, rather than losing them", async () => {
    /*
     * `ignored` is documented as "reported rather than silent", and ids rejected
     * by the integer filter were counted in neither bucket — so a client sending
     * junk got `{ applied: 0, ignored: 0 }`, which reads as "nothing to do"
     * rather than "none of that was usable".
     */
    const result = await applyReadState(READER, [-1, 0, 1.5], true);
    expect(result).toEqual({ applied: 0, ignored: 3 });
  });
});
