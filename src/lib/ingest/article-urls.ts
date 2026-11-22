import { prisma } from "@/lib/db/client";

/*
 * Every address an article has ever been reachable at, and every feed that has
 * ever delivered it.
 *
 * ARCHITECTURE §6.1 makes `article_urls` ONE-TO-MANY on purpose, and the reason
 * is a duplicate rather than a nicety. When a publisher changes an article's
 * URL — a slug fix, a section move, a TLS migration — the new address is what
 * rung 2 resolves on, but a feed is still publishing the OLD one. If the old
 * hash stopped resolving, the next poll would look it up, find nothing, and
 * insert a second row for an article the reader has already read. The unread
 * count would then lie, which §6.1 calls the failure the whole product rests
 * on.
 *
 * So addresses ACCUMULATE. They are never updated and never deleted, and
 * `articles.url_hash` is only ever "the most recent one", not "the only one".
 *
 * The companion half is arrivals. Rung 2 is global, so one story through six
 * feeds is one row, and `articles.feed_id` can only name the feed that got
 * there first. `article_feeds` records the rest — which is what Appendix E's
 * "also in 2 feeds" panel reads, and what keeps a feed-scoped list from hiding
 * an article that feed carries.
 */

/** Why a recorded address did not become a new row. */
export type RecordUrlResult =
  /** A new address for this article. */
  | { kind: "recorded" }
  /** This article already answered to this address. A re-poll: the common case. */
  | { kind: "known" }
  /**
   * This address already belongs to a DIFFERENT article.
   *
   * Not an error and not silently repointed. Two articles claiming one address
   * is a genuine conflict — usually a publisher reusing a slug, occasionally
   * the canonicaliser being too aggressive — and M12's manual merge is the
   * escape hatch for it. Repointing would MOVE an address between articles and
   * silently change which row a reader's history refers to.
   */
  | { kind: "conflict"; heldBy: bigint };

/**
 * Appends an address to an article's history, idempotently.
 *
 * `ON CONFLICT (url_hash) DO NOTHING` plus a read of what is actually there,
 * in one statement: the insert is the race-safe part, and the `SELECT` in the
 * `WHERE NOT EXISTS` branch is only reached when the insert did nothing, so
 * the common case stays one round trip with no extra lookup.
 */
export async function recordUrl(
  articleId: bigint,
  urlHash: Uint8Array,
  url: string,
): Promise<RecordUrlResult> {
  const rows = await prisma.$queryRaw<{ article_id: bigint; inserted: boolean }[]>`
    WITH attempted AS (
      INSERT INTO cadence.article_urls (url_hash, article_id, url, first_seen_at)
      VALUES (${urlHash}, ${articleId}, ${url}, now())
      ON CONFLICT (url_hash) DO NOTHING
      RETURNING article_id
    )
    SELECT article_id, true AS inserted FROM attempted
    UNION ALL
    -- Only evaluated when the insert above did nothing, so a fresh address
    -- costs no second lookup.
    SELECT article_id, false AS inserted FROM cadence.article_urls
    WHERE url_hash = ${urlHash} AND NOT EXISTS (SELECT 1 FROM attempted)
  `;

  const row = rows[0];
  // No row at all would mean the insert did nothing AND nothing is there,
  // which cannot happen under `ON CONFLICT (url_hash)`. Treated as recorded
  // rather than crashing a poll over an impossible state.
  if (row === undefined) return { kind: "recorded" };
  if (row.inserted) return { kind: "recorded" };
  if (row.article_id === articleId) return { kind: "known" };
  return { kind: "conflict", heldBy: row.article_id };
}

/**
 * Records that a feed delivered an article.
 *
 * `first_seen_at` is NOT touched on conflict, deliberately: it is when this
 * feed first carried the article, and every later poll carries it again. Moving
 * it forward would make a feed that has carried a story for a week look like it
 * picked it up a minute ago.
 */
export async function recordArrival(
  articleId: bigint,
  feedId: bigint,
  /**
   * The RAW address this feed delivered, before canonicalisation.
   *
   * Appendix E's panel strikes through the discarded parts, so it needs what the feed
   * actually sent — which is exactly what canonicalisation throws away. Two
   * outlets' different tracking tags collapse to one `url_hash`, so
   * `article_urls` keeps only one of them.
   *
   * Null for an item the feed published with no link at all (§6.3) — those are
   * identified by rung 3, so there is no address to show.
   */
  url: string | null,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO cadence.article_feeds (article_id, feed_id, url, first_seen_at)
    VALUES (${articleId}, ${feedId}, ${url}, now())
    ON CONFLICT (article_id, feed_id) DO NOTHING
  `;
}

/**
 * Every address an article answers to, oldest first.
 *
 * A probe for the ingest tests, which is why it takes no viewer: addresses
 * have no per-reader dimension at all. Anything a READER sees goes through the
 * service layer (Appendix C), where the ownership filter is the authorization
 * model (§3).
 *
 * `arrivalsFor` and `arrivalCounts` used to live here too, and they are gone.
 * They read a reader-facing fact — which feeds carry an article — with no
 * viewer, and had no production caller: arrivals reach the UI through
 * `listArticles`/`getArticle`, which are scoped. An unscoped read path kept
 * "for later" in a codebase whose authorization IS the query filter is a
 * bypass waiting for its first caller.
 */
export async function urlsFor(articleId: bigint): Promise<{ url: string; firstSeenAt: Date }[]> {
  const rows = await prisma.$queryRaw<{ url: string; first_seen_at: Date }[]>`
    SELECT url, first_seen_at FROM cadence.article_urls
    WHERE article_id = ${articleId}
    ORDER BY first_seen_at ASC, url ASC
  `;
  return rows.map((r) => ({ url: r.url, firstSeenAt: r.first_seen_at }));
}
