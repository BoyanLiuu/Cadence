import { createHash } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "./client";
import { CAN_READ_DB, CAN_WRITE_DB } from "./guards";

/*
 * What this suite is for: the index mistake that only shows up at runtime.
 *
 * M6's whole claim is that IDENTITY IS ENFORCED BY THE DATABASE rather than by
 * application code — because check-then-insert is a race and two overlapping
 * ticks are normal (§6.1). That claim is only true if the indexes are shaped
 * exactly right, and the two shapes that matter both fail silently:
 *
 *  - A plain unique index on `(feed_id, guid_hash)` permits UNLIMITED
 *    duplicates for every feed that publishes no guid, because SQL treats all
 *    those NULLs as distinct. Hacker News publishes none.
 *  - `articles_url` being per-feed instead of GLOBAL loses the entire benefit
 *    of rung 2: one wire story through six feeds becomes six rows.
 *
 * Neither is visible in the schema file, neither breaks a type, and neither
 * can be tested without a database. So these tests attempt the forbidden
 * inserts and require the database to refuse them.
 *
 * SKIPPED, not failed, with no database configured: M0–M5 predate the schema
 * and a clone with no Supabase project must still be able to run `pnpm check`.
 *
 * The insert probes also need `CADENCE_DB_WRITE_TESTS=1` (`pnpm test:db`),
 * because they CREATE rows in a project shared with the workspace's other apps
 * and `pnpm check` must not mutate it. The index-definition assertions below
 * are reads and run whenever a database is configured.
 */

const describeWrites = CAN_WRITE_DB ? describe : describe.skip;
const describeReads = CAN_READ_DB ? describe : describe.skip;

const sha = (v: string) => new Uint8Array(createHash("sha256").update(v).digest());

/** A feed to hang test articles off, removed afterwards. */
async function makeFeed(label: string) {
  return prisma.feed.create({
    data: {
      feedUrl: `https://constraints-${label}.example/feed`,
      urlHash: sha(`constraints-${label}`),
      title: `Constraint probe ${label}`,
    },
  });
}

function article(feedId: bigint, o: Partial<Record<string, unknown>> = {}) {
  const unique = Math.random().toString(36).slice(2);
  return {
    feedId,
    guidHash: sha(`guid-${unique}`),
    url: `https://constraints.example/${unique}`,
    urlHash: sha(`url-${unique}`),
    contentHash: sha(`content-${unique}`),
    title: `Probe ${unique}`,
    publishedAt: new Date(),
    ...o,
  };
}

describeWrites("the constraints that enforce identity", () => {
  const madeFeeds: bigint[] = [];

  afterAll(async () => {
    // Articles cascade from the feed, so removing the feeds is enough.
    if (madeFeeds.length > 0) {
      await prisma.feed.deleteMany({ where: { id: { in: madeFeeds } } });
    }
    await prisma.$disconnect();
  });

  it("permits two articles with a NULL guid in the same feed", async () => {
    // THE CASE A PLAIN UNIQUE INDEX GETS WRONG. Several of the most-subscribed
    // feeds on the web publish no <guid>; if the index were not partial, the
    // second of these would be rejected and the feed would appear to stop
    // publishing after its first item.
    const feed = await makeFeed(`null-guid-${Date.now()}`);
    madeFeeds.push(feed.id);

    await prisma.article.create({ data: article(feed.id, { guidHash: null }) });
    await expect(
      prisma.article.create({ data: article(feed.id, { guidHash: null }) }),
    ).resolves.toBeTruthy();

    expect(await prisma.article.count({ where: { feedId: feed.id } })).toBe(2);
  });

  it("refuses two articles with the SAME non-null guid in one feed", async () => {
    // Rung 1, enforced. Without this the ladder's first rung is advisory.
    const feed = await makeFeed(`same-guid-${Date.now()}`);
    madeFeeds.push(feed.id);

    const guidHash = sha(`shared-guid-${Date.now()}`);
    await prisma.article.create({ data: article(feed.id, { guidHash }) });
    await expect(prisma.article.create({ data: article(feed.id, { guidHash }) })).rejects.toThrow();
  });

  it("permits the same guid in DIFFERENT feeds", async () => {
    // Rung 1 is scoped to the FEED, because a guid is only unique within the
    // feed that issued it — two publishers can and do pick the same string.
    //
    // This test asserted `rejects` while its own comment said the opposite,
    // copied from the `articles_url` case below. It would have failed on the
    // first run against a database, which is the only reason it survived
    // review: nothing had run.
    const a = await makeFeed(`guid-scope-a-${Date.now()}`);
    const b = await makeFeed(`guid-scope-b-${Date.now()}`);
    madeFeeds.push(a.id, b.id);

    const guidHash = sha(`cross-feed-guid-${Date.now()}`);
    await prisma.article.create({ data: article(a.id, { guidHash }) });
    await expect(
      prisma.article.create({ data: article(b.id, { guidHash }) }),
    ).resolves.toBeTruthy();
  });

  it("refuses the same url_hash in DIFFERENT feeds, because rung 2 is GLOBAL", async () => {
    // The single most important constraint in the schema. Scoped per feed, one
    // wire story arriving through six feeds would become six rows, and the
    // "also in 2 feeds" marker would have nothing to mark.
    const a = await makeFeed(`url-global-a-${Date.now()}`);
    const b = await makeFeed(`url-global-b-${Date.now()}`);
    madeFeeds.push(a.id, b.id);

    const urlHash = sha(`syndicated-${Date.now()}`);
    await prisma.article.create({ data: article(a.id, { urlHash }) });
    await expect(prisma.article.create({ data: article(b.id, { urlHash }) })).rejects.toThrow();
  });

  it("permits two articles with the same content_hash", async () => {
    // Rung 3 is NOT unique: it is a lookup the ladder resolves, not a
    // rejection. Making it unique would refuse a legitimate insert whenever
    // two articles shared a title and opening text (§6.1).
    const feed = await makeFeed(`content-${Date.now()}`);
    madeFeeds.push(feed.id);

    const contentHash = sha(`shared-content-${Date.now()}`);
    await prisma.article.create({ data: article(feed.id, { contentHash }) });
    await expect(
      prisma.article.create({ data: article(feed.id, { contentHash }) }),
    ).resolves.toBeTruthy();
  });

  it("refuses two article_urls rows for one address", async () => {
    // `article_urls.url_hash` is the primary key, which is what guarantees an
    // address resolves to exactly one article (§6.1).
    const feed = await makeFeed(`article-urls-${Date.now()}`);
    madeFeeds.push(feed.id);

    const first = await prisma.article.create({ data: article(feed.id) });
    const second = await prisma.article.create({ data: article(feed.id) });

    const urlHash = sha(`alias-${Date.now()}`);
    await prisma.articleUrl.create({
      data: { urlHash, articleId: first.id, url: "https://constraints.example/alias" },
    });
    await expect(
      prisma.articleUrl.create({
        data: { urlHash, articleId: second.id, url: "https://constraints.example/alias" },
      }),
    ).rejects.toThrow();
  });

  it("permits many article_urls rows for ONE article", async () => {
    // One-to-many on purpose: when a URL changes, the old hash stays mapped to
    // the same article so a feed still carrying it resolves to the existing
    // row rather than inserting a second one.
    const feed = await makeFeed(`one-to-many-${Date.now()}`);
    madeFeeds.push(feed.id);
    const row = await prisma.article.create({ data: article(feed.id) });

    for (const suffix of ["old", "older", "oldest"]) {
      await prisma.articleUrl.create({
        data: {
          urlHash: sha(`${suffix}-${Date.now()}`),
          articleId: row.id,
          url: `https://constraints.example/${suffix}`,
        },
      });
    }
    expect(await prisma.articleUrl.count({ where: { articleId: row.id } })).toBe(3);
  });

  it("refuses a second user_articles row for one reader and article", async () => {
    const feed = await makeFeed(`user-article-${Date.now()}`);
    madeFeeds.push(feed.id);
    const row = await prisma.article.create({ data: article(feed.id) });

    const userId = `probe-${Date.now()}`;
    await prisma.user.create({
      data: { id: userId, email: `${userId}@example.invalid`, name: "Probe" },
    });
    try {
      await prisma.userArticle.create({ data: { userId, articleId: row.id, readAt: new Date() } });
      await expect(
        prisma.userArticle.create({ data: { userId, articleId: row.id } }),
      ).rejects.toThrow();
    } finally {
      await prisma.user.delete({ where: { id: userId } });
    }
  });
});

describeReads("the indexes exist with the shapes the design needs", () => {
  afterAll(() => prisma.$disconnect());

  it("has every index Appendix D names", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'cadence'
    `;
    const names = new Set(rows.map((r) => r.indexname));
    for (const index of [
      "feeds_due",
      "articles_guid",
      "articles_url",
      "articles_content",
      "ua_unread",
      "articles_feed_time",
      "articles_title_trgm",
    ]) {
      expect(names.has(index), `missing index ${index}`).toBe(true);
    }
  });

  it.each([
    ["feeds_due", "status"],
    ["articles_guid", "guid_hash IS NOT NULL"],
    ["ua_unread", "read_at IS NULL"],
  ])("%s carries its WHERE clause", async (index, fragment) => {
    // The predicate is what makes these partial. A migration that created them
    // without it would pass every query test and be wrong exactly where it
    // matters, so the index DEFINITION is asserted rather than its effect.
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'cadence' AND indexname = ${index}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("WHERE");
    expect(rows[0].indexdef).toContain(fragment);
  });

  it("has articles_url unique and NOT scoped to a feed", async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'cadence' AND indexname = 'articles_url'
    `;
    expect(rows[0].indexdef).toContain("UNIQUE");
    // The whole of rung 2 in one assertion.
    expect(rows[0].indexdef).not.toContain("feed_id");
  });
});
