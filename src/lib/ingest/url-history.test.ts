import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/client";
import { CAN_WRITE_DB } from "@/lib/db/guards";
import type { RawItem } from "@/lib/types";

import { recordUrl, urlsFor } from "./article-urls";
import { resolveAndWrite, type FeedTrust } from "./dedupe";

/*
 * What this suite is for: the duplicate a MOVED article creates.
 *
 * A publisher fixes a slug, moves a post between sections, switches to https.
 * The new address is what rung 2 resolves on from then on — but a feed, an
 * aggregator, or a second feed in the reader's own list is still publishing the
 * OLD one. If the old hash stopped resolving, the next poll would look it up,
 * miss, and insert a second row for an article the reader has already read.
 *
 * That is why `article_urls` ACCUMULATES rather than being updated (§6.1), and
 * it is the one property no other suite covers: `parse-twice` re-ingests the
 * SAME addresses, so an `article_urls` that overwrote instead of appending
 * would pass it.
 */

const describeDb = CAN_WRITE_DB ? describe : describe.skip;

const item = (o: Partial<RawItem> = {}): RawItem => ({
  guid: null,
  url: null,
  title: "A moved article",
  author: null,
  publishedAt: "2026-11-12T09:12:00.000Z",
  contentHtml: "<p>The opening text, unchanged by the move.</p>",
  summaryHtml: null,
  xmlBase: null,
  ...o,
});

let seq = 0;
const unique = () => `${Date.now()}-${seq++}`;

async function makeFeed(cleanPolls = 3): Promise<FeedTrust> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    INSERT INTO cadence.feeds (feed_url, url_hash, title, clean_polls, status)
    VALUES (${`https://history-${unique()}.example/feed`},
            decode(md5(random()::text), 'hex'), 'URL history probe', ${cleanPolls}, 'active')
    RETURNING id`;
  return { id: rows[0].id, guidUnstable: false, cleanPolls, guidTrustOverride: "auto" };
}

async function countArticles(feedId: bigint): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM cadence.articles WHERE feed_id = ${feedId}`;
  return Number(rows[0].n);
}

describeDb("an article that moves keeps answering to its old address", { timeout: 120_000 }, () => {
  const made: bigint[] = [];

  afterAll(async () => {
    if (made.length > 0) {
      await prisma.$executeRaw`DELETE FROM cadence.feeds WHERE id = ANY(${made}::bigint[])`;
    }
    await prisma.$disconnect();
  });

  it("APPENDS to article_urls and inserts nothing when the URL changes", async () => {
    const feed = await makeFeed(3);
    made.push(feed.id);
    const guid = `moving-${unique()}`;
    const host = `https://moving-${unique()}.example`;

    const first = await resolveAndWrite(feed, item({ guid, url: `${host}/old-slug` }), new Date());
    expect(first?.rung).toBeNull();
    const articleId = first!.articleId;

    const second = await resolveAndWrite(feed, item({ guid, url: `${host}/new-slug` }), new Date());
    // Rung 1 resolved it — the guid did not change, only the address.
    expect(second?.rung).toBe("guid");
    expect(second?.articleId).toBe(articleId);
    expect(await countArticles(feed.id)).toBe(1);

    // THE ASSERTION: both addresses, not just the current one.
    const urls = (await urlsFor(articleId)).map((u) => u.url);
    expect(urls).toContain(`${host}/old-slug`);
    expect(urls).toContain(`${host}/new-slug`);
  });

  it("resolves a feed still carrying the OLD url to the existing article", async () => {
    /*
     * The failure this suite exists for.
     *
     * After the move, `articles.url_hash` is the NEW address. A poll carrying
     * the old one has a guid the feed has since changed too — so rung 1 cannot
     * help and rung 2 is the only thing left. It has to find the old address in
     * `article_urls`, because it is no longer any row's `articles.url_hash`.
     */
    const feed = await makeFeed(3);
    made.push(feed.id);
    const host = `https://stale-${unique()}.example`;

    const first = await resolveAndWrite(
      feed,
      item({ guid: `v1-${unique()}`, url: `${host}/old-slug` }),
      new Date(),
    );
    await resolveAndWrite(
      feed,
      item({ guid: `v1-${unique()}`, url: `${host}/old-slug` }),
      new Date(),
    );
    // The move.
    const moved = await resolveAndWrite(
      feed,
      item({ guid: `v1-${unique()}`, url: `${host}/new-slug` }),
      new Date(),
    );
    expect(moved?.articleId).toBe(first?.articleId);

    // A stale copy arrives, with a guid that is new as well.
    const stale = await resolveAndWrite(
      feed,
      item({ guid: `rebuilt-${unique()}`, url: `${host}/old-slug` }),
      new Date(),
    );
    expect(stale?.rung).toBe("url");
    expect(stale?.articleId).toBe(first?.articleId);
    expect(await countArticles(feed.id)).toBe(1);
  });

  it("keeps the ORIGINAL first_seen_at for an address polled again", async () => {
    // Every poll re-delivers the same address. Moving `first_seen_at` forward
    // would make an article the reader has had for a week look like it arrived
    // a minute ago, which is what the "also in N feeds" panel dates arrivals
    // from.
    const feed = await makeFeed(3);
    made.push(feed.id);
    const url = `https://repolled-${unique()}.example/post`;
    const guid = `repolled-${unique()}`;

    const first = await resolveAndWrite(feed, item({ guid, url }), new Date());
    const before = (await urlsFor(first!.articleId))[0].firstSeenAt;

    await resolveAndWrite(feed, item({ guid, url }), new Date());
    const after = (await urlsFor(first!.articleId))[0].firstSeenAt;

    expect(after.getTime()).toBe(before.getTime());
  });

  it("REPORTS an address already held by a different article, rather than stealing it", async () => {
    /*
     * `DO NOTHING` used to make this invisible: the caller could not tell "this
     * address is already mine" from "this address belongs to someone else".
     *
     * Repointing would be worse than either — it MOVES an address between
     * articles, silently changing which row a reader's history refers to. Two
     * articles claiming one address is a real conflict, and M12's manual merge
     * is the escape hatch for it, so it has to be reportable.
     */
    const feed = await makeFeed(3);
    made.push(feed.id);

    const a = await resolveAndWrite(
      feed,
      item({
        guid: `held-a-${unique()}`,
        url: `https://conflict-${unique()}.example/a`,
        title: `A ${unique()}`,
      }),
      new Date(),
    );
    const b = await resolveAndWrite(
      feed,
      item({
        guid: `held-b-${unique()}`,
        url: `https://conflict-${unique()}.example/b`,
        title: `B ${unique()}`,
        contentHtml: "<p>Different opening text entirely.</p>",
      }),
      new Date(),
    );
    expect(b?.articleId).not.toBe(a?.articleId);

    const aUrlHash = await prisma.$queryRaw<{ url_hash: Uint8Array }[]>`
      SELECT url_hash FROM cadence.articles WHERE id = ${a!.articleId}`;

    // B tries to claim A's address.
    const result = await recordUrl(b!.articleId, aUrlHash[0].url_hash, "irrelevant");
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") expect(result.heldBy).toBe(a!.articleId);

    // And it did NOT move: A still answers to it.
    const stillA = await prisma.$queryRaw<{ article_id: bigint }[]>`
      SELECT article_id FROM cadence.article_urls WHERE url_hash = ${aUrlHash[0].url_hash}`;
    expect(stillA[0].article_id).toBe(a!.articleId);
  });

  it("distinguishes a re-record of the SAME article from a conflict", async () => {
    // The common case, and the one that must not look like a conflict: every
    // poll re-records every address it carries.
    const feed = await makeFeed(3);
    made.push(feed.id);

    const a = await resolveAndWrite(
      feed,
      item({ guid: `same-${unique()}`, url: `https://same-${unique()}.example/post` }),
      new Date(),
    );
    const hash = await prisma.$queryRaw<{ url_hash: Uint8Array }[]>`
      SELECT url_hash FROM cadence.articles WHERE id = ${a!.articleId}`;

    expect((await recordUrl(a!.articleId, hash[0].url_hash, "x")).kind).toBe("known");
  });
});
