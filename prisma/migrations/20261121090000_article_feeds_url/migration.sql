-- ============================================================================
-- article_feeds.url: the address THIS feed delivered.
-- ============================================================================
--
-- §8 asks the "also in 2 feeds" panel to show "each arrival, the discarded URL
-- parts struck through, and the resulting address key", and lists it among the
-- three copy rules that carry the product's credibility: a collapsed article
-- must say what it collapsed against so the reader can VERIFY the
-- deduplication rather than trust it.
--
-- Striking through the discarded parts needs the RAW address each feed
-- published, which is exactly what canonicalisation throws away. One outlet
-- sends `?utm_source=a`, another `?utm_source=b&fbclid=zz`; both collapse to
-- one `url_hash`, so `article_urls` (keyed on the hash) can only keep one of
-- them, and `articles.url` keeps whichever arrived last. Neither can answer
-- "what did feed B actually send?".
--
-- An arrival is `(article, feed)`, and the address belongs to the arrival.
--
-- NULLABLE, because the backfill in the previous migration created arrivals
-- for every pre-existing article without one. Those are filled from
-- `articles.url` below, which is the correct answer for a single-arrival
-- article: it IS the address that feed delivered.

SET search_path TO "cadence", extensions, public;

ALTER TABLE "article_feeds" ADD COLUMN "url" TEXT;

-- The feed that owns an article delivered the address stored on it. For every
-- article with exactly one arrival that is exact, and an article with two
-- arrivals cannot exist yet — this migration lands with the table.
UPDATE "article_feeds" af
SET "url" = a."url"
FROM "articles" a
WHERE a."id" = af."article_id" AND af."url" IS NULL;
