import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/client";
import { CAN_WRITE_DB } from "@/lib/db/guards";
import type { RawItem } from "@/lib/types";

import { type FeedTrust } from "./dedupe";
import { runPoll } from "./poll";

/*
 * What this suite is for: a stale cache with no TTL to save it.
 *
 * §2 keys the AI summary on `(article_id, content_hash)` rather than on the
 * article alone, and that one decision is the whole invalidation strategy:
 * a revision changes `content_hash`, so the key a lookup computes no longer
 * matches the stored row and the summary is simply not found. No TTL, no
 * invalidation pass, no cache-busting parameter.
 *
 * The failure it prevents is specific and bad: a summary describing text the
 * reader is no longer looking at, on a screen whose purpose is to tell them
 * what an article says before they commit to reading it. A TTL would not fix
 * it — it would make the wrong summary expire *eventually*, which is worse than
 * either answer because it is unpredictable.
 *
 * So what is under test is not code. It is that the SCHEMA still makes this
 * true: the unique key still includes `content_hash`, and ingestion still moves
 * `content_hash` on a revision. Both are easy to "simplify" away later —
 * dropping the column from the key looks like a harmless index change.
 */

const describeDb = CAN_WRITE_DB ? describe : describe.skip;

let seq = 0;
const unique = () => `${Date.now()}-${seq++}`;

const TRANSPORT = { statusCode: 200, bytes: 2048 };

const item = (o: Partial<RawItem> = {}): RawItem => ({
  guid: null,
  url: null,
  title: "A summarised article",
  author: null,
  publishedAt: "2026-11-12T09:12:00.000Z",
  contentHtml: "<p>The body as first published, long enough to summarise.</p>",
  summaryHtml: null,
  xmlBase: null,
  ...o,
});

const made: bigint[] = [];

async function makeFeed(): Promise<FeedTrust> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    INSERT INTO cadence.feeds (feed_url, url_hash, title, clean_polls, status)
    VALUES (${`https://summary-${unique()}.example/feed`},
            decode(md5(random()::text), 'hex'), 'Summary probe', 3, 'active')
    RETURNING id`;
  made.push(rows[0].id);
  return { id: rows[0].id, guidUnstable: false, cleanPolls: 3, guidTrustOverride: "auto" };
}

async function contentHashOf(articleId: bigint): Promise<Uint8Array> {
  const rows = await prisma.$queryRaw<{ content_hash: Uint8Array }[]>`
    SELECT content_hash FROM cadence.articles WHERE id = ${articleId}`;
  return rows[0].content_hash;
}

/** The cache lookup, exactly as M13's summary route will do it. */
async function cachedSummary(articleId: bigint, hash: Uint8Array): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ bullets: unknown }[]>`
    SELECT bullets FROM cadence.summaries
    WHERE article_id = ${articleId} AND content_hash = ${hash}`;
  return rows.length === 0 ? null : JSON.stringify(rows[0].bullets);
}

async function storeSummary(articleId: bigint, hash: Uint8Array, text: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO cadence.summaries (article_id, content_hash, model, bullets, input_tokens)
    VALUES (${articleId}, ${hash}, 'probe-model', ${JSON.stringify([text])}::jsonb, 100)`;
}

async function onlyArticle(feedId: bigint): Promise<bigint> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT id FROM cadence.articles WHERE feed_id = ${feedId} ORDER BY id LIMIT 1`;
  return rows[0].id;
}

describeDb("a revision invalidates its summary for free", { timeout: 180_000 }, () => {
  afterAll(async () => {
    if (made.length > 0) {
      await prisma.$executeRaw`DELETE FROM cadence.feeds WHERE id = ANY(${made}::bigint[])`;
    }
    await prisma.$disconnect();
  });

  it("stops matching the cached summary once the body changes", async () => {
    const feed = await makeFeed();
    const guid = `summarised-${unique()}`;
    const url = `https://summary-${unique()}.example/post`;

    await runPoll(feed, [item({ guid, url })], TRANSPORT);
    const articleId = await onlyArticle(feed.id);

    // A summary of the ORIGINAL text, keyed on the hash of that text.
    const before = await contentHashOf(articleId);
    await storeSummary(articleId, before, "A summary of the original body.");
    expect(await cachedSummary(articleId, before)).toContain("original body");

    // The publisher edits it.
    const edited = await runPoll(
      feed,
      [item({ guid, url, contentHtml: "<p>Rewritten body, saying something else entirely.</p>" })],
      TRANSPORT,
    );
    expect(edited.counters.revised).toBe(1);

    const after = await contentHashOf(articleId);
    expect(Buffer.from(after).toString("hex")).not.toBe(Buffer.from(before).toString("hex"));

    // THE ASSERTION: the lookup for the CURRENT text finds nothing, so M13
    // generates a fresh summary rather than showing one of text nobody can see.
    expect(await cachedSummary(articleId, after)).toBeNull();

    // And the old row is still there, keyed to the old text. Not deleted: it is
    // a correct summary of a revision that existed, and the article's history
    // is what `revision_count` counts.
    expect(await cachedSummary(articleId, before)).toContain("original body");
  });

  it("KEEPS matching across an unchanged re-poll", async () => {
    // The negative case, and the one that pays for the cache. If an unchanged
    // poll moved `content_hash`, every tick would invalidate every summary and
    // the cache would never be hit — an expensive mistake that nothing else
    // would report, because regenerating always produces a plausible answer.
    const feed = await makeFeed();
    const guid = `stable-${unique()}`;
    const url = `https://summary-${unique()}.example/stable`;

    await runPoll(feed, [item({ guid, url })], TRANSPORT);
    const articleId = await onlyArticle(feed.id);
    const hash = await contentHashOf(articleId);
    await storeSummary(articleId, hash, "A summary that should survive.");

    await runPoll(feed, [item({ guid, url })], TRANSPORT);

    expect(Buffer.from(await contentHashOf(articleId)).toString("hex")).toBe(
      Buffer.from(hash).toString("hex"),
    );
    expect(await cachedSummary(articleId, hash)).toContain("should survive");
  });

  it("still enforces (article_id, content_hash) as UNIQUE", async () => {
    // The schema half of the strategy. Dropping `content_hash` from the key
    // looks like a harmless index simplification and silently turns the cache
    // into one-summary-per-article — which is exactly the stale cache this
    // design avoids.
    const feed = await makeFeed();
    const url = `https://summary-${unique()}.example/unique`;
    await runPoll(feed, [item({ guid: `u-${unique()}`, url })], TRANSPORT);
    const articleId = await onlyArticle(feed.id);
    const hash = await contentHashOf(articleId);

    await storeSummary(articleId, hash, "First.");
    await expect(storeSummary(articleId, hash, "Second.")).rejects.toThrow();
  });

  it("allows TWO summaries for one article at different content hashes", async () => {
    // The other half: the key must permit a row per revision, or a revised
    // article could never be summarised again.
    const feed = await makeFeed();
    const guid = `two-${unique()}`;
    const url = `https://summary-${unique()}.example/two`;

    await runPoll(feed, [item({ guid, url })], TRANSPORT);
    const articleId = await onlyArticle(feed.id);
    const first = await contentHashOf(articleId);
    await storeSummary(articleId, first, "Summary of revision one.");

    await runPoll(feed, [item({ guid, url, contentHtml: "<p>Revision two.</p>" })], TRANSPORT);
    const second = await contentHashOf(articleId);
    await storeSummary(articleId, second, "Summary of revision two.");

    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM cadence.summaries WHERE article_id = ${articleId}`;
    expect(Number(rows[0].n)).toBe(2);
    expect(await cachedSummary(articleId, second)).toContain("revision two");
  });
});
