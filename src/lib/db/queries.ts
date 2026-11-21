import { prisma } from "./client";

/*
 * The insert-or-merge upsert, and the two rungs a CONSTRAINT can arbitrate.
 *
 * §6.1's rule is that each rung is enforced by a database constraint rather
 * than a prior `SELECT`, because check-then-insert is a race and two
 * overlapping ticks are normal. That shapes this file: nothing here asks "does
 * this article exist?" — it attempts a write and reads the answer out of what
 * the database did with it.
 *
 * `RETURNING id, (xmax <> 0) AS was_merge` is §6.2 verbatim, and it is the only
 * reason `items_new` and `items_merged_by` can be counted without a second
 * query. `xmax` is non-zero exactly when the row was updated rather than
 * inserted. It is Postgres-specific, which is noted in Appendix D's gotchas.
 *
 * `revised` is read from the CONTENT HASH BEFORE THE WRITE, captured in a
 * `before` CTE, and NOT from the timestamp the write left behind. The obvious
 * version — `revised_at IS NOT DISTINCT FROM now()` — looks right and is
 * almost always FALSE:
 *
 *   `revised_at` is `TIMESTAMP(3)`, so the stored value is rounded to the
 *   millisecond, while `now()` carries microseconds. The two are equal only
 *   when `now()` happens to land on an exact millisecond, which is roughly
 *   once in a thousand polls.
 *
 * So `revised` was silently near-always false, and `revision_count` was being
 * incremented by SQL nobody could observe. M8's revised badge reads this.
 *
 * A data-modifying CTE and the statement's other CTEs all see the SAME
 * snapshot, which is what makes `before` the pre-update value rather than a
 * race.
 *
 * Every table is SCHEMA-QUALIFIED: raw SQL is passed through verbatim and the
 * connection's `search_path` does not include `cadence` (M6).
 */

/** What one write did, and which rung decided it. */
export type WriteOutcome = {
  id: bigint;
  /** False when the row already existed. Drives `items_new`. */
  inserted: boolean;
  /** True when a match updated a row whose body had changed. */
  revised: boolean;
};

export type ArticleWrite = {
  feedId: bigint;
  guidHash: Uint8Array | null;
  url: string;
  urlHash: Uint8Array;
  contentHash: Uint8Array;
  normVersion: number;
  title: string;
  author: string | null;
  publishedAt: Date;
  summaryHtml: string | null;
  contentHtml: string | null;
  textLen: number | null;
};

/*
 * Postgres unique-violation, read by INDEX NAME.
 *
 * The ladder treats one of these as "a later rung matched", so WHICH index
 * refused the write is the whole of the information — and both checks require
 * the name, not just the SQLSTATE. A bare `23505` test would make any unique
 * violation look like the rung the caller happened to be expecting, which is
 * how a guid collision gets reported as a content match.
 *
 * Both the code and the name are required. Matching on the name alone would
 * fire on any error whose text happens to mention the index, which includes
 * some non-violation diagnostics.
 */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown, index: string): boolean {
  const cause = (error as { meta?: { cause?: string }; code?: string } | null) ?? {};
  const text = JSON.stringify(error ?? "");
  const isUnique = text.includes(UNIQUE_VIOLATION) || cause.code === UNIQUE_VIOLATION;
  return isUnique && text.includes(index);
}

/** True when the failure was specifically the GLOBAL url_hash constraint. */
export function isUrlCollision(error: unknown): boolean {
  return isUniqueViolation(error, "articles_url");
}

/**
 * True when the failure was the per-feed `(feed_id, guid_hash)` constraint.
 *
 * Reachable on the UNTRUSTED path, which is why it needs to exist. When a
 * feed's guids are not trusted, rung 1 does not route — but
 * `articles_guid` is still a unique index with no idea about trust, so an item
 * repeating a guid at a NEW address refuses the insert. Before this existed
 * that error fell into a `content_hash` lookup and, failing to find one, was
 * rethrown: it ABORTED THE WHOLE POLL for every feed with fewer than three
 * clean polls — which is every new feed.
 */
export function isGuidCollision(error: unknown): boolean {
  return isUniqueViolation(error, "articles_guid");
}

/**
 * RUNG 1 — insert, or merge on the publisher's own guid.
 *
 * §6.2's statement, unmodified. Three parts of it are load-bearing:
 *
 *  - `ON CONFLICT (feed_id, guid_hash) WHERE guid_hash IS NOT NULL` RESTATES
 *    the index predicate. Without it Postgres cannot infer which index to use
 *    and the statement fails at runtime, not at migration time.
 *  - `content_html = COALESCE(EXCLUDED.content_html, ...)` keeps full text a
 *    later poll did not carry. A feed that drops to summaries must not erase
 *    what extraction already fetched.
 *  - `revised_at` and `revision_count` move only when `content_hash` differs,
 *    and `read_at` IS NOT TOUCHED. An edit is not a re-publication (§6.2).
 */
export async function upsertByGuid(write: ArticleWrite): Promise<WriteOutcome> {
  const rows = await prisma.$queryRaw<{ id: bigint; was_merge: boolean; revised: boolean }[]>`
    WITH
    -- The hash BEFORE the write, which is the only thing that can tell a
    -- revision from a re-poll. The file header says why this is not read off
    -- revised_at: that column is TIMESTAMP(3) and now() is microsecond, so
    -- comparing them is near-always false.
    before AS (
      SELECT id, content_hash FROM cadence.articles
      WHERE feed_id = ${write.feedId} AND guid_hash = ${write.guidHash}
    ),
    written AS (
    INSERT INTO cadence.articles
      (feed_id, guid_hash, url, url_hash, title, author, published_at,
       summary_html, content_html, text_len, content_hash, norm_version, fetched_at)
    VALUES
      (${write.feedId}, ${write.guidHash}, ${write.url}, ${write.urlHash},
       ${write.title}, ${write.author}, ${write.publishedAt},
       ${write.summaryHtml}, ${write.contentHtml}, ${write.textLen},
       ${write.contentHash}, ${write.normVersion}, now())
    ON CONFLICT (feed_id, guid_hash) WHERE guid_hash IS NOT NULL
    DO UPDATE SET
      title        = EXCLUDED.title,
      author       = COALESCE(EXCLUDED.author, cadence.articles.author),
      summary_html = EXCLUDED.summary_html,
      content_html = COALESCE(EXCLUDED.content_html, cadence.articles.content_html),
      text_len     = COALESCE(EXCLUDED.text_len, cadence.articles.text_len),
      revised_at   = CASE WHEN cadence.articles.content_hash <> EXCLUDED.content_hash
                          THEN now() ELSE cadence.articles.revised_at END,
      revision_count = cadence.articles.revision_count
                     + (cadence.articles.content_hash <> EXCLUDED.content_hash)::int,
      content_hash = EXCLUDED.content_hash
    RETURNING id, (xmax <> 0) AS was_merge
    ),
    -- The address, recorded in the SAME round trip. article_urls is
    -- one-to-many on purpose, so this is an append, not a write (section 6.1).
    recorded AS (
      INSERT INTO cadence.article_urls (url_hash, article_id, url, first_seen_at)
      SELECT ${write.urlHash}, id, ${write.url}, now() FROM written
      ON CONFLICT (url_hash) DO NOTHING
    )
    SELECT
      w.id,
      w.was_merge,
      (w.was_merge AND b.content_hash <> ${write.contentHash}) AS revised
    FROM written w LEFT JOIN before b ON b.id = w.id
  `;
  const row = rows[0];
  return { id: row.id, inserted: !row.was_merge, revised: row.was_merge && row.revised };
}

/**
 * RUNG 2 — insert, or merge on the canonical URL, GLOBALLY.
 *
 * The same statement with the other conflict target. `url_hash` is unique
 * across every feed, which is what collapses one wire story arriving through
 * six feeds into one row (§6.1) — and it is why this cannot be scoped to the
 * feed without losing the whole point.
 */
export async function upsertByUrl(write: ArticleWrite): Promise<WriteOutcome> {
  const rows = await prisma.$queryRaw<{ id: bigint; was_merge: boolean; revised: boolean }[]>`
    WITH
    before AS (
      SELECT id, content_hash FROM cadence.articles WHERE url_hash = ${write.urlHash}
    ),
    written AS (
    INSERT INTO cadence.articles
      (feed_id, guid_hash, url, url_hash, title, author, published_at,
       summary_html, content_html, text_len, content_hash, norm_version, fetched_at)
    VALUES
      (${write.feedId}, ${write.guidHash}, ${write.url}, ${write.urlHash},
       ${write.title}, ${write.author}, ${write.publishedAt},
       ${write.summaryHtml}, ${write.contentHtml}, ${write.textLen},
       ${write.contentHash}, ${write.normVersion}, now())
    ON CONFLICT (url_hash)
    DO UPDATE SET
      title        = EXCLUDED.title,
      author       = COALESCE(EXCLUDED.author, cadence.articles.author),
      summary_html = EXCLUDED.summary_html,
      content_html = COALESCE(EXCLUDED.content_html, cadence.articles.content_html),
      text_len     = COALESCE(EXCLUDED.text_len, cadence.articles.text_len),
      revised_at   = CASE WHEN cadence.articles.content_hash <> EXCLUDED.content_hash
                          THEN now() ELSE cadence.articles.revised_at END,
      revision_count = cadence.articles.revision_count
                     + (cadence.articles.content_hash <> EXCLUDED.content_hash)::int,
      content_hash = EXCLUDED.content_hash
    RETURNING id, (xmax <> 0) AS was_merge
    ),
    recorded AS (
      INSERT INTO cadence.article_urls (url_hash, article_id, url, first_seen_at)
      SELECT ${write.urlHash}, id, ${write.url}, now() FROM written
      ON CONFLICT (url_hash) DO NOTHING
    )
    SELECT
      w.id,
      w.was_merge,
      (w.was_merge AND b.content_hash <> ${write.contentHash}) AS revised
    FROM written w LEFT JOIN before b ON b.id = w.id
  `;
  const row = rows[0];
  return { id: row.id, inserted: !row.was_merge, revised: row.was_merge && row.revised };
}

/**
 * RUNG 2's PRE-CHECK: does this URL already resolve to an article?
 *
 * A lookup, deliberately, and only used where §6.1 calls for it — a feed with
 * fewer than three clean polls, whose guids have not yet proved stable. The
 * ordering trap is that rung 1 passes CLEANLY for churning guids (they
 * genuinely are new), inserting N duplicates that rung 2 would have caught.
 *
 * Looks in `article_urls`, not `articles`, so an address the article has
 * MOVED AWAY FROM still resolves (§6.1).
 */
export async function findByUrlHash(urlHash: Uint8Array): Promise<bigint | null> {
  const rows = await prisma.$queryRaw<{ article_id: bigint }[]>`
    SELECT article_id FROM cadence.article_urls WHERE url_hash = ${urlHash} LIMIT 1
  `;
  return rows[0]?.article_id ?? null;
}

/**
 * The same pre-check for a whole poll, in ONE query.
 *
 * §4 step 8 asks for one batched write per feed, and the reason is round trips:
 * a 40-item poll doing a lookup per item is 40 network waits before any work
 * happens. Against a remote Postgres that is the difference between a poll
 * taking a second and taking half a minute, and §6.4's budget is 240s for
 * TWENTY-FIVE feeds.
 */
export async function findManyByUrlHash(urlHashes: Uint8Array[]): Promise<Map<string, bigint>> {
  if (urlHashes.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ url_hash: Uint8Array; article_id: bigint }[]>`
    SELECT url_hash, article_id FROM cadence.article_urls
    WHERE url_hash = ANY(${urlHashes}::bytea[])
  `;
  return new Map(rows.map((r) => [Buffer.from(r.url_hash).toString("hex"), r.article_id]));
}

/**
 * RUNG 1's lookup for one item: this feed's claim on this guid.
 *
 * Needed as well as the batched version, and that was a real bug: without it
 * the single-item path did NO rung-1 lookup and relied on the upsert's
 * `ON CONFLICT` to report a guid match. But the upsert runs LAST, after rung
 * 3 — so a moved article whose body had not changed was resolved by CONTENT,
 * and `fetch_log` recorded a guid match as a content match. Worse, two
 * articles may legitimately share a title and opening text (which is why
 * `content_hash` is deliberately not unique), so rung 3 could merge into the
 * wrong row ahead of the publisher's own explicit claim.
 *
 * Scoped to the feed, because the index is `(feed_id, guid_hash)`: two
 * publishers choosing the same string stay separate.
 */
export async function findByGuidHash(feedId: bigint, guidHash: Uint8Array): Promise<bigint | null> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT id FROM cadence.articles
    WHERE feed_id = ${feedId} AND guid_hash = ${guidHash}
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/**
 * Rung 1's lookup for a whole poll: this feed's guids, in ONE query.
 *
 * A lookup that ROUTES, not one that guarantees. The unique constraint is
 * still what makes the write safe under concurrency — two overlapping ticks
 * can both miss here, and the second one's `ON CONFLICT` resolves it. §6.1
 * forbids check-then-insert as the MECHANISM, not as an optimisation on top
 * of a constraint that already holds.
 */
export async function findManyByGuidHash(
  feedId: bigint,
  guidHashes: Uint8Array<ArrayBuffer>[],
): Promise<Map<string, bigint>> {
  if (guidHashes.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ guid_hash: Uint8Array; id: bigint }[]>`
    SELECT guid_hash, id FROM cadence.articles
    WHERE feed_id = ${feedId} AND guid_hash = ANY(${guidHashes}::bytea[])
  `;
  return new Map(rows.map((r) => [Buffer.from(r.guid_hash).toString("hex"), r.id]));
}

/**
 * RUNG 3 — content equality.
 *
 * A LOOKUP rather than a constraint, and that is deliberate: `content_hash`
 * carries a non-unique index because two different articles may legitimately
 * share a title and opening text, and the ladder resolves that as a match
 * rather than refusing the insert. Making it unique would reject real
 * articles (§6.1).
 *
 * Scoped to the feed. Globally, a syndicated wire story would collapse on text
 * alone, which is a clustering decision P2 makes deliberately and this rung
 * must not make by accident.
 */
export async function findByContentHash(
  feedId: bigint,
  contentHash: Uint8Array,
): Promise<bigint | null> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT id FROM cadence.articles
    WHERE feed_id = ${feedId} AND content_hash = ${contentHash}
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/**
 * Rung 3's lookup for a whole poll, scoped to the feed.
 *
 * Rung 3 has NO constraint to trip — `content_hash` carries a non-unique index
 * on purpose, because two articles may legitimately share a title and opening
 * text and the ladder resolves that as a match rather than refusing the
 * insert. So unlike rungs 1 and 2 this rung can only ever be a lookup, and it
 * has to run BEFORE the write: with a new guid and a new address the insert
 * succeeds, so there is no error for a fallback to catch.
 */
export async function findManyByContentHash(
  feedId: bigint,
  contentHashes: Uint8Array<ArrayBuffer>[],
): Promise<Map<string, bigint>> {
  if (contentHashes.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ content_hash: Uint8Array; id: bigint }[]>`
    SELECT content_hash, min(id) AS id FROM cadence.articles
    WHERE feed_id = ${feedId} AND content_hash = ANY(${contentHashes}::bytea[])
    GROUP BY content_hash
  `;
  return new Map(rows.map((r) => [Buffer.from(r.content_hash).toString("hex"), r.id]));
}

/** Applies a later-rung match to an existing row, with §6.2's revision rules. */
export async function mergeInto(id: bigint, write: ArticleWrite): Promise<WriteOutcome> {
  const rows = await prisma.$queryRaw<{ id: bigint; revised: boolean }[]>`
    WITH before AS (
      SELECT id, content_hash FROM cadence.articles WHERE id = ${id}
    ),
    updated AS (
    UPDATE cadence.articles SET
      title        = ${write.title},
      author       = COALESCE(${write.author}, author),
      summary_html = ${write.summaryHtml},
      content_html = COALESCE(${write.contentHtml}, content_html),
      text_len     = COALESCE(${write.textLen}, text_len),
      revised_at   = CASE WHEN content_hash <> ${write.contentHash}
                          THEN now() ELSE revised_at END,
      revision_count = revision_count + (content_hash <> ${write.contentHash})::int,
      content_hash = ${write.contentHash}
    WHERE id = ${id}
    RETURNING id
    )
    SELECT u.id, (b.content_hash <> ${write.contentHash}) AS revised
    FROM updated u JOIN before b ON b.id = u.id
  `;
  const row = rows[0];
  return { id: row.id, inserted: false, revised: row.revised };
}

/*
 * Recording an address against an article lives in
 * `src/lib/ingest/article-urls.ts`, not here.
 *
 * It used to be a second `INSERT ... ON CONFLICT DO NOTHING` in this file, and
 * `DO NOTHING` made a real conflict invisible: when a hash already points at a
 * DIFFERENT article, the write silently did nothing and the caller could not
 * tell that from "already recorded". That is the case M12's manual merge
 * exists for, so it has to be reportable.
 */
