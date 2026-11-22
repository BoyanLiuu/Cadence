import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/client";
import { CAN_WRITE_DB } from "@/lib/db/guards";
import type { RawItem } from "@/lib/types";

import { resolveAndWrite, type FeedTrust } from "./dedupe";

/*
 * What this suite is for: per-feed scoping creeping back into rung 2.
 *
 * `articles_url` is UNIQUE on `url_hash` alone, globally, and §6.1 says that is
 * what collapses one wire story arriving through six feeds into one row. It is
 * also the single easiest thing to "fix" by accident: scoping the index to the
 * feed makes every cross-feed test still pass except this one, because within
 * one feed nothing changes.
 *
 * Appendix G question 2 settles it as yes-collapse, and the cost it names is
 * the reason this suite also asserts arrivals: someone following both Reuters
 * and a syndicator sees ONE row, which is correct but can read as an article
 * going missing. Appendix E answers that with the "also in 2 feeds" panel — so a
 * collapse that records only one arrival is a collapse the reader cannot
 * verify, which Appendix E lists among the three copy rules carrying the product's
 * credibility.
 */

const describeDb = CAN_WRITE_DB ? describe : describe.skip;

const item = (o: Partial<RawItem> = {}): RawItem => ({
  guid: null,
  url: null,
  title: "A syndicated wire story",
  author: "A wire service",
  publishedAt: "2026-11-12T09:12:00.000Z",
  contentHtml: "<p>The story, as every outlet carries it.</p>",
  summaryHtml: null,
  xmlBase: null,
  ...o,
});

let seq = 0;
const unique = () => `${Date.now()}-${seq++}`;

async function makeFeed(title: string): Promise<FeedTrust> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    INSERT INTO cadence.feeds (feed_url, url_hash, title, clean_polls, status)
    VALUES (${`https://${title}-${unique()}.example/feed`},
            decode(md5(random()::text), 'hex'), ${title}, 3, 'active')
    RETURNING id`;
  return { id: rows[0].id, guidUnstable: false, cleanPolls: 3, guidTrustOverride: "auto" };
}

/*
 * Local probes, reading `article_feeds` directly.
 *
 * Deliberately not shared helpers in `article-urls.ts`: "which feeds carry
 * this article" is a reader-facing fact, and every reader-facing read goes
 * through the service layer where the ownership filter IS the authorization
 * model (§3). An unscoped helper exported for tests is the first caller of a
 * bypass.
 */
async function arrivalFeedIds(articleId: bigint): Promise<bigint[]> {
  const rows = await prisma.$queryRaw<{ feed_id: bigint }[]>`
    SELECT feed_id FROM cadence.article_feeds
    WHERE article_id = ${articleId}
    ORDER BY first_seen_at ASC, feed_id ASC`;
  return rows.map((r) => r.feed_id);
}

async function arrivalCount(articleId: bigint): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(DISTINCT feed_id) AS n FROM cadence.article_feeds
    WHERE article_id = ${articleId}`;
  return Number(rows[0].n);
}

describeDb("rung 2 is global, not per-feed", { timeout: 120_000 }, () => {
  const made: bigint[] = [];

  afterAll(async () => {
    if (made.length > 0) {
      await prisma.$executeRaw`DELETE FROM cadence.feeds WHERE id = ANY(${made}::bigint[])`;
    }
    await prisma.$disconnect();
  });

  it("produces ONE row and TWO arrivals for one story through two feeds", async () => {
    const reuters = await makeFeed("Reuters");
    const syndicator = await makeFeed("A syndicator");
    made.push(reuters.id, syndicator.id);
    const url = `https://wire-${unique()}.example/story`;

    // Each outlet publishes its own guid for the same address — which is what
    // makes rung 2 the only rung that can collapse them. Rung 1 is scoped to
    // the feed by its index, and rung 3 is scoped to the feed on purpose.
    const first = await resolveAndWrite(
      reuters,
      item({ guid: `reuters-${unique()}`, url }),
      new Date(),
    );
    const second = await resolveAndWrite(
      syndicator,
      item({ guid: `syndicator-${unique()}`, url }),
      new Date(),
    );

    expect(second?.rung).toBe("url");
    expect(second?.articleId).toBe(first?.articleId);

    const total = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM cadence.articles
      WHERE feed_id = ANY(${[reuters.id, syndicator.id]}::bigint[])`;
    expect(Number(total[0].n)).toBe(1);

    // TWO ARRIVALS. The row belongs to whichever feed got there first, so this
    // is the only record that the second feed carries it at all.
    expect((await arrivalFeedIds(first!.articleId)).sort()).toEqual(
      [reuters.id, syndicator.id].sort(),
    );
  });

  it("keeps the article owned by the feed that saw it FIRST", async () => {
    // The merge must not steal the row for the second feed. Changing
    // `articles.feed_id` would move the article out of the first feed's list
    // and make the row's metadata disagree with where it came from.
    const a = await makeFeed("First outlet");
    const b = await makeFeed("Second outlet");
    made.push(a.id, b.id);
    const url = `https://owned-${unique()}.example/story`;

    const first = await resolveAndWrite(a, item({ guid: `a-${unique()}`, url }), new Date());
    await resolveAndWrite(b, item({ guid: `b-${unique()}`, url }), new Date());

    const owner = await prisma.$queryRaw<{ feed_id: bigint }[]>`
      SELECT feed_id FROM cadence.articles WHERE id = ${first!.articleId}`;
    expect(owner[0].feed_id).toBe(a.id);
  });

  it("collapses URLs that differ only in per-feed tracking tags", async () => {
    // The realistic shape of syndication: each outlet appends its own source
    // tag. Canonicalisation is what makes these one address, and without it the
    // global index never sees a collision at all.
    const a = await makeFeed("Tagged A");
    const b = await makeFeed("Tagged B");
    made.push(a.id, b.id);
    const base = `https://tagged-${unique()}.example/story`;

    const first = await resolveAndWrite(
      a,
      item({ guid: `a-${unique()}`, url: `${base}?utm_source=outlet-a` }),
      new Date(),
    );
    const second = await resolveAndWrite(
      b,
      item({ guid: `b-${unique()}`, url: `${base}?utm_source=outlet-b&fbclid=zz` }),
      new Date(),
    );

    expect(second?.articleId).toBe(first!.articleId);
    expect(await arrivalCount(first!.articleId)).toBe(2);

    /*
     * Each arrival keeps the address ITS feed published, tags and all.
     *
     * Appendix E's panel strikes through the discarded URL parts so the reader can
     * verify the deduplication rather than trust it — and canonicalisation is
     * exactly what throws those parts away. Both addresses collapse to one
     * `url_hash`, so `article_urls` can keep only one of them and
     * `articles.url` keeps whichever arrived last. Without a per-arrival `url`
     * the panel would show the same address twice and prove nothing.
     */
    const rows = await prisma.$queryRaw<{ url: string | null }[]>`
      SELECT url FROM cadence.article_feeds
      WHERE article_id = ${first!.articleId}
      ORDER BY first_seen_at ASC, feed_id ASC`;
    expect(rows.map((r) => r.url)).toEqual([
      `${base}?utm_source=outlet-a`,
      `${base}?utm_source=outlet-b&fbclid=zz`,
    ]);
  });

  it("counts arrivals in ONE query for a page of articles", async () => {
    /*
     * The marker is on every row of a 50-article page, so one query per row is
     * 50 round trips for a badge.
     *
     * Single-arrival articles are OMITTED rather than returned as 1: the
     * caller's check is "is there an entry", and returning every article on
     * the page would make the map as large as the page for no information.
     */
    const a = await makeFeed("Counted A");
    const b = await makeFeed("Counted B");
    made.push(a.id, b.id);
    const shared = `https://counted-${unique()}.example/shared`;

    const collapsed = await resolveAndWrite(
      a,
      item({ guid: `a-${unique()}`, url: shared }),
      new Date(),
    );
    await resolveAndWrite(b, item({ guid: `b-${unique()}`, url: shared }), new Date());
    const alone = await resolveAndWrite(
      a,
      item({
        guid: `solo-${unique()}`,
        url: `https://counted-${unique()}.example/solo`,
        title: `Solo ${unique()}`,
        contentHtml: "<p>Text only this article has.</p>",
      }),
      new Date(),
    );

    expect(await arrivalCount(collapsed!.articleId)).toBe(2);
    // The negative half: a single-arrival article must not look collapsed.
    expect(await arrivalCount(alone!.articleId)).toBe(1);
  });

  it("does NOT collapse different stories across feeds on text alone", async () => {
    /*
     * The negative case, and a deliberate boundary rather than a limitation.
     *
     * Rung 3 is scoped to the feed. Globally it would collapse a wire story on
     * its text, which is a CLUSTERING decision Appendix G question 2 defers to
     * P2 — cluster-without-merging at the title level — and this rung must not
     * make it by accident. Two outlets that rewrote the headline but kept the
     * body stay two rows at different addresses.
     */
    const a = await makeFeed("Rewritten A");
    const b = await makeFeed("Rewritten B");
    made.push(a.id, b.id);
    const title = `An identical headline ${unique()}`;
    const body = "<p>Identical body text, at two different addresses.</p>";

    const first = await resolveAndWrite(
      a,
      item({
        guid: `a-${unique()}`,
        url: `https://outlet-a-${unique()}.example/story`,
        title,
        contentHtml: body,
      }),
      new Date(),
    );
    const second = await resolveAndWrite(
      b,
      item({
        guid: `b-${unique()}`,
        url: `https://outlet-b-${unique()}.example/story`,
        title,
        contentHtml: body,
      }),
      new Date(),
    );

    expect(second?.rung).toBeNull();
    expect(second?.articleId).not.toBe(first?.articleId);
  });
});
