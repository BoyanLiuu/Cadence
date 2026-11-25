-- ============================================================================
-- articles.extracted_html / extract_final_url: on-open full text (§6.5, M13).
-- ============================================================================
--
-- `extract_status` has existed since the first migration, with no column to
-- put an extraction IN. Appendix D named the status and not the result, which
-- works for as long as nothing extracts.
--
-- EXTRACTED HTML IS ITS OWN COLUMN, not an overwrite of `content_html`, and
-- the reasons are all load-bearing:
--
--   `thin` FALLS BACK TO WHAT THE FEED SENT. §6.5's copy is "the publisher
--   likely gates the full text. This is what the feed sent." — which requires
--   still having what the feed sent. Overwriting would delete the thing the
--   degraded state displays.
--
--   `content_hash` IS COMPUTED FROM `content_html`. Rung 3 and the revision
--   check both read it, so replacing the feed's body with a page we fetched
--   makes the next poll see a different body and call it an edit (§6.2: an
--   edit must not re-notify). The seed hit exactly this through a hash
--   computed from a different normalisation, and it was invisible until the
--   following poll.
--
--   PROVENANCE. "This is what the feed sent" and "this is what we read off the
--   page" are different claims, and a reader is entitled to know which one is
--   on screen.
--
-- NULLABLE with no default: an article nobody has opened has no extraction,
-- and that is the overwhelming majority of rows forever. `extract_status`
-- already defaults to `none`, so absence is already expressible — these
-- columns are the payload, not the signal.
--
-- `extract_final_url` CLOSES THE SHORTENER GAP (§6.1). Ingestion deliberately
-- never follows a redirect to canonicalise — one HTTP request per item would
-- turn a 40-item poll into 40 requests against a publisher we are trying to be
-- polite to. So a `t.co` link is stored as itself. The first extraction learns
-- where it actually goes, and appending that to `article_urls` is what makes a
-- later feed carrying the real address resolve to this row instead of
-- inserting a second one. Recorded HERE as well as in `article_urls` because
-- the append can fail independently: the hash may already belong to another
-- article, which is a conflict to leave alone rather than steal.

ALTER TABLE "cadence"."articles"
  ADD COLUMN "extracted_html" TEXT,
  ADD COLUMN "extract_final_url" TEXT,
  -- `TIMESTAMP(3)`, matching every other timestamp in this schema. Prisma maps
  -- a plain `DateTime?` to that, so `timestamptz` here — however defensible on
  -- its own — shows up as schema drift on the next `prisma migrate dev` and
  -- would be "fixed" by a generated migration nobody reviewed.
  ADD COLUMN "extracted_at" TIMESTAMP(3);

-- `extracted_at` is what makes "once per article, cached forever" auditable.
-- `extract_status != 'none'` already answers "has this been tried", but not
-- "when", and without that a re-extraction policy can never be added without
-- guessing. It is also the only evidence available if this ever turns out to
-- be fetching more than it should.

COMMENT ON COLUMN "cadence"."articles"."extracted_html" IS
  'Sanitised article body read off the page (§6.5). Separate from content_html, which is what the feed sent and what content_hash is computed from.';

COMMENT ON COLUMN "cadence"."articles"."extract_final_url" IS
  'Where the extraction fetch actually landed. Appended to article_urls to close the shortener gap (§6.1).';
