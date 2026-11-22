import { createHash } from "node:crypto";

import { prisma } from "@/lib/db/client";
import type { FeedTrust } from "@/lib/ingest/dedupe";
import { canonicalUrl } from "@/lib/ingest/canonical-url";
import type { FeedStatus } from "@/lib/types";

/*
 * Claiming feeds to poll, in a way a dying process cannot corrupt.
 *
 * ARCHITECTURE §6.4, and the one sentence that explains the whole design:
 *
 *   "`FOR UPDATE SKIP LOCKED` picks the rows and `lease_until` is what survives
 *    the process dying — the lock alone is not enough, because a killed
 *    function drops its connection, the lock releases, and the next tick would
 *    re-claim a feed still in flight elsewhere."
 *
 * So there are two mechanisms doing two different jobs, and it is worth being
 * precise about which does which — an earlier comment here had it wrong, and a
 * test proved it by passing with `SKIP LOCKED` removed:
 *
 *   lease_until   does the CORRECTNESS work. It is a column, so it outlives the
 *                 process, and it is the predicate (`lease_until < now()`) that
 *                 makes a second claim of the same feed return nothing. A feed
 *                 claimed by a function that is then killed stays unavailable
 *                 for 120 seconds and is then re-claimable.
 *   SKIP LOCKED   does the THROUGHPUT work. Without it a second tick BLOCKS on
 *                 the first tick's row locks, waits for it to commit, and only
 *                 then discovers it has nothing to claim. The answer is the
 *                 same; the waiting is what kills it, because a tick has a
 *                 240-second budget and spending it blocked behind another
 *                 tick's 25 locks means a tick that does nothing. With it, the
 *                 second tick steps over the contended rows and polls other
 *                 feeds instead.
 *
 * Using only the lock means a crash frees the feed immediately — locks die with
 * the connection — and the next minute's tick polls it again while the first
 * poll may still be in flight. So the lease is not optional, and neither is
 * SKIP LOCKED if overlapping ticks are to be useful rather than merely safe.
 */

/** §6.4: 25 feeds per claim. */
export const CLAIM_BATCH = 25;

/**
 * §6.4: 120 seconds.
 *
 * Longer than any single poll can take — the fetch times out at 10 s — but
 * short enough that a killed sweep's feeds are back in the next few ticks
 * rather than stuck for an hour. The cost of re-claiming early is one
 * conditional request and zero rows, which is the whole point of the
 * conditional GET.
 */
export const LEASE_SECONDS = 120;

/**
 * The feed's recent `published_at` values, for the median-gap interval.
 *
 * Read per feed rather than joined into the claim: §6.4 takes the median over
 * 20 posts, and a 25-feed claim carrying 500 timestamps would make the one
 * round trip the claim is proud of considerably larger.
 *
 * Called on a 304 as well as a change, which is the commonest outcome there is
 * — because §6.4's widening is driven by `unchanged_polls`, so the interval
 * genuinely changes on exactly that path. One indexed query per due feed per
 * poll is the price of the widening ever taking effect.
 *
 * Ordered newest-first and limited, so it is an index scan on
 * `articles_feed_time` rather than a sort of the feed's whole history.
 */
export async function recentPublishedAts(feedId: bigint, limit = 20): Promise<Date[]> {
  const rows = await prisma.$queryRaw<{ published_at: Date }[]>`
    SELECT published_at FROM cadence.articles
    WHERE feed_id = ${feedId}
    ORDER BY published_at DESC, id DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => r.published_at);
}

/** A claimed feed: its trust state, plus everything the fetch needs. */
export type ClaimedFeed = FeedTrust & {
  feedUrl: string;
  etag: string | null;
  lastModified: string | null;
  bodyHash: Uint8Array | null;
  /** Used by M10's adaptive interval; carried now so the claim is complete. */
  fetchIntervalS: number;
  declaredTtlS: number | null;
  consecutiveFailures: number;
  unchangedPolls: number;
  /** The two timestamps the `dead` verdict reads (§6.4's 14-day silence). */
  lastSuccessAt: Date | null;
  firstFailureAt: Date | null;
};

type Row = {
  id: bigint;
  feed_url: string;
  etag: string | null;
  last_modified: string | null;
  body_hash: Uint8Array | null;
  fetch_interval_s: number;
  declared_ttl_s: number | null;
  consecutive_failures: number;
  unchanged_polls: number;
  last_success_at: Date | null;
  first_failure_at: Date | null;
  guid_unstable: boolean;
  clean_polls: number;
  guid_trust_override: "auto" | "guid" | "url";
};

/**
 * Claims up to `limit` due feeds and leases them, atomically.
 *
 * §6.4's statement, with its `RETURNING` widened to what the poll actually
 * needs. One round trip: the sub-select picks and locks the rows, the outer
 * `UPDATE` stamps the lease, and both commit together — so there is no window
 * in which a feed is picked but not leased.
 *
 * `status IN ('active','backoff')` is what the `feeds_due` partial index is
 * built on (M6), so this is an index scan however many dead feeds exist. A dead
 * feed drops out of the index entirely rather than being filtered out of a
 * scan, which is why §6.4 can say retrying forever costs nothing.
 */
export async function claimDueFeeds(
  limit: number = CLAIM_BATCH,
  /**
   * Restricts the claim to these feeds. Undefined in production.
   *
   * A testability seam, and it exists because the alternative is a flaky suite
   * rather than because the sweep wants it. The database is shared, `due` is a
   * global condition, and several suites create due feeds and claim them — so
   * run in parallel they steal each other's rows, and a test asserting "my
   * eight feeds were polled" saw one. That failure appeared only in the full
   * run, never in isolation, which is the worst kind.
   *
   * Narrowing the claim is the honest fix: each suite claims its OWN feeds and
   * asserts on them. The alternative was serialising every database suite,
   * which would have cost minutes on every run to work around a test problem.
   * Production passes nothing and gets the unrestricted query.
   */
  onlyFeedIds?: bigint[],
): Promise<ClaimedFeed[]> {
  /*
   * THE DATABASE'S CLOCK, not the function's.
   *
   * `now()` rather than a bound `Date`, for two reasons. A bound parameter
   * arrives untyped and Postgres resolved `$1 + make_interval(...)` as
   * `interval + interval`, which failed outright — but the deeper reason is
   * that every row here is created and compared with `now()`, and a sweep
   * running on a host whose clock has drifted would claim the wrong set. One
   * clock, and it is the one the rows are stamped by.
   */
  const rows = await prisma.$queryRaw<Row[]>`
    UPDATE cadence.feeds SET lease_until = now() + make_interval(secs => ${LEASE_SECONDS})
    WHERE id IN (
      SELECT id FROM cadence.feeds
      WHERE status IN ('active','backoff')
        AND next_fetch_at <= now()
        AND (lease_until IS NULL OR lease_until < now())
        AND (${onlyFeedIds === undefined} OR id = ANY(${onlyFeedIds ?? []}::bigint[]))
      ORDER BY next_fetch_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, feed_url, etag, last_modified, body_hash,
              fetch_interval_s, declared_ttl_s, consecutive_failures, unchanged_polls,
              last_success_at, first_failure_at,
              guid_unstable, clean_polls, guid_trust_override
  `;

  return rows.map((r) => ({
    id: r.id,
    feedUrl: r.feed_url,
    etag: r.etag,
    lastModified: r.last_modified,
    bodyHash: r.body_hash,
    fetchIntervalS: r.fetch_interval_s,
    declaredTtlS: r.declared_ttl_s,
    consecutiveFailures: r.consecutive_failures,
    unchangedPolls: r.unchanged_polls,
    lastSuccessAt: r.last_success_at,
    firstFailureAt: r.first_failure_at,
    guidUnstable: r.guid_unstable,
    cleanPolls: r.clean_polls,
    guidTrustOverride: r.guid_trust_override,
  }));
}

/**
 * Releases a lease and sets when the feed is next due.
 *
 * Called in a `finally`, so a poll that threw still releases — otherwise one
 * unexpected error costs that feed 120 seconds for no reason.
 *
 * `status` is optional. The sweep passes `"active"` on a success and the
 * backoff verdict on a failure; omitting it leaves the column alone, which is
 * what the budget-skip path wants.
 *
 * Writing `"active"` on success is safe only because the claim predicate is
 * `status IN ('active','backoff')`: a `not_a_feed` feed is never claimed, so
 * no successful fetch can clear that §6.3 verdict. If the claim ever widens,
 * this becomes a bug — a feed that is not a feed, answering 200, promoted back
 * to active.
 */
export async function releaseFeed(
  feedId: bigint,
  nextInSeconds: number,
  status?: FeedStatus,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE cadence.feeds
    SET lease_until = NULL,
        next_fetch_at = now() + make_interval(secs => ${Math.max(60, Math.floor(nextInSeconds))}),
        status = COALESCE(${status ?? null}::cadence.feed_status, status),
        dead_at = CASE
                    WHEN ${status ?? null}::cadence.feed_status = 'dead'
                    THEN COALESCE(dead_at, now())
                    ELSE dead_at
                  END
    WHERE id = ${feedId}
  `;
}

/**
 * Stores the interval the adaptive rule computed, for the health screen.
 *
 * `fetch_interval_s` is what "Checked every …" renders from, and nothing wrote
 * it before M10 — so the column held its default of 3600 while the real cadence
 * came from whatever `next_fetch_at` happened to say. A screen reporting an
 * interval the scheduler does not use is worse than one reporting none.
 *
 * `median_post_gap_s` is stored alongside it because it is the INPUT, and a
 * reader asking "why is this checked twice a day?" is asking about the gap.
 */
export async function storeInterval(
  feedId: bigint,
  intervalS: number,
  medianGapS: number | null,
  /**
   * The `<ttl>` the feed just declared, in seconds.
   *
   * Persisted here because nothing else ever wrote it. `parse.ts` has produced
   * it since M2 and the seed sets it for one fixture, but no poll stored it —
   * so on a real feed `declared_ttl_s` stayed NULL forever and the `<ttl>`
   * floor in `interval.ts` was dead code. A politeness request the publisher
   * took the trouble to send, silently discarded.
   */
  declaredTtlS?: number | null,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE cadence.feeds
    SET fetch_interval_s = ${Math.round(intervalS)},
        median_post_gap_s = COALESCE(${medianGapS === null ? null : Math.round(medianGapS)}, median_post_gap_s),
        -- COALESCE so a poll of a feed that dropped its <ttl> keeps the last
        -- one it declared, rather than quietly losing the floor.
        declared_ttl_s = COALESCE(${declaredTtlS ?? null}, declared_ttl_s)
    WHERE id = ${feedId}
  `;
}

/**
 * Records a successful fetch's validators, so the next poll can be conditional.
 *
 * Separate from `releaseFeed` because a 304 updates `unchanged_polls` and
 * nothing else — §6.4 is explicit that a 304 writes nothing at all, and these
 * three columns are about the FETCH rather than the articles.
 */
export async function storeValidators(
  feedId: bigint,
  v: { etag: string | null; lastModified: string | null; bodyHash: Uint8Array },
  finalUrl: string | null,
): Promise<void> {
  /*
   * `url_hash` MOVES WITH `feed_url`, and forgetting that was a real bug.
   *
   * `feeds.url_hash` is UNIQUE and is the canonical key for the feed's own
   * address — it is what makes two readers pasting different spellings of one
   * feed share a row. Rewriting `feed_url` on a permanent redirect while
   * leaving the hash behind breaks that: the row then answers to a key nobody
   * will ever compute again, so the next reader who subscribes to the NEW
   * address matches nothing and gets a SECOND feeds row for the same feed —
   * two rows, two polls, and two sets of articles racing each other through
   * rung 2.
   *
   * Computed the same way as everywhere else: `canonicalUrl` then sha256, with
   * the raw URL as the fallback for an address the canonicaliser refuses.
   */
  const nextHash =
    finalUrl === null
      ? null
      : new Uint8Array(
          createHash("sha256")
            .update(canonicalUrl(finalUrl) ?? finalUrl, "utf8")
            .digest(),
        );

  await prisma.$executeRaw`
    UPDATE cadence.feeds SET
      etag = ${v.etag},
      last_modified = ${v.lastModified},
      body_hash = ${v.bodyHash},
      -- A PERMANENT redirect, persisted: §6.4 asks for it so the publisher is
      -- not asked to serve the same redirect on every poll forever. The hash
      -- moves with it or the row becomes unfindable; see the note above.
      feed_url = COALESCE(${finalUrl}, feed_url),
      url_hash = COALESCE(${nextHash}, url_hash),
      consecutive_failures = 0,
      unchanged_polls = 0,
      last_success_at = now(),
      last_error_code = NULL,
      last_error_text = NULL,
      -- CLEARED, so first_failure_at means "the current run of failures"
      -- rather than "the first failure ever". Without this, a feed that failed
      -- once months ago and has been healthy since would, on its next single
      -- failure, measure a months-long run and be marked dead instantly --
      -- and dead is terminal. The 14-day rule in backoff.ts reads this field
      -- and is only correct if a success resets it.
      first_failure_at = NULL
    WHERE id = ${feedId}
  `;
}

/** A 304 or soft 304: a SUCCESS that changed nothing (§6.4). */
export async function recordUnchanged(feedId: bigint): Promise<void> {
  await prisma.$executeRaw`
    UPDATE cadence.feeds SET
      consecutive_failures = 0,
      unchanged_polls = unchanged_polls + 1,
      last_success_at = now(),
      last_error_code = NULL,
      last_error_text = NULL,
      -- CLEARED, so first_failure_at means "the current run of failures"
      -- rather than "the first failure ever". Without this, a feed that failed
      -- once months ago and has been healthy since would, on its next single
      -- failure, measure a months-long run and be marked dead instantly --
      -- and dead is terminal. The 14-day rule in backoff.ts reads this field
      -- and is only correct if a success resets it.
      first_failure_at = NULL
    WHERE id = ${feedId}
  `;
}

/**
 * A failed fetch. Counted, but the backoff CURVE is M10's.
 *
 * §6.4 distinguishes three outcomes and that distinction is what keeps the
 * interval honest: a 304 is a success, a 200 with changes resets both counters,
 * and a failure increments `consecutive_failures`. M9 records the fact; M10
 * turns the count into a doubling wait and a `dead` verdict.
 */
export async function recordFailure(
  feedId: bigint,
  code: string,
  detail: string | null,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE cadence.feeds SET
      consecutive_failures = consecutive_failures + 1,
      last_error_code = ${code},
      last_error_text = ${detail},
      last_error_at = now(),
      first_failure_at = COALESCE(first_failure_at, now())
    WHERE id = ${feedId}
  `;
}
