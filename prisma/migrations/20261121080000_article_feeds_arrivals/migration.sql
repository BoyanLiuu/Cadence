-- ============================================================================
-- article_feeds: which feeds have DELIVERED an article. One row per arrival.
-- ============================================================================
--
-- Rung 2 is GLOBAL (§6.1), so one story arriving through six feeds collapses
-- into one `articles` row — and `articles.feed_id` can then only name the feed
-- that got there first. The other five arrivals had nowhere to be recorded,
-- which broke two things:
--
--   · §8's "also in 2 feeds" panel. §8 lists it among the three copy rules that
--     carry the product's credibility: a collapsed article must say WHAT it
--     collapsed against, with each arrival and its struck-through URL parts, so
--     the reader can verify the deduplication rather than trust it. A single
--     `feed_id` cannot say that.
--   · a feed-scoped list, which hid an article that feed carries because
--     another feed owned the row. Dedup reading as an article going missing is
--     exactly the failure Appendix G question 2 warns about.
--
-- Separate from `article_urls` rather than a column on it: that table is keyed
-- on `url_hash` alone because rung 2 resolves hash -> article and a second row
-- per hash makes the lookup ambiguous. Two feeds carrying the same canonical
-- address share one hash, so they would collapse there too. An arrival is
-- `(article, feed)`, which is a different key.

SET search_path TO "cadence", extensions, public;

CREATE TABLE "article_feeds" (
  "article_id"    BIGINT      NOT NULL,
  "feed_id"       BIGINT      NOT NULL,
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "article_feeds_pkey" PRIMARY KEY ("article_id", "feed_id")
);

ALTER TABLE "article_feeds"
  ADD CONSTRAINT "article_feeds_article_id_fkey"
  FOREIGN KEY ("article_id") REFERENCES "articles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "article_feeds"
  ADD CONSTRAINT "article_feeds_feed_id_fkey"
  FOREIGN KEY ("feed_id") REFERENCES "feeds"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The feed-scoped list's index, keyset-ordered on the id.
--
-- `(feed_id, article_id DESC)` rather than a bare `(feed_id)`: the list pages
-- on `(published_at, id)` and joins arrivals to articles, so the id needs to
-- come out of this index in a usable order rather than being fetched and
-- sorted. Never OFFSET (N6).
CREATE INDEX "article_feeds_list" ON "article_feeds" ("feed_id", "article_id" DESC);

-- Backfill: every article that already exists arrived through its owning feed.
--
-- Without this an existing row is invisible to a feed-scoped list the moment
-- that list starts reading arrivals, which would turn a migration meant to
-- stop articles going missing into the thing that makes them go missing.
INSERT INTO "article_feeds" ("article_id", "feed_id", "first_seen_at")
SELECT "id", "feed_id", "fetched_at" FROM "articles"
ON CONFLICT DO NOTHING;

-- RLS on, policy-less, as defence in depth — same reasoning as the init
-- migration. The owning role bypasses it; a leaked anon key reads nothing.
ALTER TABLE "article_feeds" ENABLE ROW LEVEL SECURITY;
