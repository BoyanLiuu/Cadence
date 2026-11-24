import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/client";
import { CAN_WRITE_DB } from "@/lib/db/guards";
import {
  NoSuchFolder,
  NotSubscribed,
  addSubscription,
  editSubscription,
  removeSubscription,
} from "./subscriptions.db";

/*
 * What this suite is for: the two properties Appendix D says cannot be fixed
 * later, plus the ownership checks that have no backstop.
 *
 *   A FEED IS SHARED. Ten readers of one feed are ten `subscriptions` rows over
 *   ONE `feeds` row — that is what makes a single fetch and a single dedup run
 *   serve all of them. Appendix D: per-reader feed rows are "not migratable
 *   after M6". The obvious implementation (`create` the feed, then subscribe)
 *   produces exactly that and looks correct for one reader.
 *
 *   A FOLLOWING IS LAZY. Subscribing writes no `user_articles` rows, because
 *   unread is the absence of one (§6.2). The eager version — a row per article
 *   per subscriber at subscribe time — is also the obvious implementation, is
 *   invisible with twelve fixture articles, and grows as readers × articles.
 *
 * It builds its own readers and feeds and removes them: the seeded corpus is
 * `service-parity`'s fixture, not scratch space.
 */

const describeDb = CAN_WRITE_DB ? describe : describe.skip;

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ONE = `user_test_subs_a_${RUN}`;
const TWO = `user_test_subs_b_${RUN}`;

describeDb("following a feed", () => {
  const madeFeedUrls: string[] = [];

  /** A fresh address nobody follows yet. */
  const address = (label: string) => {
    const url = `https://subs-${label}-${RUN}.example/feed`;
    madeFeedUrls.push(url);
    return url;
  };

  beforeAll(async () => {
    for (const id of [ONE, TWO]) {
      await prisma.user.create({ data: { id, email: `${id}@example.invalid`, name: "Subs" } });
    }
  });

  afterAll(async () => {
    await prisma.subscription.deleteMany({ where: { userId: { in: [ONE, TWO] } } });
    await prisma.userArticle.deleteMany({ where: { userId: { in: [ONE, TWO] } } });
    await prisma.folder.deleteMany({ where: { userId: { in: [ONE, TWO] } } });
    // Articles and arrivals cascade from the feed.
    await prisma.feed.deleteMany({ where: { feedUrl: { in: madeFeedUrls } } });
    await prisma.user.deleteMany({ where: { id: { in: [ONE, TWO] } } });
    await prisma.$disconnect();
  });

  it("TWO READERS, ONE FEED ROW — the property that cannot be fixed later", async () => {
    const url = address("shared");

    const first = await addSubscription(ONE, url);
    const second = await addSubscription(TWO, url);

    expect(first.feedId).toBe(second.feedId);
    expect(await prisma.feed.count({ where: { feedUrl: url } })).toBe(1);
    expect(
      await prisma.subscription.count({ where: { feedId: BigInt(first.feedId) } }),
    ).toBeGreaterThanOrEqual(2);
  });

  it("joins on the KEY, not the address as typed", async () => {
    /*
     * Two readers who type the same feed differently must still share a row.
     * `canonicalUrl` is the same function rung 2 uses for articles, so "the
     * same feed" means the same thing in both places — and a `feeds` table
     * keyed on the raw string would quietly give these two separate rows, two
     * pollers and two dedup runs.
     */
    const url = `https://subs-canon-${RUN}.example/feed`;
    madeFeedUrls.push(url);

    const typedPlainly = await addSubscription(ONE, url);
    const typedWithNoise = await addSubscription(TWO, `http://www.subs-canon-${RUN}.example/feed/`);

    expect(typedWithNoise.feedId).toBe(typedPlainly.feedId);
  });

  // 20s, not the default 5: five article inserts over the session pooler are a
  // round trip each, and this is the only test here that writes articles.
  it("writes NO user_articles rows, however many articles the feed has", async () => {
    // The lazy property, with something to be eager about.
    const url = address("lazy");
    const created = await addSubscription(ONE, url);

    for (let i = 0; i < 5; i += 1) {
      await prisma.article.create({
        data: {
          feedId: BigInt(created.feedId),
          url: `${url}/article-${i}`,
          urlHash: new Uint8Array(
            await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${url}-${i}`)),
          ),
          contentHash: new Uint8Array(
            await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${url}-c-${i}`)),
          ),
          title: `Article ${i}`,
          publishedAt: new Date(),
          normVersion: 1,
          arrivals: { create: [{ feedId: BigInt(created.feedId) }] },
        },
      });
    }

    await addSubscription(TWO, url);

    expect(await prisma.userArticle.count({ where: { userId: TWO } })).toBe(0);
  }, 20_000);

  it("is IDEMPOTENT — a duplicate returns the existing following", async () => {
    /*
     * ARCHITECTURE's Writes table: "a duplicate subscription returns the
     * existing one". An earlier version of this threw instead, which would have
     * made the add screen 500 on its commonest outcome. "Already followed" is
     * DISCOVERY's answer, given before anyone presses the button (§6.3).
     */
    const url = address("twice");
    const first = await addSubscription(ONE, url);
    const again = await addSubscription(ONE, url);

    expect(again).toEqual(first);
    expect(
      await prisma.subscription.count({
        where: { userId: ONE, feedId: BigInt(first.feedId) },
      }),
    ).toBe(1);
  });

  it("does not RE-FILE on a duplicate, which would be a different request", async () => {
    const mine = await prisma.folder.create({
      data: { userId: ONE, name: `Keep ${RUN}`, position: 7 },
    });
    const url = address("no-refile");
    const first = await addSubscription(ONE, url, Number(mine.id));

    const again = await addSubscription(ONE, url, null);

    expect(again.folderId).toBe(first.folderId);
  });

  it("makes a new feed DUE, or it would never be polled", async () => {
    /*
     * The bug that made the whole feature inert. `next_fetch_at` is nullable
     * with no default and `claimDueFeeds` selects `next_fetch_at <= now()`, so
     * NULL matches nothing: subscribing appeared to work and no article would
     * ever arrive.
     */
    const created = await addSubscription(ONE, address("due"));
    const feed = await prisma.feed.findUniqueOrThrow({ where: { id: BigInt(created.feedId) } });

    expect(feed.nextFetchAt).not.toBeNull();
    expect(feed.nextFetchAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("answers an edit that changes nothing WITHOUT claiming it is not yours", async () => {
    /*
     * `guidTrustOverride` is accepted by the input type and dropped by this
     * layer, so a PATCH carrying only that leaves nothing to update — and an
     * empty `updateMany` modifies no rows. Reading ownership off that count
     * would tell a reader they do not follow a feed they do follow.
     */
    const created = await addSubscription(ONE, address("no-op-edit"));

    const unchanged = await editSubscription(ONE, created.feedId, {});

    expect(unchanged.feedId).toBe(created.feedId);
    await expect(editSubscription(TWO, created.feedId, {})).rejects.toBeInstanceOf(NotSubscribed);
  });

  it("refuses ANOTHER READER'S folder, which the foreign key would accept", async () => {
    /*
     * `folder_id` is a foreign key, so the database is happy to file one
     * reader's feed into another's folder: a valid row, and the feed vanishes
     * into a folder its owner cannot see. Appendix D puts `user_id` on
     * `folders` so this question has an answer; nothing else asks it.
     */
    const theirs = await prisma.folder.create({
      data: { userId: TWO, name: `Theirs ${RUN}`, position: 0 },
    });

    await expect(
      addSubscription(ONE, address("foreign-folder"), Number(theirs.id)),
    ).rejects.toBeInstanceOf(NoSuchFolder);
  });

  it("refuses to EDIT a subscription that is not the reader's", async () => {
    const url = address("edit-theirs");
    const theirs = await addSubscription(TWO, url);

    await expect(
      editSubscription(ONE, theirs.feedId, { customTitle: "mine now" }),
    ).rejects.toBeInstanceOf(NotSubscribed);

    // And nothing changed.
    const row = await prisma.subscription.findUniqueOrThrow({
      where: { userId_feedId: { userId: TWO, feedId: BigInt(theirs.feedId) } },
    });
    expect(row.customTitle).toBeNull();
  });

  it("refuses to UNSUBSCRIBE a feed that is not the reader's", async () => {
    const url = address("delete-theirs");
    const theirs = await addSubscription(TWO, url);

    await expect(removeSubscription(ONE, theirs.feedId)).rejects.toBeInstanceOf(NotSubscribed);
    expect(
      await prisma.subscription.count({
        where: { userId: TWO, feedId: BigInt(theirs.feedId) },
      }),
    ).toBe(1);
  });

  it("leaves the FEED and the articles behind when the last reader leaves", async () => {
    /*
     * Articles are global rows owned by the feed (Appendix B), so deleting the
     * feed cascades away history a re-subscribe would re-fetch. The reader's
     * own read marks survive too: re-following should not resurrect everything
     * they had already read.
     */
    const url = address("last-out");
    const created = await addSubscription(ONE, url);

    await removeSubscription(ONE, created.feedId);

    expect(await prisma.feed.count({ where: { id: BigInt(created.feedId) } })).toBe(1);
  });

  it("files into a folder the reader DOES own, and can refile later", async () => {
    const mine = await prisma.folder.create({
      data: { userId: ONE, name: `Mine ${RUN}`, position: 1 },
    });
    const created = await addSubscription(ONE, address("refile"), Number(mine.id));
    expect(created.folderId).toBe(Number(mine.id));

    const moved = await editSubscription(ONE, created.feedId, { folderId: null });
    expect(moved.folderId).toBeNull();
  });

  it("does not let an edit touch the SHARED feed row", async () => {
    /*
     * `customTitle` is what this reader calls the feed, and it lives on the
     * subscription precisely so it cannot rename it for everyone else.
     */
    const url = address("custom-title");
    const created = await addSubscription(ONE, url);
    const before = await prisma.feed.findUniqueOrThrow({
      where: { id: BigInt(created.feedId) },
    });

    await editSubscription(ONE, created.feedId, { customTitle: "My name for it" });

    const after = await prisma.feed.findUniqueOrThrow({ where: { id: BigInt(created.feedId) } });
    expect(after.title).toBe(before.title);
  });
});
