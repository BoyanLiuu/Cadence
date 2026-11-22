-- ============================================================================
-- fetch_log.guid_agreed / guid_churned: the guid-trust signal, persisted.
-- ============================================================================
--
-- §6.1's instability detector is
--
--     collapse_rate = items_merged_by_url / items_seen
--     if collapse_rate > 0.8 for 3 consecutive polls: guid_unstable = true
--
-- and that formula is only correct for a feed whose guids are ALREADY TRUSTED.
-- There, rung 1 routes, so a churned guid is precisely what falls through to
-- rung 2 and `merged_by_url` is the churn.
--
-- On an UNTRUSTED feed it inverts. Rung 1 does not route at all, so every
-- re-polled item merges at rung 2 and the rate is 1.0 for a perfectly
-- well-behaved publisher. Since every feed starts untrusted, a literal reading
-- flags EVERY NEW FEED `guid_unstable` on its third poll — permanently, because
-- §6.1 never clears the flag. That is the exact opposite of "trusted slowly",
-- and it was caught by a test asserting a well-behaved feed is not flagged.
--
-- So the detector counts guid DISAGREEMENT instead: items that matched an
-- existing article while carrying a guid that pointed at nothing, or at a
-- different row. That is a strict generalisation — for a trusted feed the two
-- measures agree, because a churned guid is exactly what rung 1 misses.
--
-- These have to be COLUMNS rather than an in-process number because the
-- detector needs three CONSECUTIVE polls, and those are three separate
-- invocations of the sweep with nothing carried between them but the database.
--
-- They also belong on the health screen next to the collapse rate: "collapsed
-- by address" and "the publisher's identifiers moved" look identical through
-- `merged_by_url` alone, and §8 asks that screen to let a reader VERIFY the
-- deduplication rather than trust it.

SET search_path TO "cadence", extensions, public;

ALTER TABLE "fetch_log"
  ADD COLUMN "guid_agreed"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "guid_churned" INTEGER NOT NULL DEFAULT 0;

-- No backfill. Rows written before this column existed have no record of guid
-- agreement, and defaulting them to 0/0 is correct rather than lossy: zero
-- judged items reads as "this poll says nothing about stability", which is
-- exactly what an unmeasured poll should say. Inventing a figure from
-- `merged_by_url` would re-introduce the bug this column exists to fix.
