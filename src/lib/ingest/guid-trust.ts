import { prisma } from "@/lib/db/client";

import type { LadderCounters } from "./dedupe";

/*
 * Learning whether a feed can be trusted about its own identifiers.
 *
 * §6.1 calls this the adversarial case, and names the ordering trap precisely:
 * a static-site generator that bakes a build timestamp into the GUID makes
 * every poll look like a full re-publication. Rung 1 passes **cleanly** —
 * these genuinely are new GUIDs — and inserts N duplicates. Rung 2 would have
 * caught them, but rung 1 ran first.
 *
 * So there are two separate questions here, and conflating them is the trap:
 *
 *   EARNING trust    does this feed's guid agree with the row we matched?
 *                    Asked of every poll, trusted or not. Three clean polls
 *                    and rung 1 starts routing.
 *   LOSING trust     is this feed collapsing by ADDRESS, poll after poll?
 *                    §6.1's `merged_by_url / items_seen > 0.8` over three
 *                    consecutive polls. Once set, rung 1 is skipped forever.
 *
 * They need different measures, and that is not a stylistic choice — see
 * `judgePoll` below.
 */

/** §6.1's threshold for DEMOTION. Above this, three polls running, is churn. */
const CHURN_THRESHOLD = 0.8;

/**
 * The bar for EARNING trust, which is deliberately not the same number.
 *
 * With one threshold for both there is no hysteresis, and the gap is where a
 * bad feed lives: a publisher churning 79% of its identifiers every poll scores
 * clean, earns rung 1, is never flagged, and the health screen tells the reader
 * "its ids have held still, so they are trusted" — which is a lie about the one
 * thing that screen exists to let them verify.
 *
 * So trust is earned at 80% AGREEMENT and lost at 80% DISAGREEMENT. Between the
 * two a feed is neither: it keeps whatever state it has and matches on
 * addresses, which is the safe rung. Only a feed whose identifiers genuinely
 * hold still gets rung 1.
 */
const AGREEMENT_FOR_CLEAN = 0.8;

/**
 * The smallest poll worth judging.
 *
 * §6.1 requires `items_seen >= 5` before the collapse rate means anything, and
 * the same floor applies to earning trust. A two-item feed where both items
 * collapsed is not evidence in either direction, so such a poll neither earns
 * nor costs a feed anything — the alternative is a feed that posts rarely
 * either never earning rung 1, or earning it from a single sample.
 */
const MIN_ITEMS_TO_JUDGE = 5;

/**
 * What one poll showed about the publisher's identifiers.
 *
 * Three states, not a boolean, because they need three different effects on the
 * streak and two of them used to be collapsed into `null`:
 *
 *   clean       the identifiers held still. Counts toward the three.
 *   churned     they moved. RESETS the streak, and feeds the demotion check.
 *   unmeasured  nothing matched, or too few items. Leaves the streak ALONE —
 *               a 304, or a poll of nothing but new articles, is not a failure
 *               to keep a promise and must not cost a feed its progress.
 *
 * Collapsing `churned` and `unmeasured` into one value is what let a feed in
 * the middle band keep creeping toward trust: "three clean polls" has to mean
 * three in a row, so a poll that measured something and failed to show
 * stability breaks the streak even when it is not bad enough to demote.
 */
export type PollVerdict = "clean" | "churned" | "unmeasured";

/**
 * Did this poll show the publisher keeping its promises?
 *
 * Measured on **guid agreement**, not on the collapse rate, and that is the
 * one design decision in this file:
 *
 *   §6.1's detector divides by `items_seen` and counts rung-2 merges. That is
 *   correct for a feed already TRUSTED, because rung 1 routes, so a churned
 *   guid is precisely what falls through to rung 2. Applied to an UNTRUSTED
 *   feed it inverts — rung 1 does not route at all, so every re-polled item
 *   merges at rung 2 and the rate is 1.0 for a perfectly well-behaved
 *   publisher. A literal implementation would flag every new feed
 *   `guid_unstable` on its third poll, permanently, which is the exact
 *   opposite of "trusted slowly".
 *
 * `guidAgreed` / `guidChurned` are counted over items that MATCHED an existing
 * article and carried a guid, so the question can be asked whether or not rung
 * 1 is routing.
 *
 * A poll with nothing to judge — no matches, or fewer than five items — is
 * `null`: neither clean nor dirty. The caller leaves `clean_polls` alone.
 */
export function judgePoll(counters: LadderCounters): PollVerdict {
  if (counters.itemsSeen < MIN_ITEMS_TO_JUDGE) return "unmeasured";

  const judged = counters.guidAgreed + counters.guidChurned;
  // A poll of nothing but genuinely new articles says nothing about identifier
  // stability: there was no identity to re-find.
  if (judged === 0) return "unmeasured";

  // Earned on AGREEMENT, not on the absence of churn — see
  // `AGREEMENT_FOR_CLEAN` for why the two thresholds differ.
  if (counters.guidAgreed / judged >= AGREEMENT_FOR_CLEAN) return "clean";
  return "churned";
}

/** One poll, as the detector reads it back out of `fetch_log`. */
export type PollHistory = {
  itemsSeen: number;
  guidAgreed: number;
  guidChurned: number;
};

/**
 * Should this feed stop trusting its guids?
 *
 * §6.1's detector — three consecutive polls over the 0.8 threshold — with ONE
 * correction, and it is the same correction `judgePoll` makes.
 *
 * §6.1 writes the rate as `items_merged_by_url / items_seen`. That is right for
 * a feed already TRUSTED: rung 1 routes, so a churned guid is exactly what
 * falls through to rung 2. On an UNTRUSTED feed rung 1 does not route at all,
 * every re-polled item merges at rung 2, and the rate is 1.0 for a perfectly
 * well-behaved publisher. Since every feed starts untrusted, the literal
 * formula flags EVERY NEW FEED on its third poll — permanently, because the
 * flag is never cleared.
 *
 * That was not hypothetical: the first implementation here used `mergedByUrl`
 * and the test asserting "a well-behaved feed is never flagged" caught it on
 * poll four.
 *
 * `guidChurned / (guidAgreed + guidChurned)` asks the question that actually
 * matters — did the publisher's identifier point at the row we matched? — and
 * for a trusted feed the two measures agree, because a churned guid is
 * precisely what rung 1 misses.
 *
 * Flipping the flag only stops FUTURE duplicates, which is why the rung-2
 * pre-check exists as well: by the time three polls have proved a feed lies, it
 * has already inserted the duplicates those polls were made of.
 *
 * "CONSECUTIVE" MEANS THREE CONSECUTIVE *MEASURED* POLLS, and that is the
 * second correction. Most polls measure nothing: §6.4's conditional GET makes a
 * `304` the common case, and `recordPoll` writes a row for every attempt
 * including 304s, timeouts and parse failures, all with `items_seen = 0`.
 * Taking the last three ROWS therefore meant one 304 between two rebuilds reset
 * the streak — so the static-site generator §6.1 is written about, which is
 * polled far more often than it rebuilds, would never be flagged at all.
 *
 * Unmeasured polls are SKIPPED rather than counted either way. A measured poll
 * that is merely not churning still breaks the streak, because it is evidence
 * the identifiers held still.
 */
export function shouldFlagGuidUnstable(recent: PollHistory[]): boolean {
  const measured = recent.filter(
    (p) => p.itemsSeen >= MIN_ITEMS_TO_JUDGE && p.guidAgreed + p.guidChurned > 0,
  );
  const polls = measured.slice(0, 3);
  if (polls.length < 3) return false;
  return polls.every((p) => p.guidChurned / (p.guidAgreed + p.guidChurned) > CHURN_THRESHOLD);
}

/** What `recordTrust` decided, so a caller can log or assert it. */
export type TrustOutcome = {
  verdict: PollVerdict;
  cleanPolls: number;
  /** True when THIS call flipped the flag. */
  flagged: boolean;
};

/** How many clean polls a feed needs before rung 1 routes (§6.1). */
export const CLEAN_POLLS_FOR_TRUST = 3;

/**
 * Persists what this poll taught us about the feed's guids.
 *
 * Called once per poll, after `ingestItems`. Three effects, in this order:
 *
 *  1. A clean poll increments `clean_polls`; a dirty one RESETS it to zero.
 *     Resetting rather than decrementing is deliberate — "three clean polls"
 *     should mean three in a row, not three more than the dirty ones. A feed
 *     that alternates is not a feed whose identifiers hold still.
 *  2. `clean_polls` is capped at the threshold. It is a gate, not a score, and
 *     letting it climb into the thousands would mean a feed that starts lying
 *     after a year takes a year of dirty polls to fall back below it.
 *  3. The three most recent polls decide `guid_unstable`, which is written
 *     ONCE and never cleared — §6.1 is explicit that it is permanent for the
 *     feed. `guid_unstable_since` records when, so the health screen can say.
 *
 * `fetch_log` is read for the flag rather than kept in memory because the three
 * polls span three separate invocations of the sweep; nothing is carried
 * between them but the database.
 */
export async function recordTrust(feedId: bigint, counters: LadderCounters): Promise<TrustOutcome> {
  const verdict = judgePoll(counters);

  const rows = await prisma.$queryRaw<{ clean_polls: number; guid_unstable: boolean }[]>`
    UPDATE cadence.feeds SET clean_polls =
      CASE
        WHEN ${verdict === "unmeasured"} THEN clean_polls
        WHEN ${verdict === "clean"} THEN least(clean_polls + 1, ${CLEAN_POLLS_FOR_TRUST})
        ELSE 0
      END
    WHERE id = ${feedId}
    RETURNING clean_polls, guid_unstable
  `;
  const cleanPolls = rows[0]?.clean_polls ?? 0;
  const alreadyUnstable = rows[0]?.guid_unstable ?? false;

  /*
   * The last three MEASURED polls, newest first — including the one just
   * recorded, which is why `recordPoll` runs before this.
   *
   * The filter is pushed into SQL rather than applied to three fetched rows.
   * `recordPoll` writes a row for every attempt, and most attempts measure
   * nothing: §6.4's conditional GET makes a `304` the common case, and
   * timeouts and parse failures also land here with `items_seen = 0`. Taking
   * the last three ROWS meant a single 304 between two rebuilds broke the
   * streak, so the feed §6.1 is written about would never be flagged.
   *
   * Still an index scan on `(feed_id, at DESC)` with a `LIMIT 3`, so the cost
   * does not grow with the feed's history.
   */
  if (alreadyUnstable) return { verdict, cleanPolls, flagged: false };

  const history = await prisma.$queryRaw<
    { items_seen: number; guid_agreed: number; guid_churned: number }[]
  >`
    SELECT items_seen, guid_agreed, guid_churned FROM cadence.fetch_log
    WHERE feed_id = ${feedId}
      AND items_seen >= ${MIN_ITEMS_TO_JUDGE}
      AND guid_agreed + guid_churned > 0
    ORDER BY at DESC, id DESC
    LIMIT 3
  `;
  const flag = shouldFlagGuidUnstable(
    history.map((h) => ({
      itemsSeen: h.items_seen,
      guidAgreed: h.guid_agreed,
      guidChurned: h.guid_churned,
    })),
  );
  if (!flag) return { verdict, cleanPolls, flagged: false };

  /*
   * Demoted. `clean_polls` goes to zero as well, so the feed reads as untrusted
   * by both mechanisms rather than carrying a stale score that contradicts the
   * flag on the health screen.
   *
   * `WHERE NOT guid_unstable` keeps `guid_unstable_since` honest under two
   * overlapping ticks: the first writes the timestamp, the second does nothing
   * rather than moving it forward.
   */
  await prisma.$executeRaw`
    UPDATE cadence.feeds
    SET guid_unstable = true, guid_unstable_since = now(), clean_polls = 0
    WHERE id = ${feedId} AND NOT guid_unstable
  `;
  return { verdict, cleanPolls: 0, flagged: true };
}
